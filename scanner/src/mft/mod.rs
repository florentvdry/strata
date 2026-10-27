//! NTFS master file table reader: the fast scan.
//!
//! With administrator rights on Windows, the scanner opens the volume (\\.\C:) and reads the master file table
//! directly instead of listing every folder:
//!
//! 1. The boot sector gives the cluster size, the MFT position and the record size (`boot`).
//! 2. Record 0 ($MFT) gives the MFT's own data runs, including any continued through an $ATTRIBUTE_LIST (`runs`).
//! 3. All records are read sequentially in 1 MB chunks, checked and parsed (`record`, `tree`).
//! 4. Parent references are linked into a tree, walked depth-first from the scanned folder (`tree::Table::build`).
//!
//! Everything goes through `ReadAt`, so the same code reads a disk image in tests, on any OS.

mod boot;
mod bytes;
mod record;
mod runs;
mod tree;

use crate::platform::Volume;
use crate::scan::state::{DONE, ScanState, lock};
use crate::scan::{ScanOptions, header, write_snapshot};
use crate::strata_file::Nodes;
use bytes::{file_ref, i32_at, i64_at, u8_at, u16_at};
use record::{ATTRIBUTE_LIST, DATA, fixup, for_each_attr};
use runs::Run;
use std::io;
use std::sync::{Arc, Mutex};
use tree::Table;

const CHUNK: u64 = 1 << 20;

/// Positioned reads. Volume handles need sector-aligned offsets and lengths, which every read here is.
pub trait ReadAt: Send + Sync {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()>;
}

impl ReadAt for std::fs::File {
    #[cfg(unix)]
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        std::os::unix::fs::FileExt::read_exact_at(self, buf, offset)
    }

    #[cfg(windows)]
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        let mut done = 0;
        while done < buf.len() {
            match std::os::windows::fs::FileExt::seek_read(self, &mut buf[done..], offset + done as u64)? {
                0 => {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "read past the end of the volume"));
                }
                n => done += n,
            }
        }
        Ok(())
    }
}

/// Opens a volume ("C:") for raw reading. Needs administrator rights.
#[cfg(windows)]
pub fn open_volume(letter: &str) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2) // FILE_SHARE_READ | FILE_SHARE_WRITE
        .open(format!(r"\\.\{letter}"))
}

fn bad(what: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.into())
}

/// The volume's geometry and where the MFT is.
pub(crate) struct Layout {
    pub boot: boot::Boot,
    pub runs: Vec<Run>,
    pub records: u64,
}

impl Layout {
    fn read_record(&self, r: &dyn ReadAt, runs: &[Run], index: u64) -> io::Result<Vec<u8>> {
        let b = &self.boot;
        let off = index * b.record_size;
        let mut vcn_byte = 0u64;
        for run in runs {
            let len = run.clusters.saturating_mul(b.cluster_size);
            if off < vcn_byte.saturating_add(len) {
                let lcn = run.lcn.ok_or_else(|| bad("record in a sparse part of the MFT"))?;
                let disk = (lcn.max(0) as u64)
                    .checked_mul(b.cluster_size)
                    .and_then(|d| d.checked_add(off - vcn_byte))
                    .ok_or_else(|| bad("MFT extent outside the volume"))?;
                let aligned = disk - disk % b.sector_size;
                let pad = (disk - aligned) as usize;
                let count = (pad as u64 + b.record_size).div_ceil(b.sector_size) * b.sector_size;
                let mut raw = vec![0u8; count as usize];
                r.read_at(aligned, &mut raw)?;
                return Ok(raw[pad..pad + b.record_size as usize].to_vec());
            }
            vcn_byte = vcn_byte.saturating_add(len);
        }
        Err(bad("record outside known MFT extents"))
    }
}

/// Reads the boot sector and $MFT's own record to find every extent of the MFT.
pub(crate) fn read_layout(r: &dyn ReadAt) -> io::Result<Layout> {
    let mut sector = vec![0u8; 512];
    r.read_at(0, &mut sector)?;
    let boot = boot::parse(&sector)?;
    let first = (boot.record_size * 16).div_ceil(boot.cluster_size).max(1);
    let mut layout = Layout { boot, runs: vec![Run { lcn: Some(boot.mft_lcn), clusters: first }], records: 0 };

    let mut rec = layout.read_record(r, &layout.runs, 0)?;
    if !fixup(&mut rec) {
        return Err(bad("bad $MFT record"));
    }
    let mut pieces: Vec<(i64, Vec<Run>)> = Vec::new();
    let mut data_size: i64 = 0;
    let mut extra: Vec<u64> = Vec::new();
    let mut broken = false;
    for_each_attr(&rec, |t, a| {
        let non_resident = u8_at(&rec, a + 8).unwrap_or(0) != 0;
        let unnamed = u8_at(&rec, a + 9) == Some(0);
        if t == DATA && unnamed && non_resident {
            let start_vcn = i64_at(&rec, a + 0x10).unwrap_or(-1);
            if start_vcn == 0 {
                data_size = i64_at(&rec, a + 0x30).unwrap_or(0);
            }
            match runs::parse(&rec, a) {
                Some(rs) => pieces.push((start_vcn, rs)),
                None => broken = true,
            }
        } else if t == ATTRIBUTE_LIST && !non_resident {
            // Which extension records hold the rest of $DATA.
            let (Some(vo), Some(vl)) = (u16_at(&rec, a + 0x14), i32_at(&rec, a + 0x10)) else {
                return;
            };
            let mut p = a + vo as usize;
            let end = p + vl.max(0) as usize;
            while p + 26 <= end {
                let (Some(et), Some(el), Some(rr)) = (i32_at(&rec, p), u16_at(&rec, p + 4), file_ref(&rec, p + 16))
                else {
                    break;
                };
                if et == DATA && rr != 0 && !extra.contains(&rr) {
                    extra.push(rr);
                }
                if el == 0 {
                    break;
                }
                p += el as usize;
            }
        }
    });
    if broken {
        return Err(bad("bad $MFT data runs"));
    }
    // Provisional runs (from record 0) let us read the extension records.
    let provisional: Vec<Run> = pieces.iter().flat_map(|(_, rs)| rs.iter().copied()).collect();
    for x in extra {
        let Ok(mut er) = layout.read_record(r, &provisional, x) else {
            continue;
        };
        if !fixup(&mut er) {
            continue;
        }
        for_each_attr(&er, |t, a| {
            if t == DATA
                && u8_at(&er, a + 9) == Some(0)
                && u8_at(&er, a + 8).unwrap_or(0) != 0
                && let (Some(vcn), Some(rs)) = (i64_at(&er, a + 0x10), runs::parse(&er, a))
            {
                pieces.push((vcn, rs));
            }
        });
    }
    pieces.sort_by_key(|p| p.0);
    layout.runs = pieces.into_iter().flat_map(|(_, rs)| rs).collect();
    layout.records = (data_size.max(0) as u64) / layout.boot.record_size;
    if layout.records == 0 {
        return Err(bad("empty MFT"));
    }
    if layout.records > layout.boot.volume_size / layout.boot.record_size {
        return Err(bad("MFT larger than the volume"));
    }
    Ok(layout)
}

/// Reads every record, in 1 MB chunks, into the table. Stops early on "stop"; waits while paused.
pub(crate) fn read_all(r: &dyn ReadAt, layout: &Layout, table: &Mutex<Table>, st: &ScanState) -> io::Result<()> {
    let rs = layout.boot.record_size as usize;
    let cs = layout.boot.cluster_size;
    let total = layout.records.min(lock(table).len() as u64);
    let mut index = 0u64;
    let mut carry: Vec<u8> = Vec::with_capacity(rs);
    let mut last_resolve = 0u64;
    let mut buf = vec![0u8; CHUNK as usize];
    for run in &layout.runs {
        if index >= total {
            break;
        }
        let run_bytes = run.clusters.saturating_mul(cs);
        let mut done = 0u64;
        while done < run_bytes && index < total {
            st.wait_if_paused();
            if st.stopped() {
                return Ok(());
            }
            let count = CHUNK.min(run_bytes - done) as usize;
            let chunk = &mut buf[..count];
            match run.lcn {
                Some(lcn) => {
                    let at = (lcn.max(0) as u64).checked_mul(cs).and_then(|o| o.checked_add(done));
                    r.read_at(at.ok_or_else(|| bad("MFT extent outside the volume"))?, chunk)?
                }
                None => chunk.fill(0),
            }
            done += count as u64;
            let mut t = lock(table);
            let mut p = 0usize;
            if !carry.is_empty() {
                let need = rs - carry.len();
                let take = need.min(count);
                carry.extend_from_slice(&chunk[..take]);
                if carry.len() < rs {
                    continue;
                }
                t.parse_record(&mut carry, index as usize, st);
                index += 1;
                carry.clear();
                p = take;
            }
            while p + rs <= count && index < total {
                t.parse_record(&mut chunk[p..p + rs], index as usize, st);
                index += 1;
                p += rs;
            }
            if p < count && index < total {
                carry.extend_from_slice(&chunk[p..]);
            }
            t.read = index as usize;
            st.set_pct((index as f64 / total as f64).min(0.97));
            if index - last_resolve > 32768 {
                last_resolve = index;
                t.resolve_tops(index as usize, st);
            }
        }
    }
    let mut t = lock(table);
    t.read = index as usize;
    t.resolve_tops(index as usize, st);
    for top in lock(&st.tops).items.iter_mut() {
        top.state = DONE;
    }
    Ok(())
}

/// Fast scan of `rest` (path parts under the volume root) on the volume read through `r`.
pub fn scan<R: ReadAt + 'static>(
    r: R,
    o: &ScanOptions,
    vol: &Volume,
    rest: &[String],
    st: &Arc<ScanState>,
) -> io::Result<Nodes> {
    st.set_phase("mft");
    let layout = read_layout(&r)?;
    let records = usize::try_from(layout.records).unwrap_or(usize::MAX).min(i32::MAX as usize - 1);
    let table = Arc::new(Mutex::new(Table::new(records, o.hidden)));
    {
        let (table, st2, o, vol, rest) = (table.clone(), st.clone(), o.clone(), vol.clone(), rest.to_vec());
        *lock(&st.snapshot) = Some(Arc::new(move |file: &str| {
            let built = lock(&table).build(&o.root_name, &rest, &st2, false);
            match built {
                Ok(nodes) => write_snapshot(file, &nodes, &header(&o, &vol, "MFT", &st2, true, &nodes, 0)),
                Err(e) => crate::protocol::out(&serde_json::json!({ "type": "snapshot", "error": e.to_string() })),
            }
        }));
    }
    let result = read_all(&r, &layout, &table, st);
    *lock(&st.snapshot) = None;
    result?;
    st.set_phase("build");
    let nodes = lock(&table).build(&o.root_name, rest, st, true)?;
    st.set_pct(1.0);
    Ok(nodes)
}

/// Entry points for `cargo fuzz` (scanner/fuzz): arbitrary bytes must never crash the reader.
#[cfg(fuzzing)]
pub mod fuzz {
    use super::*;

    /// One file record, as if read from the MFT.
    pub fn record(data: &[u8]) {
        let st = ScanState::new(false, 0);
        let mut table = Table::new(64, true);
        for (i, chunk) in data.chunks(1024).enumerate() {
            let mut rec = chunk.to_vec();
            table.parse_record(&mut rec, i % 64, &st);
            let _ = runs::parse(chunk, 0);
        }
        table.read = 64;
        table.resolve_tops(64, &st);
        let _ = table.build("X:\\", &[], &st, true);
    }

    /// A whole volume image.
    pub fn volume(data: &[u8]) {
        struct Mem<'a>(&'a [u8]);
        impl ReadAt for Mem<'_> {
            fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
                let start = usize::try_from(offset).map_err(|_| bad("offset"))?;
                let src = self.0.get(start..start.saturating_add(buf.len())).ok_or_else(|| bad("past the end"))?;
                buf.copy_from_slice(src);
                Ok(())
            }
        }
        let st = ScanState::new(true, 0);
        if let Ok(layout) = read_layout(&Mem(data)) {
            let records = usize::try_from(layout.records).unwrap_or(0).min(1 << 16);
            let table = Mutex::new(Table::new(records, true));
            if read_all(&Mem(data), &layout, &table, &st).is_ok() {
                let _ = lock(&table).build("X:\\", &[], &st, true);
            }
        }
    }
}

#[cfg(test)]
mod tests;
