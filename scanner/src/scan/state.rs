//! State shared by the scanning threads, the progress ticker and the stdin commands.

use crate::protocol::out;
use crate::types;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const PENDING: u8 = 0;
pub const ACTIVE: u8 = 1;
pub const DONE: u8 = 2;

/// Files bigger than this show up in the live "biggest files" list.
pub const BIG_FILE: u64 = 64 << 20;

/// A direct child of the scanned folder, for the map building up while scanning.
pub struct TopItem {
    pub name: String,
    pub dir: bool,
    pub bytes: u64,
    pub state: u8,
    /// Folder jobs still to do under this item (folder walk).
    pub pending: u32,
    pub type_bytes: [u64; types::COUNT],
}

impl TopItem {
    pub fn new(name: String, dir: bool, state: u8) -> Self {
        TopItem { name, dir, bytes: 0, state, pending: 0, type_bytes: [0; types::COUNT] }
    }

    pub fn dominant(&self) -> usize {
        let mut best = 0;
        for (i, &b) in self.type_bytes.iter().enumerate() {
            if b > self.type_bytes[best] {
                best = i;
            }
        }
        best
    }
}

#[derive(Default)]
pub struct Tops {
    pub items: Vec<TopItem>,
    /// Items at the root, and how many of them are finished (for the percentage).
    pub count: usize,
    pub done: usize,
}

pub type SnapshotFn = Arc<dyn Fn(&str) + Send + Sync>;

pub struct ScanState {
    paused: Mutex<bool>,
    resumed: Condvar,
    pub stop: AtomicBool,
    pub finished: AtomicBool,
    pub phase: Mutex<&'static str>,
    pub current: Mutex<String>,
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pct: Mutex<f64>,
    pub tops: Mutex<Tops>,
    biggest: Mutex<Vec<(u64, String)>>,
    big_min: AtomicU64,
    pub snapshot: Mutex<Option<SnapshotFn>>,
    pub started: Instant,
    /// Scanning a whole drive: progress is bytes found / bytes used on the drive.
    pub drive_used: u64,
    pub is_drive_root: bool,
}

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl ScanState {
    pub fn new(is_drive_root: bool, drive_used: u64) -> Self {
        ScanState {
            paused: Mutex::new(false),
            resumed: Condvar::new(),
            stop: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            phase: Mutex::new("walk"),
            current: Mutex::new(String::new()),
            files: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            pct: Mutex::new(0.0),
            tops: Mutex::new(Tops::default()),
            biggest: Mutex::new(Vec::new()),
            big_min: AtomicU64::new(0),
            snapshot: Mutex::new(None),
            started: Instant::now(),
            drive_used,
            is_drive_root,
        }
    }

    pub fn is_paused(&self) -> bool {
        *lock(&self.paused)
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    pub fn pause(&self) {
        *lock(&self.paused) = true;
    }

    pub fn resume(&self) {
        *lock(&self.paused) = false;
        self.resumed.notify_all();
    }

    /// Finish now with what was found so far.
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.resume();
    }

    pub fn wait_if_paused(&self) {
        let mut paused = lock(&self.paused);
        while *paused {
            paused = self.resumed.wait(paused).unwrap_or_else(|e| e.into_inner());
        }
    }

    pub fn set_phase(&self, phase: &'static str) {
        *lock(&self.phase) = phase;
    }

    pub fn set_current(&self, path: &str) {
        let mut c = lock(&self.current);
        c.clear();
        c.push_str(path);
    }

    pub fn pct(&self) -> f64 {
        *lock(&self.pct)
    }

    /// The percentage only moves forward.
    pub fn raise_pct(&self, p: f64) {
        let mut pct = lock(&self.pct);
        if p > *pct {
            *pct = p;
        }
    }

    pub fn set_pct(&self, p: f64) {
        *lock(&self.pct) = p;
    }

    /// Folder walk: bytes / used space for a drive, else finished top-level items (active ones count for a bit under half).
    pub fn update_walk_pct(&self) {
        let p = if self.is_drive_root && self.drive_used > 0 {
            self.bytes.load(Ordering::Relaxed) as f64 / self.drive_used as f64
        } else {
            let tops = lock(&self.tops);
            let active = tops.items.iter().filter(|t| t.state == ACTIVE).count();
            (tops.done as f64 + active as f64 * 0.45) / tops.count.max(1) as f64
        };
        self.raise_pct(p.min(0.99));
    }

    pub fn offer_big(&self, size: u64, path: impl FnOnce() -> String) {
        if size <= BIG_FILE || size <= self.big_min.load(Ordering::Relaxed) {
            return;
        }
        let mut big = lock(&self.biggest);
        big.push((size, path()));
        big.sort_by_key(|b| std::cmp::Reverse(b.0));
        big.truncate(5);
        if big.len() == 5 {
            self.big_min.store(big[4].0, Ordering::Relaxed);
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn reset_counters(&self) {
        self.files.store(0, Ordering::Relaxed);
        self.dirs.store(0, Ordering::Relaxed);
        self.bytes.store(0, Ordering::Relaxed);
        *lock(&self.tops) = Tops::default();
        lock(&self.biggest).clear();
        self.big_min.store(0, Ordering::Relaxed);
        self.set_pct(0.0);
    }

    pub fn progress_message(&self) -> serde_json::Value {
        let tops: Vec<_> = lock(&self.tops)
            .items
            .iter()
            .map(|t| json!({ "name": t.name, "dir": t.dir, "bytes": t.bytes, "state": t.state, "type": t.dominant() }))
            .collect();
        let biggest: Vec<_> = lock(&self.biggest)
            .iter()
            .map(|(size, path)| json!({ "path": path, "size": size, "type": types::classify(path) }))
            .collect();
        let phase = if self.is_paused() { "paused" } else { *lock(&self.phase) };
        json!({
            "type": "progress",
            "phase": phase,
            "files": self.files.load(Ordering::Relaxed),
            "dirs": self.dirs.load(Ordering::Relaxed),
            "bytes": self.bytes.load(Ordering::Relaxed),
            "errors": self.errors.load(Ordering::Relaxed),
            "pct": (self.pct() * 1e4).round() / 1e4,
            "current": *lock(&self.current),
            "tops": tops,
            "biggest": biggest,
        })
    }
}

/// About 5 progress messages a second until the scan is finished.
pub fn start_ticker(st: Arc<ScanState>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(180));
            if st.finished.load(Ordering::Relaxed) {
                break;
            }
            out(&st.progress_message());
        }
    });
}

/// Commands from the main process: pause, resume, stop, snapshot <file>.
pub fn start_commands(st: Arc<ScanState>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let cmd = line.trim();
            match cmd {
                "pause" => st.pause(),
                "resume" => st.resume(),
                "stop" => st.request_stop(),
                _ => {
                    if let Some(file) = cmd.strip_prefix("snapshot ") {
                        let handler = lock(&st.snapshot).clone();
                        match handler {
                            Some(h) => {
                                let file = file.to_owned();
                                std::thread::spawn(move || h(&file));
                            }
                            None => out(&json!({ "type": "snapshot", "error": "not ready" })),
                        }
                    }
                }
            }
        }
    });
}
