//! The .strata scan file.
//!
//! Layout (little-endian):
//!   "STRATA01" | int32 headerLen | header JSON (UTF-8) | zero pad to 8
//!   int32 N | int32 0
//!   float64[N] size | float64[N] mtime (unix s) | int32[N] parent | uint8[N] flags | uint8[N] type
//!   int32 namesLen | names, UTF-8, NUL-separated
//!
//! Parents always come before their children; the root is node 0 with parent -1.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

pub const DIR: u8 = 1;
pub const HIDDEN: u8 = 2;
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub const SYSTEM: u8 = 4;
pub const REPARSE: u8 = 8;
pub const DENIED: u8 = 16;
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub const CLOUD: u8 = 32;

/// Columnar node storage, in the order nodes are written.
#[derive(Default, Clone)]
pub struct Nodes {
    pub size: Vec<f64>,
    pub mtime: Vec<f64>,
    pub parent: Vec<i32>,
    pub flags: Vec<u8>,
    pub kind: Vec<u8>,
    pub names: Vec<String>,
}

impl Nodes {
    pub fn with_capacity(n: usize) -> Self {
        Nodes {
            size: Vec::with_capacity(n),
            mtime: Vec::with_capacity(n),
            parent: Vec::with_capacity(n),
            flags: Vec::with_capacity(n),
            kind: Vec::with_capacity(n),
            names: Vec::with_capacity(n),
        }
    }

    pub fn len(&self) -> usize {
        self.parent.len()
    }

    pub fn push(&mut self, parent: i32, name: String, size: u64, mtime: f64, flags: u8, kind: u8) -> usize {
        self.size.push(size as f64);
        self.mtime.push(mtime);
        self.parent.push(parent);
        self.flags.push(flags);
        self.kind.push(kind);
        self.names.push(name);
        self.parent.len() - 1
    }

    /// Files, folders (without the root) and bytes.
    pub fn totals(&self) -> (u64, u64, u64) {
        let (mut files, mut dirs, mut bytes) = (0u64, 0u64, 0u64);
        for i in 0..self.len() {
            if self.flags[i] & DIR != 0 {
                dirs += 1;
            } else {
                files += 1;
                bytes += self.size[i] as u64;
            }
        }
        (files, dirs.saturating_sub(1), bytes)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ScanOptionsHeader {
    pub mft: bool,
    pub hidden: bool,
    pub links: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub version: u32,
    pub root: String,
    pub fs: String,
    pub cluster: u64,
    pub total: u64,
    pub free: u64,
    pub method: String,
    pub scanned_at: f64,
    pub duration: f64,
    pub partial: bool,
    pub files: u64,
    pub dirs: u64,
    pub errors: u64,
    pub bytes: u64,
    pub options: ScanOptionsHeader,
}

/// Writes to `<path>.part` first, then renames, so a reader never sees half a file.
pub fn write(path: &Path, nodes: &Nodes, header: &Header) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = std::path::PathBuf::from(tmp);
    {
        let mut w = BufWriter::with_capacity(1 << 20, File::create(&tmp)?);
        write_to(&mut w, nodes, header)?;
        w.flush()?;
    }
    std::fs::rename(&tmp, path)
}

pub fn write_to<W: Write>(w: &mut W, nodes: &Nodes, header: &Header) -> io::Result<()> {
    let n = nodes.len();
    let h = serde_json::to_vec(header)?;
    w.write_all(b"STRATA01")?;
    w.write_all(&(h.len() as i32).to_le_bytes())?;
    w.write_all(&h)?;
    let pad = (8 - (12 + h.len()) % 8) % 8;
    w.write_all(&[0u8; 8][..pad])?;
    w.write_all(&(n as i32).to_le_bytes())?;
    w.write_all(&0i32.to_le_bytes())?;
    for v in &nodes.size {
        w.write_all(&v.to_le_bytes())?;
    }
    for v in &nodes.mtime {
        w.write_all(&v.to_le_bytes())?;
    }
    for v in &nodes.parent {
        w.write_all(&v.to_le_bytes())?;
    }
    w.write_all(&nodes.flags)?;
    w.write_all(&nodes.kind)?;
    let names_len: usize = nodes.names.iter().map(|s| s.len()).sum::<usize>() + n.saturating_sub(1);
    w.write_all(&(names_len as i32).to_le_bytes())?;
    for (i, name) in nodes.names.iter().enumerate() {
        if i > 0 {
            w.write_all(&[0])?;
        }
        w.write_all(name.as_bytes())?;
    }
    Ok(())
}

/// Reads a .strata file back (tests and tools).
#[allow(dead_code)]
pub fn read(bytes: &[u8]) -> io::Result<(Header, Nodes)> {
    let bad = |what: &str| io::Error::new(io::ErrorKind::InvalidData, what.to_owned());
    let i32_at = |off: usize| -> io::Result<i32> {
        bytes.get(off..off + 4).map(|b| i32::from_le_bytes(b.try_into().unwrap())).ok_or_else(|| bad("truncated"))
    };
    if bytes.get(..8) != Some(b"STRATA01") {
        return Err(bad("not a .strata file"));
    }
    let hlen = i32_at(8)? as usize;
    let header: Header = serde_json::from_slice(bytes.get(12..12 + hlen).ok_or_else(|| bad("truncated header"))?)?;
    let mut off = (12 + hlen).div_ceil(8) * 8;
    let n = i32_at(off)? as usize;
    off += 8;
    let take = |off: &mut usize, len: usize| -> io::Result<&[u8]> {
        let s = bytes.get(*off..*off + len).ok_or_else(|| bad("truncated columns"))?;
        *off += len;
        Ok(s)
    };
    let f64s = |b: &[u8]| b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect::<Vec<_>>();
    let size = f64s(take(&mut off, 8 * n)?);
    let mtime = f64s(take(&mut off, 8 * n)?);
    let parent = take(&mut off, 4 * n)?.chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap())).collect();
    let flags = take(&mut off, n)?.to_vec();
    let kind = take(&mut off, n)?.to_vec();
    let nlen = i32_at(off)? as usize;
    off += 4;
    let names_bytes = take(&mut off, nlen)?;
    if off != bytes.len() {
        return Err(bad("trailing bytes"));
    }
    let names: Vec<String> = if n == 0 {
        Vec::new()
    } else {
        names_bytes.split(|&b| b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
    };
    if names.len() != n {
        return Err(bad("name count"));
    }
    Ok((header, Nodes { size, mtime, parent, flags, kind, names }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(root: &str) -> Header {
        Header {
            version: 1,
            root: root.into(),
            fs: "NTFS".into(),
            cluster: 4096,
            total: 1000,
            free: 10,
            method: "Walk".into(),
            scanned_at: 1.7e12,
            duration: 1.5,
            partial: false,
            files: 2,
            dirs: 1,
            errors: 0,
            bytes: 30,
            options: ScanOptionsHeader { mft: false, hidden: true, links: false },
        }
    }

    #[test]
    fn round_trips_and_aligns_columns_to_8_bytes() {
        for root in ["C:\\", "/home/a", "/h\u{e9}/\u{1F600}x"] {
            let mut nodes = Nodes::default();
            nodes.push(-1, root.into(), 0, 0.0, DIR, 0);
            nodes.push(0, "sub dir".into(), 0, 12.5, DIR | HIDDEN, 0);
            nodes.push(1, "caf\u{e9}.mkv".into(), 10, 1.0e9, 0, crate::types::VIDEO);
            nodes.push(0, "".into(), 20, -1.0, CLOUD, 0);
            let mut buf = Vec::new();
            write_to(&mut buf, &nodes, &header(root)).unwrap();
            let hlen = i32::from_le_bytes(buf[8..12].try_into().unwrap()) as usize;
            assert_eq!((12 + hlen).div_ceil(8) * 8 % 8, 0);
            let (h, back) = read(&buf).unwrap();
            assert_eq!(h, header(root));
            assert_eq!(back.names, nodes.names);
            assert_eq!(back.size, nodes.size);
            assert_eq!(back.mtime, nodes.mtime);
            assert_eq!(back.parent, nodes.parent);
            assert_eq!(back.flags, nodes.flags);
            assert_eq!(back.kind, nodes.kind);
            assert_eq!(nodes.totals(), (2, 1, 30));
        }
    }

    #[test]
    fn header_field_order_matches_the_other_scanners() {
        let s = serde_json::to_string(&header("/")).unwrap();
        assert!(s.starts_with(
            r#"{"version":1,"root":"/","fs":"NTFS","cluster":4096,"total":1000,"free":10,"method":"Walk","scannedAt""#
        ));
        assert!(s.ends_with(r#""options":{"mft":false,"hidden":true,"links":false}}"#));
    }
}
