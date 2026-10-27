//! The scanner process (strata-scan, built from ../scanner): where it lives and how it is run.
//! The protocol is in docs/PROTOCOL.md: one JSON object per stdout line, plain-text commands on stdin.
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::platform;

static EMBEDDED: &[u8] = include_bytes!(env!("STRATA_SCANNER_EMBEDDED"));

/// Makes sure the embedded scanner exists as a file and returns its path. It is rewritten when it differs
/// (a new version), so the file next to the user's data always matches this build.
pub fn ensure(data_dir: &Path) -> Result<PathBuf, String> {
    if EMBEDDED.is_empty() {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("bin").join(platform::scanner_name());
        return if dev.exists() { Ok(dev) } else { Err("The scanner is missing. Run `npm run build:scanner`.".into()) };
    }
    let mut last = String::new();
    for dir in [data_dir.join("bin"), std::env::temp_dir().join("strata-bin")] {
        match extract(&dir) {
            Ok(p) => return Ok(p),
            Err(e) => last = format!("{}: {e}", dir.display()),
        }
    }
    Err(format!("Couldn't unpack the scanner ({last})"))
}

fn extract(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(platform::scanner_name());
    if std::fs::read(&target).map(|b| b == EMBEDDED).unwrap_or(false) {
        return Ok(target);
    }
    let tmp = dir.join(format!("{}.{}.tmp", platform::scanner_name(), std::process::id()));
    std::fs::write(&tmp, EMBEDDED)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    // Replacing a running scanner fails on Windows; then the old file (already matching or not) is kept.
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        if !target.exists() {
            return Err(e);
        }
    }
    Ok(target)
}

/// A running scanner: kill it, or write commands to its stdin.
#[derive(Clone)]
pub struct Proc {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl Proc {
    pub fn kill(&self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
    }

    pub fn write(&self, line: &str) {
        if let Ok(mut s) = self.stdin.lock()
            && let Some(s) = s.as_mut()
        {
            let _ = writeln!(s, "{line}");
            let _ = s.flush();
        }
    }
}

/// Runs the scanner to the end, calling `on_line` for every message. `on_spawn` gets the process first
/// (to kill it or send commands). Blocking: call it from a thread.
pub fn run(
    scanner: &Path,
    args: &[String],
    mut on_line: impl FnMut(Value, &Proc),
    on_spawn: impl FnOnce(Proc),
) -> Result<(), String> {
    let mut cmd = Command::new(scanner);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the scanner: {e}"))?;
    let stdout = child.stdout.take().ok_or("no scanner output")?;
    let mut stderr = child.stderr.take().ok_or("no scanner output")?;
    let stdin = child.stdin.take();
    let proc = Proc { child: Arc::new(Mutex::new(child)), stdin: Arc::new(Mutex::new(stdin)) };
    on_spawn(proc.clone());

    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    for line in BufReader::new(stdout).split(b'\n') {
        let Ok(line) = line else { break };
        let line = String::from_utf8_lossy(&line);
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(msg) = serde_json::from_str::<Value>(&line) {
            on_line(msg, &proc);
        }
    }
    // The scanner reads no more commands once it has finished.
    if let Ok(mut s) = proc.stdin.lock() {
        *s = None;
    }
    let status = proc.child.lock().map_err(|_| "scanner lock poisoned")?.wait().map_err(|e| e.to_string())?;
    let err = err_thread.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(if err.trim().is_empty() {
            format!("Scanner exited with code {}", status.code().unwrap_or(-1))
        } else {
            err.trim().to_string()
        })
    }
}
