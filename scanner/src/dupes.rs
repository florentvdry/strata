//! `dupes <list>`: among same-size candidates ("size<TAB>path" lines, grouped by size), finds byte-identical groups.
//!
//! First a hash of three 64 KB samples (start, middle, end), then a full hash for files up to 1 GB. Bigger files
//! are grouped on samples only and reported as not verified. Biggest potential savings first; stops after 4 minutes.

use crate::protocol::{done, out};
use md5::{Digest, Md5};
use serde_json::json;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::{Duration, Instant};

const SAMPLE: u64 = 64 * 1024;
const FULL_HASH_LIMIT: u64 = 1 << 30;
const TIME_LIMIT: Duration = Duration::from_secs(240);

type Key = [u8; 16];

/// Groups items by key, keeping the order in which keys were first seen.
struct Buckets {
    index: HashMap<Key, usize>,
    groups: Vec<Vec<String>>,
}

impl Buckets {
    fn new() -> Self {
        Buckets { index: HashMap::new(), groups: Vec::new() }
    }

    fn add(&mut self, key: Key, path: &str) {
        let i = *self.index.entry(key).or_insert_with(|| {
            self.groups.push(Vec::new());
            self.groups.len() - 1
        });
        self.groups[i].push(path.to_owned());
    }
}

fn read_full(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            r => n += r,
        }
    }
    Ok(n)
}

fn sample_hash(path: &str, size: u64) -> Option<Key> {
    let mut f = File::open(path).ok()?;
    let mut h = Md5::new();
    let mut buf = vec![0u8; SAMPLE as usize];
    let n = read_full(&mut f, &mut buf).ok()?;
    h.update(&buf[..n]);
    if size > SAMPLE * 2 {
        for pos in [size / 2, size - SAMPLE] {
            f.seek(SeekFrom::Start(pos)).ok()?;
            let n = read_full(&mut f, &mut buf).ok()?;
            h.update(&buf[..n]);
        }
    }
    Some(h.finalize().into())
}

fn full_hash(path: &str) -> Option<Key> {
    let mut f = File::open(path).ok()?;
    let mut h = Md5::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => h.update(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
    Some(h.finalize().into())
}

pub fn parse_list(text: &str) -> Vec<(u64, Vec<String>)> {
    let mut groups: Vec<(u64, Vec<String>)> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(tab) = line.find('\t') else { continue };
        if tab == 0 {
            continue;
        }
        let Ok(size) = line[..tab].trim().parse::<u64>() else {
            continue;
        };
        let path = &line[tab + 1..];
        match groups.last_mut() {
            Some((s, paths)) if *s == size => paths.push(path.to_owned()),
            _ => groups.push((size, vec![path.to_owned()])),
        }
    }
    groups
}

pub fn run(list_file: &str) -> i32 {
    let text = match std::fs::read_to_string(list_file) {
        Ok(t) => t,
        Err(e) => {
            crate::protocol::error(&e.to_string());
            return 1;
        }
    };
    let mut groups = parse_list(&text);
    // Biggest potential savings first.
    groups.sort_by(|a, b| {
        let s = |g: &(u64, Vec<String>)| g.0 as f64 * (g.1.len() as f64 - 1.0);
        s(b).total_cmp(&s(a))
    });
    let total_work: u64 = groups.iter().map(|g| g.0.min(FULL_HASH_LIMIT) * g.1.len() as u64).sum();
    let mut done_work = 0u64;
    let started = Instant::now();
    let mut last_tick: Option<Instant> = None;

    for (size, paths) in &groups {
        if started.elapsed() > TIME_LIMIT {
            break;
        }
        let mut by_sample = Buckets::new();
        for p in paths {
            if let Some(h) = sample_hash(p, *size) {
                by_sample.add(h, p);
            }
        }
        for sg in by_sample.groups.iter().filter(|g| g.len() >= 2) {
            let full = *size <= FULL_HASH_LIMIT;
            let mut by_hash = Buckets::new();
            for p in sg {
                // Big files: samples only.
                let Some(h) = (if full { full_hash(p) } else { Some([0; 16]) }) else {
                    continue;
                };
                by_hash.add(h, p);
                done_work += (*size).min(FULL_HASH_LIMIT);
                if last_tick.is_none_or(|t| t.elapsed() > Duration::from_millis(250)) {
                    last_tick = Some(Instant::now());
                    out(&json!({ "type": "progress", "done": done_work, "total": total_work }));
                }
            }
            for hg in by_hash.groups.iter().filter(|g| g.len() >= 2) {
                out(&json!({ "type": "group", "size": size, "verified": full, "paths": hg }));
            }
        }
    }
    done();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_size_groups_in_order() {
        let g = parse_list("10\t/a\n10\t/b\r\n5\t/c\tx\n\nbad\n\t/d\n10\t/e\n");
        assert_eq!(g, vec![(10, vec!["/a".into(), "/b".into()]), (5, vec!["/c\tx".into()]), (10, vec!["/e".into()])]);
    }
}
