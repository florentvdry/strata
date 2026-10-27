//! Shared state: where the data lives, the scan in progress, caches.
use serde_json::Value;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Instant;

use crate::scanner::{self, Proc};
use crate::updates::Updates;
use crate::{platform, store};

/// A scan being run by the scanner process.
pub struct Scan {
    pub id: String,
    pub out: PathBuf,
    pub proc: Mutex<Option<Proc>>,
    pub done: AtomicBool,
    pub cancelled: AtomicBool,
    /// Callers of "explore partial results" waiting for the scanner's `snapshot` message.
    pub waiters: Mutex<VecDeque<mpsc::Sender<Value>>>,
}

pub struct AppState {
    pub data: PathBuf,
    pub version: String,
    pub portable: bool,
    scanner: Result<PathBuf, String>,
    pub current: Mutex<Option<Arc<Scan>>>,
    pub dupes: Mutex<Option<Proc>>,
    /// Deletions in progress (an update must not restart the app in the middle of one).
    pub deleting: AtomicUsize,
    drives: Mutex<Option<(Instant, Value)>>,
    pub updates: Updates,
}

pub const MAX_RECENT: usize = 8;
pub const HISTORY_DAYS: i64 = 7;

impl AppState {
    pub fn new(data: PathBuf, version: String, portable: bool, updates: Updates) -> Self {
        let scanner = scanner::ensure(&data);
        Self {
            data,
            version,
            portable,
            scanner,
            current: Mutex::new(None),
            dupes: Mutex::new(None),
            deleting: AtomicUsize::new(0),
            drives: Mutex::new(None),
            updates,
        }
    }

    pub fn scanner(&self) -> Result<&Path, String> {
        self.scanner.as_deref().map_err(|e| e.clone())
    }
    pub fn scans_dir(&self) -> PathBuf {
        self.data.join("scans")
    }
    pub fn settings_file(&self) -> PathBuf {
        self.data.join("settings.json")
    }
    pub fn recent_file(&self) -> PathBuf {
        self.scans_dir().join("index.json")
    }
    pub fn history_file(&self) -> PathBuf {
        self.data.join("history.json")
    }

    pub fn settings(&self) -> Value {
        store::get_settings(&self.settings_file(), &self.version)
    }

    /// Drives, admin flag and Trash folders from the scanner, cached for a few seconds.
    pub fn info(&self, force: bool) -> Result<Value, String> {
        if !force
            && let Some((at, v)) = self.drives.lock().unwrap().as_ref()
            && at.elapsed().as_secs() < 8
        {
            return Ok(v.clone());
        }
        let mut value = serde_json::json!({ "admin": false, "drives": [], "trashDirs": [] });
        scanner::run(
            self.scanner()?,
            &["info".into()],
            |msg, _| {
                if msg["type"] == "info" {
                    value = msg;
                }
            },
            |_| {},
        )?;
        if let Some(d) = value.get_mut("drives").and_then(Value::as_array_mut) {
            platform::sort_drives(d);
        }
        *self.drives.lock().unwrap() = Some((Instant::now(), value.clone()));
        Ok(value)
    }

    /// The last drive listing, if any (for the protected locations).
    pub fn cached_info(&self) -> Option<Value> {
        self.drives.lock().unwrap().as_ref().map(|(_, v)| v.clone())
    }

    pub fn scan_running(&self) -> bool {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|s| !s.done.load(std::sync::atomic::Ordering::SeqCst) && s.proc.lock().unwrap().is_some())
    }
}
