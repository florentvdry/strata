//! `scan <path> <out> [--mft] [--hidden] [--links]`: scans a drive or folder and writes a .strata file.

pub mod state;
pub mod walker;

use crate::platform::{self, ScanFlags, Volume};
use crate::protocol::{error, out};
use crate::strata_file::{self, DIR, Header, Nodes, ScanOptionsHeader};
use serde_json::json;
use state::{ScanState, lock};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct ScanOptions {
    pub root: PathBuf,
    /// The root as written in the scan file.
    pub root_name: String,
    pub out: PathBuf,
    pub mft: bool,
    pub hidden: bool,
    pub links: bool,
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

pub fn header(
    o: &ScanOptions,
    vol: &Volume,
    method: &str,
    st: &ScanState,
    partial: bool,
    nodes: &Nodes,
    errors: u64,
) -> Header {
    let (files, dirs, bytes) = nodes.totals();
    Header {
        version: 1,
        root: o.root_name.clone(),
        fs: vol.fs.clone(),
        cluster: vol.cluster,
        total: vol.total,
        free: vol.free,
        method: method.into(),
        scanned_at: now_ms(),
        duration: (st.started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        partial,
        files,
        dirs,
        errors,
        bytes,
        options: ScanOptionsHeader { mft: o.mft, hidden: o.hidden, links: o.links },
    }
}

/// Writes a snapshot of a scan still running and reports it.
pub fn write_snapshot(file: &str, nodes: &Nodes, h: &Header) {
    match strata_file::write(Path::new(file), nodes, h) {
        Ok(()) => out(&json!({ "type": "snapshot", "out": file })),
        Err(e) => out(&json!({ "type": "snapshot", "error": e.to_string() })),
    }
}

pub fn run(args: &[String]) -> i32 {
    if args.len() < 3 {
        error("usage: scan <path> <out> [--mft] [--hidden] [--links]");
        return 2;
    }
    let root = platform::normalize_root(&args[1]);
    let flag = |f: &str| args[3..].iter().any(|a| a == f);
    let o = ScanOptions {
        root_name: root.to_string_lossy().into_owned(),
        root,
        out: PathBuf::from(&args[2]),
        mft: flag("--mft"),
        hidden: flag("--hidden"),
        links: flag("--links"),
    };
    if !platform::is_dir(&o.root) {
        error(&format!("Folder not found: {}", o.root_name));
        return 1;
    }

    let vol = platform::volume(&o.root);
    let st = Arc::new(ScanState::new(vol.is_drive_root, vol.total.saturating_sub(vol.free)));
    state::start_commands(st.clone());
    state::start_ticker(st.clone());

    #[cfg(windows)]
    let fast = if o.mft {
        match platform::fast_scan(&o, &vol, &st) {
            Ok(n) => Some(n),
            Err(why) => {
                crate::protocol::notice(&why);
                st.reset_counters();
                None
            }
        }
    } else {
        None
    };
    // No file-table fast scan on Linux: --mft is accepted and ignored.
    #[cfg(not(windows))]
    let fast: Option<Nodes> = None;
    let (nodes, method) = match fast {
        Some(n) => (n, "MFT"),
        None => (walk(&o, &vol, &st), "Walk"),
    };

    st.set_phase("build");
    let partial = st.stopped();
    let h = header(&o, &vol, method, &st, partial, &nodes, st.errors.load(Ordering::Relaxed));
    let written = strata_file::write(&o.out, &nodes, &h);
    st.finished.store(true, Ordering::Relaxed);
    if let Err(e) = written {
        error(&format!("Could not write the scan file: {e}"));
        return 1;
    }
    out(&json!({ "type": "done", "out": args[2], "partial": partial, "method": method }));
    0
}

fn walk(o: &ScanOptions, vol: &Volume, st: &Arc<ScanState>) -> Nodes {
    st.set_phase("walk");
    let lister = platform::new_lister(&o.root, &ScanFlags { hidden: o.hidden, links: o.links });
    let nodes = Arc::new(Mutex::new(Nodes::with_capacity(1 << 16)));
    lock(&nodes).push(-1, o.root_name.clone(), 0, platform::root_mtime(&o.root), DIR, 0);
    st.dirs.fetch_add(1, Ordering::Relaxed);
    {
        let (nodes, st2, o, vol) = (nodes.clone(), st.clone(), o.clone(), vol.clone());
        *lock(&st.snapshot) = Some(Arc::new(move |file: &str| {
            let copy = lock(&nodes).clone();
            let h = header(&o, &vol, "Walk", &st2, true, &copy, st2.errors.load(Ordering::Relaxed));
            write_snapshot(file, &copy, &h);
        }));
    }
    walker::walk(lister.as_ref(), st, &nodes, o.root.clone());
    *lock(&st.snapshot) = None;
    std::mem::take(&mut *lock(&nodes))
}
