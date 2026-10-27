//! Talking to the main process: one JSON object per line on stdout, plain-text commands on stdin.

use serde::Serialize;
use serde_json::json;
use std::io::Write;
use std::sync::Mutex;

static STDOUT: Mutex<()> = Mutex::new(());

/// Writes one message as a JSON line. Lines from different threads never interleave.
pub fn out<T: Serialize + ?Sized>(msg: &T) {
    let mut line = serde_json::to_vec(msg).unwrap_or_else(|e| {
        serde_json::to_vec(&json!({ "type": "error", "message": e.to_string() })).unwrap_or_default()
    });
    line.push(b'\n');
    let _guard = STDOUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut stdout = std::io::stdout().lock();
    // The main process may already be gone; nothing useful to do about it.
    let _ = stdout.write_all(&line);
    let _ = stdout.flush();
}

pub fn error(message: &str) {
    out(&json!({ "type": "error", "message": message }));
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn notice(message: &str) {
    out(&json!({ "type": "notice", "message": message }));
}

pub fn done() {
    out(&json!({ "type": "done" }));
}

/// Reads a list file (one entry per line, UTF-8), skipping blank lines.
pub fn read_list(file: &str) -> std::io::Result<Vec<String>> {
    let text = std::fs::read_to_string(file)?;
    Ok(text.split('\n').map(|l| l.trim_end_matches('\r')).filter(|l| !l.trim().is_empty()).map(str::to_owned).collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn json_escapes_control_characters_quotes_and_backslashes() {
        let s = serde_json::to_string(&serde_json::json!({ "path": "C:\\Users\\a \"b\"\n\t\u{1}" })).unwrap();
        assert_eq!(s, r#"{"path":"C:\\Users\\a \"b\"\n\t\u0001"}"#);
        let back: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back["path"], "C:\\Users\\a \"b\"\n\t\u{1}");
    }
}
