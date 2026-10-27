//! Folder walk: a pool of threads takes folders from a shared stack (depth-first) and lists each once.
//! Nodes are appended one folder at a time under a lock, so a parent always comes before its children.

use super::state::{ACTIVE, DONE, PENDING, ScanState, TopItem, lock};
use crate::platform::{DirLister, ListError, SEP};
use crate::strata_file::{DENIED, DIR, Nodes};
use crate::types;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

struct Job {
    node: usize,
    path: PathBuf,
    /// Path relative to the scanned folder, for the "biggest files" list.
    rel: String,
    depth: u32,
    top: Option<usize>,
}

struct Walk<'a> {
    lister: &'a dyn DirLister,
    st: &'a ScanState,
    nodes: &'a Mutex<Nodes>,
    jobs: Mutex<Vec<Job>>,
    wake: Condvar,
    outstanding: AtomicUsize,
}

/// Walks `root`, whose node (index 0) is already in `nodes`.
pub fn walk(lister: &dyn DirLister, st: &Arc<ScanState>, nodes: &Arc<Mutex<Nodes>>, root: PathBuf) {
    let w = Walk {
        lister,
        st,
        nodes,
        jobs: Mutex::new(Vec::new()),
        wake: Condvar::new(),
        outstanding: AtomicUsize::new(1),
    };
    w.process(Job { node: 0, path: root, rel: String::new(), depth: 0, top: None });
    w.outstanding.fetch_sub(1, Ordering::SeqCst);

    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| w.work());
        }
    });
    st.set_pct(1.0);
}

impl Walk<'_> {
    fn work(&self) {
        loop {
            let job = {
                let mut jobs = lock(&self.jobs);
                loop {
                    if let Some(j) = jobs.pop() {
                        break j;
                    }
                    if self.outstanding.load(Ordering::SeqCst) == 0 {
                        self.wake.notify_all();
                        return;
                    }
                    jobs = self.wake.wait_timeout(jobs, Duration::from_millis(50)).unwrap_or_else(|e| e.into_inner()).0;
                }
            };
            self.st.wait_if_paused();
            let top = job.top;
            if !self.st.stopped() {
                self.process(job);
            }
            self.finish(top);
        }
    }

    fn finish(&self, top: Option<usize>) {
        if let Some(t) = top {
            let mut tops = lock(&self.st.tops);
            let item = &mut tops.items[t];
            item.pending -= 1;
            if item.pending == 0 {
                item.state = DONE;
                tops.done += 1;
            }
        }
        self.st.update_walk_pct();
        if self.outstanding.fetch_sub(1, Ordering::SeqCst) == 1 {
            let _jobs = lock(&self.jobs);
            self.wake.notify_all();
        }
    }

    fn process(&self, job: Job) {
        let st = self.st;
        st.set_current(&job.path.to_string_lossy());
        if let Some(t) = job.top {
            let mut tops = lock(&st.tops);
            if tops.items[t].state == PENDING {
                tops.items[t].state = ACTIVE;
            }
        }
        let entries = match self.lister.list(&job.path, job.depth) {
            Ok(e) => e,
            Err(ListError::Gone) => return,
            Err(ListError::Denied) => {
                st.errors.fetch_add(1, Ordering::Relaxed);
                lock(self.nodes).flags[job.node] |= DENIED;
                return;
            }
        };

        let root_level = job.depth == 0;
        let (mut bytes, mut files, mut dirs) = (0u64, 0u64, 0u64);
        let mut local_types = [0u64; types::COUNT];
        let mut kinds = Vec::with_capacity(entries.len());
        for e in &entries {
            if e.flags & DIR != 0 {
                dirs += 1;
                kinds.push(0);
            } else {
                let t = if e.typed { types::classify(&e.name) } else { types::OTHER };
                kinds.push(t);
                bytes += e.size;
                files += 1;
                local_types[t as usize] += e.size;
                st.offer_big(e.size, || join_rel(&job.rel, &e.name));
            }
        }
        st.bytes.fetch_add(bytes, Ordering::Relaxed);
        st.files.fetch_add(files, Ordering::Relaxed);
        st.dirs.fetch_add(dirs, Ordering::Relaxed);
        if let Some(t) = job.top {
            let mut tops = lock(&st.tops);
            let item = &mut tops.items[t];
            item.bytes += bytes;
            for (a, b) in item.type_bytes.iter_mut().zip(local_types) {
                *a += b;
            }
        }

        let base = {
            let mut nodes = lock(self.nodes);
            let base = nodes.len();
            for (e, &k) in entries.iter().zip(&kinds) {
                nodes.push(job.node as i32, e.name.clone(), e.size, e.mtime, e.flags, k);
            }
            base
        };

        let mut top_base = 0;
        if root_level {
            let mut tops = lock(&st.tops);
            top_base = tops.items.len();
            for (e, &k) in entries.iter().zip(&kinds) {
                let dir = e.flags & DIR != 0;
                let mut t = TopItem::new(e.name.clone(), dir, if e.descend { PENDING } else { DONE });
                if !dir {
                    t.bytes = e.size;
                    t.type_bytes[k as usize] = e.size;
                }
                if t.state == DONE {
                    tops.done += 1;
                }
                tops.items.push(t);
            }
            tops.count = entries.len();
        }

        // Pushed in reverse so the first folder is worked on first (depth-first).
        let mut pushed = Vec::new();
        for (i, e) in entries.iter().enumerate().rev() {
            if !e.descend {
                continue;
            }
            let top = if root_level { Some(top_base + i) } else { job.top };
            if let Some(t) = top {
                lock(&st.tops).items[t].pending += 1;
            }
            pushed.push(Job {
                node: base + i,
                path: job.path.join(&e.os_name),
                rel: join_rel(&job.rel, &e.name),
                depth: job.depth + 1,
                top,
            });
        }
        if !pushed.is_empty() {
            self.outstanding.fetch_add(pushed.len(), Ordering::SeqCst);
            let mut jobs = lock(&self.jobs);
            jobs.extend(pushed);
            self.wake.notify_all();
        }
    }
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_owned() } else { format!("{rel}{SEP}{name}") }
}
