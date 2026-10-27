//! strata-scan: the disk-scanning helper behind Strata, for Windows and Linux.
//!
//!   strata-scan info
//!       One JSON object: { type: "info", admin, drives: [...], trashDirs: [...] }.
//!   strata-scan scan <path> <outFile> [--mft] [--hidden] [--links]
//!       Scans <path> and writes <outFile> (see strata_file.rs). Progress goes to stdout as JSON lines;
//!       stdin accepts "pause", "resume", "snapshot <file>" and "stop". --mft (NTFS fast scan) is Windows only.
//!   strata-scan dupes <listFile>
//!       <listFile> holds "size<TAB>path" lines grouped by size. Prints the groups of identical files.
//!   strata-scan delete <listFile> [recycle|permanent]
//!       Deletes the paths listed one per line and prints a result per path.
//!   strata-scan trash-list [path]
//!       Items in the Recycle Bin / Trash that could have come from <path>.
//!   strata-scan restore <listFile>
//!       Puts back the Recycle Bin / Trash items whose metadata files are listed one per line.
//!
//! Exit codes: 0 success, 1 error, 2 missing or unknown command. See docs/PROTOCOL.md.

mod delete;
mod dupes;
// The NTFS fast scan runs on Windows; its tests read disk images on every OS.
#[cfg(any(windows, test, fuzzing))]
pub mod mft;
mod platform;
mod protocol;
mod scan;
mod strata_file;
mod types;

use protocol::{error, out};

pub use protocol::error as report_error;

/// Runs one command and returns the exit code.
pub fn run(args: &[String]) -> i32 {
    let arg = |i: usize| args.get(i).map(String::as_str);
    match arg(0) {
        None => {
            error("no command");
            2
        }
        Some("info") => {
            out(&platform::info());
            0
        }
        Some("scan") => scan::run(args),
        Some("dupes") => match arg(1) {
            Some(list) => dupes::run(list),
            None => usage("dupes <listFile>"),
        },
        Some("delete") => match arg(1) {
            Some(list) => delete::run(list, arg(2) == Some("permanent")),
            None => usage("delete <listFile> [recycle|permanent]"),
        },
        Some("trash-list") => delete::trash_list(arg(1).unwrap_or("")),
        Some("restore") => match arg(1) {
            Some(list) => delete::restore(list),
            None => usage("restore <listFile>"),
        },
        Some("--version") => {
            println!("strata-scan {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some(_) => {
            error("unknown command");
            2
        }
    }
}

fn usage(u: &str) -> i32 {
    error(&format!("usage: {u}"));
    2
}
