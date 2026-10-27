//! The app's commands: what `main.js` did in the Electron version, one command per `window.strata` call.
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::{AppState, HISTORY_DAYS, MAX_RECENT, Scan};
use crate::{platform, scanner, store, updates};

type S<'a> = State<'a, Arc<AppState>>;
type Res<T> = Result<T, String>;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Runs blocking work (disk, child processes) off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut s = Vec::new();
    while n > 0 {
        s.push(D[(n % 36) as usize]);
        n /= 36;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

fn set_progress(app: &AppHandle, pct: Option<f64>, paused: bool) {
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    if let Some(w) = app.get_webview_window("main") {
        let state = match pct {
            None => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
            Some(p) => ProgressBarState {
                status: Some(if paused { ProgressBarStatus::Paused } else { ProgressBarStatus::Normal }),
                progress: Some((p.clamp(0.01, 1.0) * 100.0) as u64),
            },
        };
        let _ = w.set_progress_bar(state);
    }
}

// ───────────── scans ─────────────

fn recent_list(st: &AppState) -> Vec<Value> {
    let list = store::read_json(&st.recent_file(), json!([]));
    list.as_array()
        .map(|a| {
            a.iter().filter(|r| r["file"].as_str().is_some_and(|f| st.scans_dir().join(f).exists())).cloned().collect()
        })
        .unwrap_or_default()
}

fn remove_scan_files(st: &AppState, file: &str) {
    for f in [file.to_string(), file.replace(".strata", ".dupes.json")] {
        let _ = std::fs::remove_file(st.scans_dir().join(f));
    }
}

fn add_recent(st: &AppState, entry: Value) {
    let root = platform::fold(entry["root"].as_str().unwrap_or(""));
    let old = store::read_json(&st.recent_file(), json!([]));
    let (same, mut rest): (Vec<Value>, Vec<Value>) = old
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .partition(|r| platform::fold(r["root"].as_str().unwrap_or("")) == root);
    for r in &same {
        remove_scan_files(st, r["file"].as_str().unwrap_or(""));
    }
    rest.insert(0, entry);
    for r in rest.iter().skip(MAX_RECENT) {
        remove_scan_files(st, r["file"].as_str().unwrap_or(""));
    }
    rest.truncate(MAX_RECENT);
    let _ = store::write_json(&st.recent_file(), &Value::Array(rest));
}

/// The JSON header of a scan file: "STRATA01", then a 4-byte length at offset 8 and the JSON at offset 12.
fn read_header(file: &Path) -> Res<Value> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file).map_err(|e| e.to_string())?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    let len = i32::from_le_bytes(head[8..12].try_into().unwrap());
    if !(0..=16 << 20).contains(&len) {
        return Err("Not a Strata scan file".into());
    }
    let mut json = vec![0u8; len as usize];
    f.seek(SeekFrom::Start(12)).map_err(|e| e.to_string())?;
    f.read_exact(&mut json).map_err(|e| e.to_string())?;
    serde_json::from_slice(&json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_start(app: AppHandle, st: S<'_>, root: String, options: Value) -> Res<Value> {
    let st = st.inner().clone();
    let scanner_path = st.scanner()?.to_path_buf();
    if let Some(prev) = st.current.lock().unwrap().as_ref()
        && let Some(p) = prev.proc.lock().unwrap().as_ref()
    {
        p.kill();
    }
    std::fs::create_dir_all(st.scans_dir()).map_err(|e| e.to_string())?;
    let id = base36(now_ms() as u64);
    let out = st.scans_dir().join(format!("{id}.strata"));
    let opt = |k: &str| options[k].as_bool().unwrap_or(false);
    let mut args: Vec<String> = vec!["scan".into(), root, out.to_string_lossy().into_owned()];
    if opt("mft") && !opt("links") {
        args.push("--mft".into());
    }
    if opt("hidden") {
        args.push("--hidden".into());
    }
    if opt("links") {
        args.push("--links".into());
    }
    let scan = Arc::new(Scan {
        id: id.clone(),
        out: out.clone(),
        proc: Mutex::new(None),
        done: false.into(),
        cancelled: false.into(),
        waiters: Default::default(),
    });
    *st.current.lock().unwrap() = Some(scan.clone());

    std::thread::spawn(move || {
        let is_current =
            |st: &AppState, scan: &Arc<Scan>| st.current.lock().unwrap().as_ref().is_some_and(|c| Arc::ptr_eq(c, scan));
        let result = scanner::run(
            &scanner_path,
            &args,
            |mut msg, _| {
                match msg["type"].as_str().unwrap_or("") {
                    "snapshot" => {
                        if let Some(w) = scan.waiters.lock().unwrap().pop_front() {
                            let _ = w.send(msg);
                        }
                        return;
                    }
                    "progress" if is_current(&st, &scan) => {
                        set_progress(&app, Some(msg["pct"].as_f64().unwrap_or(0.0)), msg["phase"] == "paused")
                    }
                    "done" => {
                        scan.done.store(true, Ordering::SeqCst);
                        set_progress(&app, None, false);
                        if let Ok(h) = read_header(&scan.out) {
                            add_recent(
                                &st,
                                json!({
                                    "id": scan.id, "root": h["root"], "file": scan.out.file_name().unwrap().to_string_lossy(),
                                    "scannedAt": h["scannedAt"], "bytes": h["bytes"], "files": h["files"], "dirs": h["dirs"],
                                    "method": h["method"], "duration": h["duration"], "partial": h["partial"],
                                }),
                            );
                        }
                    }
                    _ => {}
                }
                if is_current(&st, &scan) {
                    msg["id"] = json!(scan.id);
                    let _ = app.emit("scan:event", msg);
                }
            },
            |p| *scan.proc.lock().unwrap() = Some(p),
        );
        if let Err(e) = result
            && is_current(&st, &scan)
            && !scan.cancelled.load(Ordering::SeqCst)
        {
            let _ = app.emit("scan:event", json!({ "id": scan.id, "type": "error", "message": e }));
        }
        *scan.proc.lock().unwrap() = None;
        if is_current(&st, &scan) || st.current.lock().unwrap().is_none() {
            set_progress(&app, None, false);
        }
    });
    Ok(json!({ "id": id }))
}

fn write_cmd(st: &AppState, cmd: &str) {
    if let Some(s) = st.current.lock().unwrap().as_ref()
        && !s.done.load(Ordering::SeqCst)
        && let Some(p) = s.proc.lock().unwrap().as_ref()
    {
        p.write(cmd);
    }
}

#[tauri::command]
pub async fn scan_pause(st: S<'_>) -> Res<()> {
    write_cmd(&st, "pause");
    Ok(())
}

#[tauri::command]
pub async fn scan_resume(st: S<'_>) -> Res<()> {
    write_cmd(&st, "resume");
    Ok(())
}

#[tauri::command]
pub async fn scan_cancel(app: AppHandle, st: S<'_>) -> Res<()> {
    let Some(scan) = st.current.lock().unwrap().take() else { return Ok(()) };
    scan.cancelled.store(true, Ordering::SeqCst);
    if let Some(p) = scan.proc.lock().unwrap().as_ref() {
        p.kill();
    }
    set_progress(&app, None, false);
    let out = scan.out.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let part = PathBuf::from(format!("{}.part", out.display()));
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(part);
    });
    Ok(())
}

/// "Explore partial results": the tree found so far, or nothing (empty) when no scan is running.
#[tauri::command]
pub async fn scan_snapshot(st: S<'_>) -> Res<Response> {
    let st = st.inner().clone();
    blocking(move || {
        let Some(scan) = st.current.lock().unwrap().clone() else { return Ok(Response::new(Vec::new())) };
        let proc = scan.proc.lock().unwrap().clone();
        let Some(proc) = proc.filter(|_| !scan.done.load(Ordering::SeqCst)) else {
            return Ok(Response::new(Vec::new()));
        };
        let file = st.scans_dir().join(format!("{}.partial.strata", scan.id));
        let (tx, rx) = mpsc::channel();
        scan.waiters.lock().unwrap().push_back(tx);
        proc.write(&format!("snapshot {}", file.display()));
        let msg = rx.recv_timeout(Duration::from_secs(30)).map_err(|_| "timeout".to_string())?;
        if let Some(e) = msg["error"].as_str() {
            return Err(e.to_string());
        }
        Ok(Response::new(std::fs::read(&file).map_err(|e| e.to_string())?))
    })
    .await
}

#[tauri::command]
pub async fn scan_load(st: S<'_>, id: String) -> Res<Response> {
    let st = st.inner().clone();
    blocking(move || {
        let entry = recent_list(&st).into_iter().find(|r| r["id"] == id).ok_or("This scan is no longer available.")?;
        let file = st.scans_dir().join(entry["file"].as_str().unwrap_or(""));
        Ok(Response::new(std::fs::read(file).map_err(|e| e.to_string())?))
    })
    .await
}

#[tauri::command]
pub async fn scan_recent(st: S<'_>) -> Res<Vec<Value>> {
    Ok(recent_list(&st))
}

#[tauri::command]
pub async fn scan_clear_recent(st: S<'_>) -> Res<()> {
    let list = store::read_json(&st.recent_file(), json!([]));
    for r in list.as_array().into_iter().flatten() {
        remove_scan_files(&st, r["file"].as_str().unwrap_or(""));
    }
    store::write_json(&st.recent_file(), &json!([])).map_err(|e| e.to_string())
}

// ───────────── duplicates ─────────────

#[derive(Deserialize)]
pub struct DupeGroup {
    size: u64,
    paths: Vec<String>,
}

#[tauri::command]
pub async fn dupes_find(app: AppHandle, st: S<'_>, id: String, groups: Vec<DupeGroup>) -> Res<Value> {
    let st = st.inner().clone();
    blocking(move || {
        let cache = st.scans_dir().join(format!("{id}.dupes.json"));
        let cached = store::read_json(&cache, Value::Null);
        if !cached.is_null() {
            return Ok(cached);
        }
        if let Some(p) = st.dupes.lock().unwrap().take() {
            p.kill();
        }
        let list = std::env::temp_dir().join(format!("strata-dupes-{id}.txt"));
        let lines: Vec<String> =
            groups.iter().flat_map(|g| g.paths.iter().map(move |p| format!("{}\t{}", g.size, p))).collect();
        std::fs::write(&list, lines.join("\n")).map_err(|e| e.to_string())?;
        let mut found = Vec::new();
        let result = scanner::run(
            st.scanner()?,
            &["dupes".into(), list.to_string_lossy().into_owned()],
            |msg, _| match msg["type"].as_str() {
                Some("group") => {
                    found.push(json!({ "size": msg["size"], "verified": msg["verified"], "paths": msg["paths"] }))
                }
                Some("progress") => {
                    let _ = app.emit("dupes:progress", json!({ "id": id, "done": msg["done"], "total": msg["total"] }));
                }
                _ => {}
            },
            |p| *st.dupes.lock().unwrap() = Some(p),
        );
        *st.dupes.lock().unwrap() = None;
        let _ = std::fs::remove_file(&list);
        result?;
        let found = Value::Array(found);
        if st.scans_dir().join(format!("{id}.strata")).exists() {
            let _ = store::write_json(&cache, &found);
        }
        Ok(found)
    })
    .await
}

// ───────────── files ─────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Target {
    path: String,
    name: Option<String>,
    size: f64,
    contents_only: bool,
}

fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// Turn delete targets into concrete paths. "contentsOnly" targets (temp folders, caches) keep the folder itself.
fn expand_targets(targets: &[Target], info: Option<&Value>) -> (Vec<String>, Vec<usize>) {
    let (mut paths, mut owner) = (Vec::new(), Vec::new());
    for (t, target) in targets.iter().enumerate() {
        if target.contents_only {
            for e in std::fs::read_dir(&target.path).into_iter().flatten().flatten() {
                paths.push(Path::new(&target.path).join(e.file_name()).to_string_lossy().into_owned());
                owner.push(t);
            }
        } else {
            if platform::is_protected(&target.path, info) {
                continue;
            }
            paths.push(target.path.clone());
            owner.push(t);
        }
    }
    (paths, owner)
}

fn prune_history(list: &Value) -> Vec<Value> {
    let cutoff = now_ms() - HISTORY_DAYS * 86_400_000;
    list.as_array().into_iter().flatten().filter(|h| h["at"].as_i64().unwrap_or(0) >= cutoff).cloned().collect()
}

#[tauri::command]
pub async fn fs_delete(app: AppHandle, st: S<'_>, targets: Vec<Target>, permanent: bool) -> Res<Vec<Value>> {
    let st = st.inner().clone();
    blocking(move || {
        st.deleting.fetch_add(1, Ordering::SeqCst);
        let r = delete_inner(&app, &st, &targets, permanent);
        st.deleting.fetch_sub(1, Ordering::SeqCst);
        r
    })
    .await
}

fn delete_inner(app: &AppHandle, st: &AppState, targets: &[Target], permanent: bool) -> Res<Vec<Value>> {
    let _ = st.info(false); // protected paths want the drive list; without it they fall back to the built-in ones
    let info = st.cached_info();
    let (paths, owner) = expand_targets(targets, info.as_ref());
    let mut results: Vec<Value> = targets
        .iter()
        .map(|t| {
            let protected = !t.contents_only && platform::is_protected(&t.path, info.as_ref());
            if protected {
                json!({ "path": t.path, "ok": false, "remaining": -1, "errors": 0, "error": "Protected system location", "protected": true })
            } else {
                json!({ "path": t.path, "ok": true, "remaining": 0, "errors": 0, "error": null, "protected": false })
            }
        })
        .collect();
    if !paths.is_empty() {
        let list = std::env::temp_dir().join(format!("strata-delete-{}.txt", now_ms()));
        std::fs::write(&list, paths.join("\n")).map_err(|e| e.to_string())?;
        let index: HashMap<&str, usize> = paths.iter().enumerate().map(|(i, p)| (p.as_str(), i)).collect();
        let args = vec![
            "delete".into(),
            list.to_string_lossy().into_owned(),
            (if permanent { "permanent" } else { "recycle" }).into(),
        ];
        let run = scanner::run(
            st.scanner()?,
            &args,
            |msg, _| match msg["type"].as_str() {
                Some("progress") => {
                    let _ = app.emit(
                        "fs:progress",
                        json!({ "done": msg["done"], "total": msg["total"], "current": msg["current"] }),
                    );
                }
                Some("result") => {
                    let Some(&i) = msg["path"].as_str().and_then(|p| index.get(p)) else { return };
                    if msg["ok"].as_bool().unwrap_or(false) {
                        return;
                    }
                    let r = &mut results[owner[i]];
                    r["ok"] = json!(false);
                    r["errors"] = json!(r["errors"].as_i64().unwrap_or(0) + 1);
                    r["remaining"] =
                        json!(r["remaining"].as_i64().unwrap_or(0) + msg["remaining"].as_i64().unwrap_or(0));
                    if r["error"].is_null() {
                        r["error"] = msg["error"].clone();
                    }
                }
                _ => {}
            },
            |_| {},
        );
        let _ = std::fs::remove_file(&list);
        run?;
    }
    // History: what went where, for the 7-day list in Settings › History.
    let now = now_ms();
    let mut hist = prune_history(&store::read_json(&st.history_file(), json!([])));
    for (i, t) in targets.iter().enumerate() {
        let r = &results[i];
        if r["protected"] == true {
            continue;
        }
        let left = r["remaining"].as_f64().unwrap_or(0.0).max(0.0);
        hist.insert(0, json!({
            "id": format!("{}-{}", base36(now as u64), i), "path": t.path, "name": t.name.clone().unwrap_or_else(|| file_name(&t.path)),
            "size": (t.size - left).max(0.0), "contentsOnly": t.contents_only, "permanent": permanent, "at": now, "ok": r["ok"],
        }));
    }
    hist.truncate(500);
    let _ = store::write_json(&st.history_file(), &Value::Array(hist));
    Ok(results)
}

#[tauri::command]
pub async fn fs_stat(path: String) -> Res<Value> {
    Ok(std::fs::metadata(path).map(|m| json!({ "isDir": m.is_dir(), "size": m.len() })).unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn fs_exists(path: String) -> Res<bool> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub async fn shell_show(app: AppHandle, path: String) -> Res<()> {
    let p = Path::new(&path);
    if p.exists() {
        app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
    } else {
        app.opener().open_path(p.parent().unwrap_or(p).to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn shell_open(app: AppHandle, path: String) -> Res<()> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Opens a web page in the browser. Only http(s) links, so release notes can't launch anything else.
#[tauri::command]
pub async fn shell_open_url(app: AppHandle, url: String) -> Res<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clipboard_write(app: AppHandle, text: String) -> Res<()> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dialog_folder(app: AppHandle) -> Res<Option<String>> {
    blocking(move || {
        let picked = app.dialog().file().set_title("Choose a folder to map").blocking_pick_folder();
        Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

// ───────────── history & restore ─────────────

/// Recycle Bin / Trash items that may be what a history entry deleted (the scanner reads $I or .trashinfo files).
fn in_bin(st: &AppState, h: &Value) -> Res<Vec<Value>> {
    let mut entries = Vec::new();
    let path = h["path"].as_str().unwrap_or("");
    scanner::run(
        st.scanner()?,
        &["trash-list".into(), path.into()],
        |msg, _| {
            if msg["type"] == "entry" {
                entries.push(msg);
            }
        },
        |_| {},
    )?;
    let want = platform::fold(path);
    let at = h["at"].as_i64().unwrap_or(0);
    let contents = h["contentsOnly"].as_bool().unwrap_or(false);
    Ok(entries
        .into_iter()
        .filter(|en| {
            let o = platform::fold(en["original"].as_str().unwrap_or(""));
            let hit = if contents {
                Path::new(&o).parent().map(|p| p.to_string_lossy() == want.as_str()).unwrap_or(false)
            } else {
                o == want
            };
            hit && (en["deletedAt"].as_i64().unwrap_or(0) - at).abs() < 10 * 60 * 1000
        })
        .collect())
}

#[tauri::command]
pub async fn history_list(st: S<'_>) -> Res<Vec<Value>> {
    let st = st.inner().clone();
    blocking(move || {
        let mut hist = prune_history(&store::read_json(&st.history_file(), json!([])));
        let _ = store::write_json(&st.history_file(), &Value::Array(hist.clone()));
        for h in hist.iter_mut() {
            let mut restorable = false;
            if h["permanent"] != true && h["restored"] != true {
                restorable = in_bin(&st, h).map(|e| !e.is_empty()).unwrap_or(false);
            }
            h["restorable"] = json!(restorable);
        }
        Ok(hist)
    })
    .await
}

#[tauri::command]
pub async fn history_restore(st: S<'_>, id: String) -> Res<usize> {
    let st = st.inner().clone();
    blocking(move || {
        let mut hist = store::read_json(&st.history_file(), json!([]));
        let h =
            hist.as_array().and_then(|a| a.iter().find(|x| x["id"] == id)).cloned().ok_or("Not found in history")?;
        let entries: Vec<Value> = in_bin(&st, &h)?
            .into_iter()
            .filter(|en| !Path::new(en["original"].as_str().unwrap_or("")).exists())
            .collect();
        if entries.is_empty() {
            return Err(format!("The item is no longer in the {}.", platform::bin_label()));
        }
        let list = std::env::temp_dir().join(format!("strata-restore-{}.txt", now_ms()));
        let infos: Vec<&str> = entries.iter().filter_map(|e| e["info"].as_str()).collect();
        std::fs::write(&list, infos.join("\n")).map_err(|e| e.to_string())?;
        let mut restored = 0;
        let run = scanner::run(
            st.scanner()?,
            &["restore".into(), list.to_string_lossy().into_owned()],
            |msg, _| {
                if msg["type"] == "result" && msg["ok"] == true {
                    restored += 1;
                }
            },
            |_| {},
        );
        let _ = std::fs::remove_file(&list);
        run?;
        if let Some(x) = hist.as_array_mut().and_then(|a| a.iter_mut().find(|x| x["id"] == id)) {
            x["restored"] = json!(true);
        }
        let _ = store::write_json(&st.history_file(), &hist);
        Ok(restored)
    })
    .await
}

#[tauri::command]
pub async fn history_clear(st: S<'_>) -> Res<()> {
    store::write_json(&st.history_file(), &json!([])).map_err(|e| e.to_string())
}

// ───────────── app ─────────────

#[tauri::command]
pub async fn app_info(st: S<'_>) -> Res<Value> {
    let st = st.inner().clone();
    blocking(move || {
        let admin = st.info(false).map(|i| i["admin"] == true).unwrap_or(false);
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        Ok(json!({
            "admin": admin, "version": st.version, "user": if platform::IS_WIN { env("USERNAME") } else { env("USER") },
            "home": if platform::IS_WIN { env("USERPROFILE") } else { env("HOME") }, "temp": std::env::temp_dir(),
            "platform": if platform::IS_WIN { "win32" } else { "linux" }, "portable": st.portable,
        }))
    })
    .await
}

#[tauri::command]
pub async fn drives_list(st: S<'_>, force: Option<bool>) -> Res<Value> {
    let st = st.inner().clone();
    blocking(move || Ok(st.info(force.unwrap_or(false))?["drives"].clone())).await
}

#[tauri::command]
pub async fn settings_get(st: S<'_>) -> Res<Value> {
    Ok(st.settings())
}

#[tauri::command]
pub async fn settings_set(st: S<'_>, patch: Value) -> Res<Value> {
    Ok(store::set_settings(&st.settings_file(), &st.version, &patch))
}

/// Relaunch elevated (for the MFT fast scan). The current instance quits once UAC is accepted.
#[tauri::command]
pub async fn relaunch_admin(app: AppHandle, pending: Option<Value>) -> Res<bool> {
    if !platform::IS_WIN {
        return Ok(false); // no file-table fast scan on Linux, and GUI apps shouldn't run as root
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let mut args: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with("--strata-")).collect();
        if let Some(p) = pending {
            args.push(format!("--strata-scan={}", base64::engine::general_purpose::STANDARD.encode(p.to_string())));
        }
        let arg_list = if args.is_empty() {
            String::new()
        } else {
            format!(" -ArgumentList {}", args.iter().map(|a| quote(&format!("\"{a}\""))).collect::<Vec<_>>().join(","))
        };
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let cwd = std::env::current_dir().unwrap_or_default();
        let cmd = format!(
            "Start-Process -FilePath {}{} -WorkingDirectory {} -Verb RunAs",
            quote(&exe.to_string_lossy()),
            arg_list,
            quote(&cwd.to_string_lossy())
        );
        let ok = blocking(move || {
            let status = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
                .creation_flags(0x0800_0000)
                .status()
                .map_err(|e| e.to_string())?;
            Ok(status.success())
        })
        .await?;
        if ok {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                app.exit(0);
            });
        }
        Ok(ok)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, pending, base64::engine::general_purpose::STANDARD);
        Ok(false)
    }
}

/// A scan requested before relaunching as admin.
#[tauri::command]
pub async fn pending_scan() -> Res<Value> {
    let arg = std::env::args().find_map(|a| a.strip_prefix("--strata-scan=").map(String::from));
    Ok(arg
        .and_then(|a| base64::engine::general_purpose::STANDARD.decode(a).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null))
}

// ───────────── startup ─────────────

fn data_dir(app: &tauri::App, portable: bool) -> PathBuf {
    if let Some(d) = std::env::var_os("STRATA_DATA_DIR") {
        return PathBuf::from(d);
    }
    if portable && let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        return dir.join("Strata Data");
    }
    // Same folder the Electron versions used, so settings, history and saved scans carry over.
    app.path().config_dir().unwrap_or_else(|_| std::env::temp_dir()).join("Strata")
}

fn allowed_navigation(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "tauri" | "about")
        || url.host_str() == Some("tauri.localhost")
        || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let portable = updates::is_portable();
            let data = data_dir(app, portable);
            let version = app.package_info().version.to_string();
            let state = Arc::new(AppState::new(data.clone(), version, portable, updates::Updates::new(app.handle())));
            app.manage(state.clone());
            updates::cleanup_old_executable();

            let cfg = app.config().app.windows[0].clone();
            let mut window = WebviewWindowBuilder::from_config(app.handle(), &cfg)?.on_navigation(allowed_navigation);
            if portable {
                // Keep the web view's own files next to the .exe too: nothing is left behind on the PC.
                window = window.data_directory(data.join("WebView"));
            }
            window.build()?;
            updates::start_background(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            relaunch_admin,
            pending_scan,
            drives_list,
            settings_get,
            settings_set,
            scan_start,
            scan_pause,
            scan_resume,
            scan_cancel,
            scan_snapshot,
            scan_load,
            scan_recent,
            scan_clear_recent,
            dupes_find,
            fs_delete,
            fs_stat,
            fs_exists,
            shell_show,
            shell_open,
            shell_open_url,
            clipboard_write,
            dialog_folder,
            history_list,
            history_restore,
            history_clear,
            updates::update_state,
            updates::update_check,
            updates::update_download,
            updates::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Strata");
}
