//! Updates. Strata only talks to the network when the person said yes (Settings › Updates) or asks to check.
//!
//! One download per update, verified with the minisign key in tauri.conf.json, then installed the way that
//! fits how Strata was installed:
//!   installer  Windows setup (NSIS): the setup runs, the app restarts
//!   portable   Windows single .exe: the file is swapped in place, then the app restarts
//!   appimage   Linux AppImage: the file is replaced
//!   package    Linux .deb / .rpm: installed with pkexec (a password prompt)
//!   manual     anything else (.tar.gz, pacman, development builds): opens the download page
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::AppState;
use crate::store;

const REPO: &str = "https://github.com/florentvdry/strata";
const CHECK_EVERY_MS: i64 = 24 * 3600 * 1000;
/// Passed to the program an update starts, so it can wait for the old one to quit.
const UPDATED_FLAG: &str = "--strata-updated";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// idle, checking, uptodate, available, downloading, ready, installing, error
    pub phase: String,
    pub mode: String,
    pub configured: bool,
    pub current: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
}

pub struct Updates {
    state: Mutex<UpdateState>,
    found: Mutex<Option<Arc<Update>>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

impl Updates {
    pub fn new(app: &AppHandle) -> Self {
        let state = UpdateState {
            phase: "idle".into(),
            mode: mode().into(),
            configured: configured(app),
            current: app.package_info().version.to_string(),
            ..Default::default()
        };
        Self { state: Mutex::new(state), found: Mutex::new(None), bytes: Mutex::new(None) }
    }

    fn snapshot(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, app: &AppHandle, f: impl FnOnce(&mut UpdateState)) -> UpdateState {
        let s = {
            let mut s = self.state.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = app.emit("update:state", &s);
        s
    }
}

/// The signing key was filled in (see docs/RELEASING.md); until then updates are switched off.
fn configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.is_empty() && !k.starts_with("REPLACE"))
}

/// The single-file Windows build: not installed by the setup program (no uninstaller next to it).
pub fn is_portable() -> bool {
    if std::env::var_os("STRATA_PORTABLE").is_some_and(|v| v == "1") {
        return true;
    }
    if !cfg!(windows) || cfg!(debug_assertions) {
        return false;
    }
    std::env::current_exe().ok().and_then(|e| e.parent().map(|d| !d.join("uninstall.exe").exists())).unwrap_or(false)
}

pub fn mode() -> &'static str {
    use tauri::utils::config::BundleType;
    use tauri::utils::platform::bundle_type;
    if cfg!(debug_assertions) {
        // Development builds are updated by hand, unless a test forces a mode (see docs/RELEASING.md).
        return match std::env::var("STRATA_UPDATE_MODE").as_deref() {
            Ok("portable") => "portable",
            Ok("appimage") => "appimage",
            _ => "manual",
        };
    }
    if cfg!(windows) {
        if is_portable() {
            return "portable";
        }
        return match bundle_type() {
            Some(BundleType::Nsis | BundleType::Msi) => "installer",
            _ => "manual",
        };
    }
    match bundle_type() {
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Deb | BundleType::Rpm) => "package",
        _ => "manual",
    }
}

/// An update that has no file of the kind this build installs (a beta without a .rpm, say) can only be fetched by hand.
fn effective_mode(base: &'static str, url_path: &str) -> &'static str {
    let ends = |exts: &[&str]| exts.iter().any(|e| url_path.ends_with(e));
    let ok = match base {
        "installer" => ends(&[".exe", ".msi"]),
        "portable" => ends(&[".exe"]),
        "appimage" => ends(&[".AppImage", ".AppImage.tar.gz"]),
        "package" => ends(&[".deb", ".rpm"]),
        _ => true,
    };
    if ok { base } else { "manual" }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn endpoint(channel: &str) -> String {
    #[cfg(debug_assertions)]
    if let Ok(e) = std::env::var("STRATA_UPDATE_ENDPOINT") {
        return e; // for testing against a local server
    }
    // Releases marked "pre-release" are skipped by /latest/, so beta users read a manifest on a fixed tag
    // that every release (stable or beta) refreshes.
    if channel == "beta" {
        format!("{REPO}/releases/download/channel-beta/latest.json")
    } else {
        format!("{REPO}/releases/latest/download/latest.json")
    }
}

// ───────────── check ─────────────

pub async fn check(app: &AppHandle, st: &AppState, manual: bool) -> UpdateState {
    let u = &st.updates;
    let fail = |msg: String| {
        u.set(app, |s| {
            s.phase = "error".into();
            s.error = Some(msg);
        })
    };
    if !u.snapshot().configured {
        return fail("Updates aren't set up in this build.".into());
    }
    if matches!(u.snapshot().phase.as_str(), "checking" | "downloading" | "installing") {
        return u.snapshot();
    }
    u.set(app, |s| {
        s.phase = "checking".into();
        s.error = None;
    });
    let settings = st.settings();
    let channel = settings["updates"]["channel"].as_str().unwrap_or("stable").to_string();
    let url = match endpoint(&channel).parse::<tauri::Url>() {
        Ok(u) => u,
        Err(e) => return fail(e.to_string()),
    };
    let mut builder = match app.updater_builder().endpoints(vec![url]) {
        Ok(b) => b,
        Err(e) => return fail(e.to_string()),
    };
    if mode() == "portable" {
        builder = builder.target("windows-x86_64-portable");
    }
    let updater = match builder.build() {
        Ok(b) => b,
        Err(e) => return fail(e.to_string()),
    };
    let result = updater.check().await;
    let _ = store::set_settings(&st.settings_file(), &st.version, &json!({ "updates": { "lastCheck": now_ms() } }));
    match result {
        Ok(Some(update)) => {
            let skipped = settings["updates"]["skipped"].as_str() == Some(update.version.as_str());
            if skipped && !manual {
                return u.set(app, |s| s.phase = "uptodate".into());
            }
            let (version, notes) = (update.version.clone(), update.body.clone());
            let mode = effective_mode(mode(), update.download_url.path());
            *u.found.lock().unwrap() = Some(Arc::new(update));
            *u.bytes.lock().unwrap() = None;
            u.set(app, |s| {
                s.phase = "available".into();
                s.mode = mode.into();
                s.version = Some(version);
                s.notes = notes;
                s.downloaded = 0;
                s.total = 0;
            })
        }
        Ok(None) => u.set(app, |s| {
            s.phase = "uptodate".into();
            s.version = None;
            s.notes = None;
        }),
        Err(e) => fail(e.to_string()),
    }
}

/// Checks once a day when the person allowed it, a few seconds after start-up.
pub fn start_background(app: AppHandle, st: Arc<AppState>) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        loop {
            let u = st.settings()["updates"].clone();
            if u["check"] == true && now_ms() - u["lastCheck"].as_i64().unwrap_or(0) > CHECK_EVERY_MS {
                tauri::async_runtime::block_on(check(&app, &st, false));
            }
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

// ───────────── commands ─────────────

#[tauri::command]
pub async fn update_state(st: State<'_, Arc<AppState>>) -> Result<UpdateState, String> {
    Ok(st.updates.snapshot())
}

#[tauri::command]
pub async fn update_check(app: AppHandle, st: State<'_, Arc<AppState>>) -> Result<UpdateState, String> {
    Ok(check(&app, &st, true).await)
}

#[tauri::command]
pub async fn update_download(app: AppHandle, st: State<'_, Arc<AppState>>) -> Result<UpdateState, String> {
    let u = &st.updates;
    let Some(update) = u.found.lock().unwrap().clone() else { return Err("There is no update to download.".into()) };
    if u.snapshot().phase == "downloading" {
        return Ok(u.snapshot());
    }
    u.set(&app, |s| {
        s.phase = "downloading".into();
        s.error = None;
        s.downloaded = 0;
        s.total = 0;
    });
    let mut last = Instant::now();
    let mut done = 0u64;
    let result = update
        .download(
            |n, total| {
                done += n as u64;
                if last.elapsed() > Duration::from_millis(120) {
                    last = Instant::now();
                    let _ = app.emit("update:state", &{
                        let mut s = u.snapshot();
                        s.downloaded = done;
                        s.total = total.unwrap_or(0);
                        s
                    });
                }
            },
            || {},
        )
        .await;
    Ok(match result {
        Ok(bytes) => {
            *u.bytes.lock().unwrap() = Some(bytes);
            u.set(&app, |s| {
                s.phase = "ready".into();
                s.downloaded = s.total.max(done);
            })
        }
        Err(e) => u.set(&app, |s| {
            s.phase = "available".into();
            s.error = Some(e.to_string());
        }),
    })
}

#[tauri::command]
pub async fn update_install(app: AppHandle, st: State<'_, Arc<AppState>>) -> Result<(), String> {
    let st = st.inner().clone();
    let u = &st.updates;
    if u.snapshot().phase != "ready" {
        return Err("Download the update first.".into());
    }
    if st.scan_running() || st.deleting.load(Ordering::SeqCst) > 0 {
        return Err("Finish or cancel the current scan or cleanup first, then install the update.".into());
    }
    let (Some(update), Some(bytes)) = (u.found.lock().unwrap().clone(), u.bytes.lock().unwrap().take()) else {
        return Err("Download the update first.".into());
    };
    let mode = u.snapshot().mode;
    u.set(&app, |s| s.phase = "installing".into());
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        update.verify(&bytes).map_err(|e| e.to_string())?;
        match mode.as_str() {
            "portable" => {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                if cfg!(windows) && !bytes.starts_with(b"MZ") {
                    return Err("The downloaded file isn't a Windows program.".into());
                }
                swap_executable(&exe, &bytes)
                    .map_err(|e| format!("Strata couldn't replace its own file ({e}). Is the folder read-only?"))?;
                relaunch(&handle, &exe);
            }
            "installer" => {
                update.install(&bytes).map_err(|e| e.to_string())?; // the setup program quits the app itself
            }
            "appimage" => {
                update.install(&bytes).map_err(|e| e.to_string())?;
                match std::env::var_os("APPIMAGE") {
                    Some(path) => relaunch(&handle, Path::new(&path)),
                    None => handle.restart(),
                }
            }
            "package" => {
                update.install(&bytes).map_err(|e| e.to_string())?;
                handle.restart();
            }
            _ => return Err("This build is updated by hand: open the download page.".into()),
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if let Err(e) = &result {
        u.set(&app, |s| {
            s.phase = "available".into();
            s.error = Some(e.clone());
        });
    }
    result
}

fn relaunch(app: &AppHandle, exe: &Path) -> ! {
    // The flag tells the new process to wait until this one has really gone (see `cleanup_old_executable`).
    let _ = std::process::Command::new(exe).arg(UPDATED_FLAG).spawn();
    app.exit(0);
    std::process::exit(0)
}

// ───────────── portable swap ─────────────

/// Replaces the running program file with `bytes`. The old one is kept as `<name>.old` (a running .exe can be
/// renamed on Windows, not overwritten) and removed by the next start. Put back if anything fails.
pub fn swap_executable(exe: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let name = exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "strata".into());
    let new = exe.with_file_name(format!("{name}.new"));
    let old = exe.with_file_name(format!("{name}.old"));
    std::fs::write(&new, bytes)?;
    #[cfg(unix)]
    {
        if let Ok(m) = std::fs::metadata(exe) {
            let _ = std::fs::set_permissions(&new, m.permissions());
        }
    }
    let _ = std::fs::remove_file(&old);
    if let Err(e) = std::fs::rename(exe, &old) {
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&new, exe) {
        let _ = std::fs::rename(&old, exe);
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    Ok(old)
}

/// Removes the previous program file left by `swap_executable`. On Windows a running .exe can't be deleted, so the
/// file only goes once the old process has quit: a program started by an update (`--strata-updated`) waits for that
/// before it opens its window, so the two never share the web view's files. Other starts clean up in the background.
pub fn cleanup_old_executable() {
    let Ok(exe) = std::env::current_exe() else { return };
    let Some(name) = exe.file_name().map(|n| n.to_string_lossy().into_owned()) else { return };
    let old = exe.with_file_name(format!("{name}.old"));
    if !old.exists() {
        return;
    }
    let remove = move || {
        for _ in 0..30 {
            if std::fs::remove_file(&old).is_ok() || !old.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    };
    if std::env::args().any(|a| a == UPDATED_FLAG) {
        remove();
    } else {
        std::thread::spawn(remove);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_the_file_and_keeps_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("Strata-Portable.exe");
        std::fs::write(&exe, b"old version").unwrap();
        let old = swap_executable(&exe, b"new version").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new version");
        assert_eq!(std::fs::read(&old).unwrap(), b"old version");
        assert!(old.to_string_lossy().ends_with("Strata-Portable.exe.old"));
        assert!(!dir.path().join("Strata-Portable.exe.new").exists());
        // A second update replaces the leftovers of the first.
        swap_executable(&exe, b"newer").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"newer");
        assert_eq!(std::fs::read(&old).unwrap(), b"new version");
    }

    #[test]
    fn leaves_the_program_alone_when_it_cannot_write() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("missing-dir").join("strata.exe");
        assert!(swap_executable(&exe, b"x").is_err());
    }

    #[test]
    fn beta_and_stable_read_different_manifests() {
        assert!(endpoint("beta").contains("channel-beta"));
        assert!(endpoint("stable").contains("releases/latest/download"));
    }

    #[test]
    fn an_update_without_a_matching_file_is_fetched_by_hand() {
        assert_eq!(effective_mode("package", "/o/r/releases/download/v1/Strata-1-x86_64.rpm"), "package");
        assert_eq!(effective_mode("package", "/o/r/releases/download/v1/Strata-1-x86_64.AppImage"), "manual");
        assert_eq!(effective_mode("portable", "/x/Strata-1-Portable.exe"), "portable");
        assert_eq!(effective_mode("portable", "/x/Strata-Setup-1.exe.zip"), "manual");
        assert_eq!(effective_mode("manual", "/x/anything"), "manual");
    }

    #[test]
    fn mode_is_manual_in_development() {
        assert_eq!(mode(), "manual");
        assert!(!is_portable() || std::env::var_os("STRATA_PORTABLE").is_some());
    }
}
