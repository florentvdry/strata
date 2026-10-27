//! `delete <list> [recycle|permanent]`: deletes the listed paths and reports what is left of each.
//! `trash-list <path>`: items in the Recycle Bin / Trash that could have come from that path.
//! `restore <list>`: puts Recycle Bin / Trash items (listed by their metadata file) back where they came from.

use crate::platform;
use crate::protocol::{done, error, out, read_list};
use serde_json::json;
use std::fs;
use std::io;
use std::path::Path;

fn exists(p: &str) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// Bytes still there: files count, links don't, folders are summed.
fn size_of(p: &Path) -> u64 {
    let Ok(md) = fs::symlink_metadata(p) else {
        return 0;
    };
    if md.file_type().is_symlink() {
        return 0;
    }
    if md.is_dir() {
        return fs::read_dir(p).map(|rd| rd.flatten().map(|e| size_of(&e.path())).sum()).unwrap_or(0);
    }
    if md.is_file() { md.len() } else { 0 }
}

/// Permanent delete. Links (symlinks, junctions) are removed as links, never followed.
pub fn delete_tree(p: &Path) -> io::Result<()> {
    let md = fs::symlink_metadata(p)?;
    if md.file_type().is_symlink() {
        return platform::remove_link(p, &md);
    }
    platform::prepare_delete(p, &md);
    if md.is_dir() {
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                let _ = delete_tree(&e.path());
            }
        }
        fs::remove_dir(p)
    } else {
        fs::remove_file(p)
    }
}

fn progress(done: usize, total: usize, current: &str) {
    out(&json!({ "type": "progress", "done": done, "total": total, "current": current }));
}

pub fn run(list_file: &str, permanent: bool) -> i32 {
    let paths = match read_list(list_file) {
        Ok(p) => p.into_iter().map(|l| l.trim().to_owned()).collect::<Vec<_>>(),
        Err(e) => {
            error(&e.to_string());
            return 1;
        }
    };
    let ctx = platform::trash_context();
    if !permanent {
        // Windows recycles in batches first (much faster); what is left is retried one by one below.
        platform::trash_prepare(&paths, &mut |i| progress(i, paths.len(), &paths[i]));
    }
    for (i, p) in paths.iter().enumerate() {
        progress(i, paths.len(), p);
        let mut err: Option<String> = None;
        if exists(p) {
            let r = if permanent {
                delete_tree(Path::new(p)).map_err(|e| platform::describe_io(&e))
            } else {
                platform::trash_item(&ctx, p)
            };
            err = r.err();
        }
        let ok = !exists(p);
        let remaining = if ok { 0 } else { size_of(Path::new(p)) };
        if !ok && (err.is_none() || remaining > 0) {
            err = Some(err.unwrap_or_else(|| "Some files are in use or protected".into()));
        }
        out(
            &json!({ "type": "result", "path": p, "ok": ok, "remaining": remaining, "error": if ok { None } else { err } }),
        );
    }
    done();
    0
}

pub fn trash_list(for_path: &str) -> i32 {
    for e in platform::trash_entries(for_path) {
        out(
            &json!({ "type": "entry", "info": e.info, "data": e.data, "original": e.original, "deletedAt": e.deleted_at }),
        );
    }
    done();
    0
}

pub fn restore(list_file: &str) -> i32 {
    let infos = match read_list(list_file) {
        Ok(p) => p,
        Err(e) => {
            error(&e.to_string());
            return 1;
        }
    };
    for info in infos {
        match platform::restore(&info) {
            Ok(original) => {
                out(&json!({ "type": "result", "info": info, "path": original, "ok": true, "error": null }))
            }
            Err(e) => out(&json!({ "type": "result", "info": info, "path": null, "ok": false, "error": e })),
        }
    }
    done();
    0
}
