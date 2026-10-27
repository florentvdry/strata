//! The Recycle Bin: SHFileOperation to send items there (one call per batch, much faster than one per item), and
//! the $I metadata files in X:\$Recycle.Bin\<SID>\ to find and restore them.

use super::{unix_from_filetime, wide};
use crate::platform::TrashEntry;
use std::path::Path;
use windows_sys::Win32::UI::Shell::{FO_DELETE, SHFILEOPSTRUCTW, SHFileOperationW};

// FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI | FOF_WANTNUKEWARNING: the last one makes Windows
// warn instead of silently deleting for good when an item is too big for the Recycle Bin.
const RECYCLE_FLAGS: u16 = 0x4 | 0x10 | 0x40 | 0x400 | 0x4000;
const BATCH: usize = 64;
/// SHFileOperation doesn't take long paths.
const MAX_PATH: usize = 260;

/// Paths, each NUL-terminated, then one more NUL.
fn recycle(paths: &[&str]) -> bool {
    let mut from: Vec<u16> = Vec::new();
    for p in paths {
        from.extend(wide(p));
    }
    from.push(0);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = RECYCLE_FLAGS;
    unsafe { SHFileOperationW(&mut op) == 0 && op.fAnyOperationsAborted == 0 }
}

fn exists(p: &str) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

pub struct TrashContext;

pub fn trash_context() -> TrashContext {
    TrashContext
}

/// Recycles in batches; what fails is retried one by one by `trash_item`.
pub fn trash_prepare(paths: &[String], progress: &mut dyn FnMut(usize)) {
    for start in (0..paths.len()).step_by(BATCH) {
        let batch: Vec<&str> = paths[start..(start + BATCH).min(paths.len())]
            .iter()
            .map(String::as_str)
            .filter(|p| p.len() < MAX_PATH && exists(p))
            .collect();
        if batch.is_empty() {
            continue;
        }
        progress(start);
        recycle(&batch);
    }
}

pub fn trash_item(_ctx: &TrashContext, p: &str) -> Result<(), String> {
    if p.len() >= MAX_PATH {
        return Err("Path too long for the Recycle Bin".into());
    }
    if recycle(&[p]) { Ok(()) } else { Err("In use or access denied".into()) }
}

/// Reads a $I file: version 1 has a fixed 260-character path, version 2 a length-prefixed one.
pub fn parse_info(b: &[u8]) -> Option<(String, f64)> {
    let i64_at = |o: usize| b.get(o..o + 8).map(|s| i64::from_le_bytes(s.try_into().unwrap()));
    let version = i64_at(0)?;
    let deleted = unix_from_filetime(i64_at(16)?) * 1000.0;
    let units = |bytes: &[u8]| bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect::<Vec<u16>>();
    let original = if version == 2 {
        let len = i32::from_le_bytes(b.get(24..28)?.try_into().ok()?) as usize;
        let chars = units(b.get(28..28 + len.saturating_sub(1) * 2)?);
        String::from_utf16_lossy(&chars)
    } else {
        let chars = units(&b[24.min(b.len())..(24 + 520).min(b.len())]);
        let n = chars.iter().position(|&c| c == 0).unwrap_or(chars.len());
        String::from_utf16_lossy(&chars[..n])
    };
    Some((original, deleted.round()))
}

/// Recycle Bin items on the drive of `for_path` (every user folder we can read).
pub fn trash_entries(for_path: &str) -> Vec<TrashEntry> {
    let drive: String = for_path.chars().take(2).collect();
    let bin = format!("{drive}\\$Recycle.Bin");
    let mut out = Vec::new();
    let Ok(sids) = std::fs::read_dir(&bin) else {
        return out;
    };
    for sid in sids.flatten() {
        let Ok(items) = std::fs::read_dir(sid.path()) else {
            continue;
        };
        for item in items.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix("$I") else {
                continue;
            };
            let Ok(bytes) = std::fs::read(item.path()) else {
                continue;
            };
            let Some((original, deleted_at)) = parse_info(&bytes) else {
                continue;
            };
            out.push(TrashEntry {
                info: item.path().to_string_lossy().into_owned(),
                data: sid.path().join(format!("$R{rest}")).to_string_lossy().into_owned(),
                original,
                deleted_at,
            });
        }
    }
    out
}

/// Moves a recycled item back, given its $I file.
pub fn restore(info: &str) -> Result<String, String> {
    let info_path = Path::new(info);
    let bytes = std::fs::read(info_path).map_err(|e| crate::platform::describe_io(&e))?;
    let (original, _) = parse_info(&bytes).ok_or("Not a Recycle Bin entry")?;
    let name = info_path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("$I"))
        .ok_or("Not a Recycle Bin entry")?;
    let data = info_path.with_file_name(format!("$R{name}"));
    crate::platform::put_back(&data, Path::new(&original), info_path)?;
    Ok(original)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_info_versions() {
        let ft: i64 = 116_444_736_000_000_000 + 1_700_000_000 * 10_000_000;
        let path: Vec<u16> = "C:\\Users\\a\\file.txt".encode_utf16().collect();
        let mut v2 = Vec::new();
        v2.extend(2i64.to_le_bytes());
        v2.extend(1234i64.to_le_bytes());
        v2.extend(ft.to_le_bytes());
        v2.extend(((path.len() + 1) as i32).to_le_bytes());
        for c in &path {
            v2.extend(c.to_le_bytes());
        }
        v2.extend([0, 0]);
        assert_eq!(parse_info(&v2), Some(("C:\\Users\\a\\file.txt".into(), 1.7e12)));
        let mut v1 = Vec::new();
        v1.extend(1i64.to_le_bytes());
        v1.extend(1234i64.to_le_bytes());
        v1.extend(ft.to_le_bytes());
        for c in &path {
            v1.extend(c.to_le_bytes());
        }
        v1.resize(24 + 520, 0);
        assert_eq!(parse_info(&v1), Some(("C:\\Users\\a\\file.txt".into(), 1.7e12)));
    }
}
