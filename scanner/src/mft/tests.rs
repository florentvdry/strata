//! The fast scan on real NTFS images (made by tests/make-ntfs-fixture.py with mkntfs and ntfs-3g), compared with
//! what the mounted file system showed. Runs on any OS: the reader only needs positioned reads.

use super::*;
use crate::scan::state::ScanState;
use crate::strata_file::{DIR, HIDDEN, REPARSE, SYSTEM};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::sync::OnceLock;

struct Mem(Vec<u8>);

impl ReadAt for Mem {
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        let start = usize::try_from(offset).map_err(|_| bad("offset"))?;
        let src = self
            .0
            .get(start..start + buf.len())
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "past the end"))?;
        buf.copy_from_slice(src);
        Ok(())
    }
}

#[derive(Deserialize)]
struct Expected {
    entries: Vec<Item>,
}

#[derive(Deserialize, Clone)]
struct Item {
    path: String,
    dir: bool,
    size: u64,
    attrib: u32,
    ino: u64,
    nlink: u64,
    mtime: f64,
    link: bool,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

/// A disk image and what the mounted file system showed.
type Fixture = (Vec<u8>, Vec<Item>);

/// The image (decompressed once) and what the mounted file system showed.
fn fixture(name: &str) -> &'static Fixture {
    static CACHE: OnceLock<Mutex<HashMap<String, &'static Fixture>>> = OnceLock::new();
    let mut cache = lock(CACHE.get_or_init(Default::default));
    cache.entry(name.to_owned()).or_insert_with(|| {
        // STRATA_NTFS_FIXTURES: a folder of freshly generated images (CI makes new ones with ntfs-3g).
        let dir = std::env::var_os("STRATA_NTFS_FIXTURES").map(PathBuf::from).unwrap_or_else(fixtures);
        let zst = std::fs::File::open(dir.join(format!("{name}.img.zst"))).expect("fixture image");
        let mut img = Vec::new();
        ruzstd::decoding::StreamingDecoder::new(zst).unwrap().read_to_end(&mut img).unwrap();
        let json = std::fs::read_to_string(dir.join(format!("{name}.json"))).unwrap();
        let exp: Expected = serde_json::from_str(&json).unwrap();
        Box::leak(Box::new((img, exp.entries)))
    })
}

fn options(hidden: bool) -> ScanOptions {
    ScanOptions {
        root: PathBuf::from("X:\\"),
        root_name: "X:\\".into(),
        out: PathBuf::new(),
        mft: true,
        hidden,
        links: false,
    }
}

fn run_scan(img: Vec<u8>, hidden: bool, rest: &[&str]) -> (io::Result<Nodes>, Arc<ScanState>) {
    let st = Arc::new(ScanState::new(rest.is_empty(), 0));
    let rest: Vec<String> = rest.iter().map(|s| s.to_string()).collect();
    let r = scan(Mem(img), &options(hidden), &Volume::default(), &rest, &st);
    (r, st)
}

/// path ("a/b/c", from the scanned folder) → node index.
fn by_path(n: &Nodes) -> HashMap<String, usize> {
    let mut rel = vec![String::new(); n.len()];
    let mut map = HashMap::new();
    for i in 1..n.len() {
        let p = n.parent[i] as usize;
        assert!(p < i, "parent before child");
        rel[i] = if p == 0 { n.names[i].clone() } else { format!("{}/{}", rel[p], n.names[i]) };
        map.insert(rel[i].clone(), i);
    }
    map
}

/// Checks the scan against the mounted file system's listing.
fn check(name: &str, hidden: bool) {
    let (img, items) = fixture(name);
    let (nodes, st) = run_scan(img.clone(), hidden, &[]);
    let nodes = nodes.unwrap();
    let got = by_path(&nodes);
    let invisible = |i: &Item| i.attrib & (0x2 | 0x4) != 0;
    // Items under a hidden folder are left out with it.
    let hidden_dirs: Vec<&str> = items.iter().filter(|i| i.dir && invisible(i)).map(|i| i.path.as_str()).collect();
    let shown =
        |i: &Item| hidden || (!invisible(i) && !hidden_dirs.iter().any(|d| i.path.starts_with(&format!("{d}/"))));

    let mut groups: HashMap<u64, Vec<&Item>> = HashMap::new();
    let mut expected_paths = HashSet::new();
    for i in items.iter().filter(|i| shown(i)) {
        if !i.dir && i.nlink > 1 {
            groups.entry(i.ino).or_default().push(i);
            continue;
        }
        expected_paths.insert(i.path.clone());
        let k = *got.get(&i.path).unwrap_or_else(|| panic!("{name}: missing {}", i.path));
        assert_eq!(nodes.flags[k] & DIR != 0, i.dir, "{name}: {} folder flag", i.path);
        assert_eq!(nodes.flags[k] & HIDDEN != 0, i.attrib & 0x2 != 0, "{name}: {} hidden flag", i.path);
        assert_eq!(nodes.flags[k] & SYSTEM != 0, i.attrib & 0x4 != 0, "{name}: {} system flag", i.path);
        assert_eq!(nodes.flags[k] & REPARSE != 0, i.attrib & 0x400 != 0, "{name}: {} reparse flag", i.path);
        if !i.dir && !i.link {
            assert_eq!(nodes.size[k] as u64, i.size, "{name}: {} size", i.path);
            assert!(
                (nodes.mtime[k] - i.mtime).abs() < 1.0,
                "{name}: {} mtime {} vs {}",
                i.path,
                nodes.mtime[k],
                i.mtime
            );
            assert_eq!(nodes.kind[k], crate::types::classify(&i.path), "{name}: {} type", i.path);
        }
    }
    // A hard-linked file shows up once, under one of its names.
    for (ino, links) in &groups {
        let present: Vec<&&Item> = links.iter().filter(|i| got.contains_key(&i.path)).collect();
        assert_eq!(present.len(), 1, "{name}: record {ino} should appear once, found {}", present.len());
        expected_paths.insert(present[0].path.clone());
        assert_eq!(nodes.size[got[&present[0].path]] as u64, present[0].size);
    }
    // Nothing else, except NTFS's own metafiles ($MFT, $Extend…), which are hidden + system.
    for (p, &k) in &got {
        if !expected_paths.contains(p) {
            assert!(
                hidden && (p.starts_with('$') || nodes.flags[k] & (HIDDEN | SYSTEM) != 0),
                "{name}: unexpected {p}"
            );
        }
    }
    if hidden {
        assert!(got.contains_key("$MFT") && got.contains_key("$Extend"), "metafiles with hidden on");
    }
    // Counters match the result, and the live map ended with every top-level item done.
    let (files, dirs, bytes) = nodes.totals();
    assert_eq!(st.files.load(std::sync::atomic::Ordering::Relaxed), files);
    assert_eq!(st.dirs.load(std::sync::atomic::Ordering::Relaxed), dirs);
    assert_eq!(st.bytes.load(std::sync::atomic::Ordering::Relaxed), bytes);
    assert!(lock(&st.tops).items.iter().all(|t| t.state == DONE));
}

#[test]
fn basic_image_matches_the_mounted_file_system() {
    check("basic", false);
    check("basic", true);
}

#[test]
fn fragmented_mft_with_small_clusters() {
    let (img, _) = fixture("fragmented");
    let layout = read_layout(&Mem(img.clone())).unwrap();
    assert_eq!(layout.boot.cluster_size, 512);
    assert!(layout.runs.len() > 1, "the MFT is in several pieces ({} runs)", layout.runs.len());
    check("fragmented", false);
    check("fragmented", true);
}

#[test]
fn layout_of_the_basic_image() {
    let (img, _) = fixture("basic");
    let layout = read_layout(&Mem(img.clone())).unwrap();
    assert_eq!(layout.boot.volume_size, img.len() as u64 - 512);
    assert_eq!(layout.boot.cluster_size, 4096);
    assert_eq!(layout.boot.record_size, 1024);
    let (_, items) = fixture("basic");
    let records: HashSet<u64> = items.iter().map(|i| i.ino).collect();
    assert!(layout.records as usize >= records.len());
}

#[test]
fn scans_a_folder_inside_the_volume() {
    let (img, items) = fixture("basic");
    let (nodes, _) = run_scan(img.clone(), false, &["DOCS"]);
    let nodes = nodes.unwrap();
    let got = by_path(&nodes);
    let want: HashSet<&str> = items.iter().filter_map(|i| i.path.strip_prefix("docs/")).collect();
    assert_eq!(got.keys().map(String::as_str).collect::<HashSet<_>>(), want);
    let (missing, _) = run_scan(img.clone(), false, &["nope"]);
    assert!(missing.is_err());
}

#[test]
fn live_progress_lists_top_level_items_and_big_files() {
    let (img, _) = fixture("basic");
    let (nodes, st) = run_scan(img.clone(), false, &[]);
    nodes.unwrap();
    let msg = st.progress_message();
    let tops: Vec<&str> = msg["tops"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for t in ["docs", "video", "many", "sparse.vhd"] {
        assert!(tops.contains(&t), "top-level item {t} in {tops:?}");
    }
    assert!(!tops.contains(&"$MFT"), "metafiles are hidden");
    // sparse.vhd (20 MB) is under the 64 MB threshold: nothing in "biggest".
    assert!(msg["biggest"].as_array().unwrap().is_empty());
    let video = msg["tops"].as_array().unwrap().iter().find(|t| t["name"] == "video").unwrap();
    assert_eq!(video["bytes"], 3_000_000);
    assert_eq!(video["type"], crate::types::VIDEO);
}

#[test]
fn stop_ends_with_a_partial_tree() {
    let (img, _) = fixture("basic");
    let st = Arc::new(ScanState::new(true, 0));
    st.request_stop();
    let nodes = scan(Mem(img.clone()), &options(false), &Volume::default(), &[], &st).unwrap();
    assert!(nodes.len() <= 1, "nothing read after stop");
}

#[test]
fn not_ntfs_is_an_error() {
    assert!(read_layout(&Mem(vec![0u8; 1 << 20])).is_err());
    assert!(read_layout(&Mem(vec![0u8; 100])).is_err());
}

/// Damaged records and structures must give an error (the scanner then falls back to a folder walk) or a smaller
/// tree, never a crash or a hang.
#[test]
fn survives_corruption() {
    let (img, _) = fixture("basic");
    let layout = read_layout(&Mem(img.clone())).unwrap();
    let cs = layout.boot.cluster_size;
    let mft: Vec<(u64, u64)> =
        layout.runs.iter().filter_map(|r| r.lcn.map(|l| (l as u64 * cs, r.clusters * cs))).collect();
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for round in 0..60 {
        let mut bad = img.clone();
        let flips = 1 + (rnd() % 400) as usize;
        for _ in 0..flips {
            // Mostly inside the MFT; sometimes the boot sector.
            let pos = if rnd() % 50 == 0 {
                (rnd() % 512) as usize
            } else {
                let (start, len) = mft[(rnd() % mft.len() as u64) as usize];
                // The first records ($MFT itself) half the time, anywhere in the table otherwise.
                let span = if rnd() % 2 == 0 { len.min(16 * 1024) } else { len };
                (start + rnd() % span) as usize
            };
            bad[pos] = match rnd() % 4 {
                0 => 0,
                1 => 0xFF,
                _ => rnd() as u8,
            };
        }
        let (r, _) = run_scan(bad, round % 2 == 0, &[]);
        if let Ok(nodes) = r {
            for i in 1..nodes.len() {
                assert!((nodes.parent[i] as usize) < i);
            }
        }
    }
}
