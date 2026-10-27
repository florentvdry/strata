//! What the reader keeps per file record, and how it becomes the scan's parent-first node list.

use super::bytes::{file_ref, i64_at, u8_at, u16_at, u32_at, utf16_at};
use super::record::{DATA, FILE_NAME, STANDARD_INFORMATION, fixup, for_each_attr};
use crate::scan::state::{ACTIVE, ScanState, TopItem, lock};
use crate::strata_file::{CLOUD, DIR, HIDDEN, Nodes, REPARSE, SYSTEM};
use crate::types;
use std::collections::HashMap;
use std::io;
use std::sync::atomic::Ordering;

/// The root folder of every NTFS volume.
pub const ROOT_RECORD: usize = 5;

const ATTR_HIDDEN: u32 = 0x2;
const ATTR_SYSTEM: u32 = 0x4;
const ATTR_REPARSE: u32 = 0x400;
const ATTR_OFFLINE: u32 = 0x1000;
const ATTR_RECALL_ON_OPEN: u32 = 0x40000;
const ATTR_RECALL_ON_DATA_ACCESS: u32 = 0x400000;
const CLOUD_ATTRS: u32 = ATTR_RECALL_ON_DATA_ACCESS | ATTR_RECALL_ON_OPEN | ATTR_OFFLINE;

const IN_USE: u8 = 1;
const IS_DIR: u8 = 2;
const BASE_SEEN: u8 = 4;

// top_of values besides an index into the live top-level items.
const TOP_UNKNOWN: i32 = -2;
const TOP_EXCLUDED: i32 = -3;
const TOP_ROOT: i32 = -1;

pub struct Table {
    pub parent: Vec<i64>,
    pub names: Vec<Option<String>>,
    name_prio: Vec<u8>,
    pub sizes: Vec<u64>,
    pub mtimes: Vec<f64>,
    pub attrs: Vec<u32>,
    pub rflags: Vec<u8>,
    /// Records parsed so far.
    pub read: usize,
    hidden: bool,
    // Incremental resolution of top-level ancestors, for the live map.
    top_of: Vec<i32>,
    unresolved: Vec<usize>,
    top_index: HashMap<usize, usize>,
    pub resolved_up_to: usize,
}

fn unix_from_filetime(ft: i64) -> f64 {
    if ft <= 0 { 0.0 } else { (ft - 116_444_736_000_000_000) as f64 / 1e7 }
}

impl Table {
    pub fn new(records: usize, hidden: bool) -> Self {
        let mut top_of = vec![TOP_UNKNOWN; records];
        if records > ROOT_RECORD {
            top_of[ROOT_RECORD] = TOP_ROOT;
        }
        Table {
            parent: vec![-1; records],
            names: vec![None; records],
            name_prio: vec![0; records],
            sizes: vec![0; records],
            mtimes: vec![0.0; records],
            attrs: vec![0; records],
            rflags: vec![0; records],
            read: 0,
            hidden,
            top_of,
            unresolved: Vec::new(),
            top_index: HashMap::new(),
            resolved_up_to: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.parent.len()
    }

    /// Reads one record (already in `rec`, `record_size` long) into the table. Damaged records are skipped.
    pub fn parse_record(&mut self, rec: &mut [u8], index: usize, st: &ScanState) {
        if index >= self.len() || !fixup(rec) {
            return;
        }
        let Some(flags) = u16_at(rec, 0x16) else {
            return;
        };
        if flags & 1 == 0 {
            return; // not in use
        }
        let Some(base_ref) = file_ref(rec, 0x20) else {
            return;
        };
        let target = if base_ref != 0 { base_ref as usize } else { index };
        if target >= self.len() {
            return;
        }
        if base_ref == 0 {
            self.rflags[target] |= IN_USE | BASE_SEEN;
            if flags & 2 != 0 {
                self.rflags[target] |= IS_DIR;
            }
        }
        let rec: &[u8] = rec;
        for_each_attr(rec, |t, a| {
            let non_resident = u8_at(rec, a + 8).unwrap_or(0) != 0;
            let name_len = u8_at(rec, a + 9).unwrap_or(1);
            let value = || u16_at(rec, a + 0x14).map(|o| a + o as usize);
            match t {
                STANDARD_INFORMATION if !non_resident => {
                    if let Some(v) = value()
                        && let (Some(ft), Some(at)) = (i64_at(rec, v + 8), u32_at(rec, v + 32))
                    {
                        self.mtimes[target] = unix_from_filetime(ft);
                        self.attrs[target] = at;
                    }
                }
                FILE_NAME if !non_resident => {
                    let Some(v) = value() else { return };
                    let (Some(nlen), Some(ns)) = (u8_at(rec, v + 0x40), u8_at(rec, v + 0x41)) else {
                        return;
                    };
                    // Win32 names win over POSIX names, which win over DOS 8.3 names.
                    let prio = match ns {
                        2 => 1,
                        0 => 2,
                        _ => 3,
                    };
                    if prio > self.name_prio[target]
                        && let (Some(pref), Some(name)) = (file_ref(rec, v), utf16_at(rec, v + 0x42, nlen as usize))
                    {
                        self.name_prio[target] = prio;
                        self.parent[target] = pref as i64;
                        self.names[target] = Some(name);
                    }
                }
                DATA if name_len == 0 => {
                    if !non_resident {
                        if let Some(len) = u32_at(rec, a + 0x10) {
                            self.sizes[target] = len as u64;
                        }
                    } else if i64_at(rec, a + 0x10) == Some(0)
                        && let Some(size) = i64_at(rec, a + 0x30)
                    {
                        self.sizes[target] = size.max(0) as u64;
                    }
                }
                _ => {}
            }
        });
        if base_ref == 0 {
            if flags & 2 == 0 {
                st.files.fetch_add(1, Ordering::Relaxed);
            } else {
                st.dirs.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn excluded(&self, r: usize) -> bool {
        r != ROOT_RECORD && !self.hidden && self.attrs[r] & (ATTR_HIDDEN | ATTR_SYSTEM) != 0
    }

    fn file_size(&self, r: usize) -> u64 {
        if self.attrs[r] & CLOUD_ATTRS != 0 { 0 } else { self.sizes[r] }
    }

    fn is_dir(&self, r: usize) -> bool {
        self.rflags[r] & IS_DIR != 0
    }

    fn known(&self, r: usize) -> bool {
        self.rflags[r] & BASE_SEEN != 0 && self.names[r].is_some()
    }

    fn parent_of(&self, r: usize) -> Option<usize> {
        let p = self.parent[r];
        (p >= 0 && (p as usize) < self.len()).then_some(p as usize)
    }

    /// Path of a record from the volume root, for the live "biggest files" list.
    pub fn path_of(&self, r: usize) -> String {
        let mut parts = Vec::new();
        let mut cur = r;
        for _ in 0..256 {
            if cur == ROOT_RECORD {
                break;
            }
            let Some(name) = &self.names[cur] else { break };
            parts.push(name.as_str());
            match self.parent_of(cur) {
                Some(p) if p != cur => cur = p,
                _ => break,
            }
        }
        parts.reverse();
        parts.join("\\")
    }

    /// Attributes newly read records to their top-level folder; retries the ones whose parents weren't read yet.
    pub fn resolve_tops(&mut self, to: usize, st: &ScanState) {
        let mut retry = std::mem::take(&mut self.unresolved);
        for r in self.resolved_up_to..to.min(self.len()) {
            if self.known(r) && r != ROOT_RECORD {
                retry.push(r);
            }
        }
        let mut bytes = 0;
        for r in retry {
            let t = self.top_for(r, to, st);
            if t == TOP_UNKNOWN {
                self.unresolved.push(r);
                continue;
            }
            if t < 0 || self.is_dir(r) {
                continue;
            }
            let s = self.file_size(r);
            bytes += s;
            {
                let mut tops = lock(&st.tops);
                let top = &mut tops.items[t as usize];
                top.bytes += s;
                top.type_bytes[types::classify(self.names[r].as_deref().unwrap_or("")) as usize] += s;
            }
            st.offer_big(s, || self.path_of(r));
        }
        st.bytes.fetch_add(bytes, Ordering::Relaxed);
        // Tops are "active" while the reader goes through the table; all done at the end.
        let mut tops = lock(&st.tops);
        for t in tops.items.iter_mut() {
            if t.state == 0 {
                t.state = ACTIVE;
            }
        }
        self.resolved_up_to = to;
    }

    fn top_for(&mut self, r: usize, read_limit: usize, st: &ScanState) -> i32 {
        let mut chain = Vec::new();
        let mut cur = r;
        let result = loop {
            if cur >= self.len() {
                break TOP_EXCLUDED;
            }
            if self.top_of[cur] != TOP_UNKNOWN && cur != r {
                break self.top_of[cur];
            }
            if cur >= read_limit || !self.known(cur) {
                break TOP_UNKNOWN;
            }
            if self.excluded(cur) {
                self.top_of[cur] = TOP_EXCLUDED;
                break TOP_EXCLUDED;
            }
            let Some(p) = self.parent_of(cur) else {
                break TOP_EXCLUDED;
            };
            if p == ROOT_RECORD {
                let idx = match self.top_index.get(&cur) {
                    Some(&i) => i,
                    None => {
                        let mut tops = lock(&st.tops);
                        let i = tops.items.len();
                        let name = self.names[cur].clone().unwrap_or_default();
                        tops.items.push(TopItem::new(name, self.is_dir(cur), ACTIVE));
                        self.top_index.insert(cur, i);
                        i
                    }
                };
                self.top_of[cur] = idx as i32;
                break idx as i32;
            }
            if p == cur || chain.len() > 512 {
                break TOP_EXCLUDED;
            }
            chain.push(cur);
            cur = p;
        };
        if result != TOP_UNKNOWN {
            for c in chain {
                self.top_of[c] = result;
            }
        }
        result
    }

    /// The record of the scanned folder: the volume root, then each part of the path (case-insensitive).
    fn find_start(&self, head: &[i64], next: &[i64], rest: &[String]) -> Option<usize> {
        let mut cur = ROOT_RECORD;
        for part in rest {
            let want = part.to_lowercase();
            let mut c = head[cur];
            let mut found = None;
            while c >= 0 {
                let cu = c as usize;
                if self.names[cu].as_deref().is_some_and(|n| n == part || n.to_lowercase() == want) {
                    found = Some(cu);
                    break;
                }
                c = next[cu];
            }
            cur = found?;
        }
        Some(cur)
    }

    /// Turns the table into parent-first nodes, starting at the scanned folder.
    pub fn build(&self, root_name: &str, rest: &[String], st: &ScanState, final_build: bool) -> io::Result<Nodes> {
        let n = self.read.min(self.len());
        let mut head = vec![-1i64; self.len()];
        let mut next = vec![-1i64; self.len()];
        for r in (0..n).rev() {
            if !self.known(r) || r == ROOT_RECORD {
                continue;
            }
            let Some(p) = self.parent_of(r) else { continue };
            if p >= n || p == r {
                continue;
            }
            next[r] = head[p];
            head[p] = r as i64;
        }
        if ROOT_RECORD >= self.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "no root folder in the file table"));
        }
        let start = self
            .find_start(&head, &next, rest)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "folder not found in the file table"))?;

        let estimate = (st.files.load(Ordering::Relaxed) + st.dirs.load(Ordering::Relaxed)) as usize;
        let mut nodes = Nodes::with_capacity(estimate.clamp(16, 1 << 24));
        nodes.push(-1, root_name.to_owned(), 0, self.mtimes[start], DIR, 0);
        let mut index_of: HashMap<usize, usize> = HashMap::new();
        index_of.insert(start, 0);
        let mut stack = vec![start];
        let mut visited = vec![false; self.len()];
        visited[start] = true;
        let (mut files, mut dirs, mut bytes) = (0u64, 0u64, 0u64);
        while let Some(d) = stack.pop() {
            let di = index_of[&d];
            let mut c = head[d];
            while c >= 0 {
                let cu = c as usize;
                c = next[cu];
                if visited[cu] {
                    continue;
                }
                visited[cu] = true;
                if self.excluded(cu) {
                    continue;
                }
                let is_dir = self.is_dir(cu);
                let a = self.attrs[cu];
                let name = self.names[cu].clone().unwrap_or_default();
                let mut f = 0;
                if is_dir {
                    f |= DIR;
                }
                if a & ATTR_HIDDEN != 0 {
                    f |= HIDDEN;
                }
                if a & ATTR_SYSTEM != 0 {
                    f |= SYSTEM;
                }
                if a & ATTR_REPARSE != 0 {
                    f |= REPARSE;
                }
                let (size, kind) = if is_dir {
                    dirs += 1;
                    (0, 0)
                } else {
                    let s = self.file_size(cu);
                    if s == 0 && self.sizes[cu] > 0 {
                        f |= CLOUD;
                    }
                    files += 1;
                    bytes += s;
                    (s, types::classify(&name))
                };
                let i = nodes.push(di as i32, name, size, self.mtimes[cu], f, kind);
                if is_dir {
                    index_of.insert(cu, i);
                    stack.push(cu);
                }
            }
        }
        if final_build {
            st.files.store(files, Ordering::Relaxed);
            st.dirs.store(dirs, Ordering::Relaxed);
            st.bytes.store(bytes, Ordering::Relaxed);
        }
        Ok(nodes)
    }
}
