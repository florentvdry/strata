# Changelog

All notable changes to Strata are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0-beta.1] - 2026-10-27

### Changed

- **Strata now runs on Tauri instead of Electron.** It uses the web view already on your system (WebView2 on Windows, WebKitGTK on Linux), so the downloads are a few megabytes instead of a bundled browser (the Linux AppImage, which carries its own web view, is about 80 MB), and it starts faster and uses less memory. The look and every feature are the same.
  - **Windows:** needs the WebView2 runtime. It is already part of Windows 11 and of up-to-date Windows 10; the installer adds it if it is missing. The portable build is still a single `.exe`, and keeps everything (including the web view's files) in a `Strata Data` folder next to it.
  - **Linux:** the `.deb`, `.rpm` and `.pacman` packages depend on `webkit2gtk-4.1` and `gtk3` (Ubuntu 22.04+, Debian 12+, Fedora, Arch). The AppImage and `.tar.gz` no longer need `--no-sandbox` on Ubuntu 24.04.
  - Right-click menus are drawn by Strata itself, and dropped folders are read natively.
- **One scanner for Windows and Linux, in Rust** (`scanner/`), instead of a C# scanner for Windows and a JavaScript one for Linux, which are removed. Same commands, messages and scan file, so scans saved by 0.1.0 still open.
  - Faster: about 6× on Linux on a folder of 200,000 files.
  - Static binaries: no Visual C++ runtime needed on Windows, and one Linux build (musl) for every distribution.
  - Bus and SSD/HDD come from the storage driver instead of WMI.
  - Restoring from History asks the scanner, which now lists and restores Recycle Bin / Trash items itself.
  - Files whose names aren't valid UTF-8 are now counted on Linux (the old scanner skipped them).
- Updated Preact to 11.

### Added

- **Strata speaks 16 languages**: English, Chinese (Simplified), Hindi, Spanish, Arabic, French, Portuguese, Russian, German, Japanese, Korean, Italian, Turkish, Dutch, Polish and Indonesian. It follows your system language; change it in Settings › Language. Dates and numbers follow the language too.
- **Updates, only when you want them.** Settings › Updates checks github.com once a day if you allow it (Strata asks the first time), or when you press *Check now*. Nothing about you or your files is sent, and nothing installs without your say.
  - Updates are verified with a signature before they are installed. Choose the Stable or Beta channel.
  - Works for the Windows installer, the **Windows portable `.exe`** (replaced in place), the Linux AppImage and the `.deb` / `.rpm` packages (Linux asks for your password). Other builds are told when a new version exists and open the download page.
  - An *Update to x.y.z* button appears on the start screen with the release notes of the new version.
- **What's new.** After an update, Strata shows what changed since the version you last ran. All release notes are in Settings › Updates.
- **Linux support** for the common x64 distributions, packaged as AppImage, `.deb` (Ubuntu, Debian, Mint…), `.rpm` (Fedora, RHEL, openSUSE…), `.pacman` (Arch, Manjaro…) and `.tar.gz`, all built in CI.
  - Linux scanning: mounted drives with bus, SSD/HDD and labels, a multi-threaded walk that stays on one file system, counts hard links once and sparse files by what they use.
  - Deleting goes to the freedesktop.org Trash, which History can restore from.
  - Linux cleanup rules: `~/.cache`, thumbnails, `/tmp` and `/var/tmp`, core dumps, APT/DNF/YUM/Pacman/Zypper package caches, Linux browser profiles and `.deb`/`.rpm`/AppImage installers in Downloads.
  - Linux paths, drive names and wording (Trash, file manager) throughout the UI; the Windows-only fast scan and admin restart are hidden.
- Every release now comes with `SHA256SUMS.txt`, and the website has a [changelog page](https://florentvdry.github.io/strata/changelog) and an RSS feed.

### Fixed

- The window could stay blank if the app finished loading its data before the screen had subscribed to it.

### Internal

- Faster CI: pull requests build a debug binary without installers (the smoke test still runs), a new push cancels the previous run, docs-only changes skip the build, and fuzzing runs only when `scanner/` changes (and weekly) in its own workflow.
- `CHANGELOG.md` is the single source of release notes: `npm run release -- <version>` moves Unreleased under the new version and bumps every version number; the notes feed the GitHub release, the update manifest, the app's *What's new* and the website. CI checks the format. See [docs/RELEASING.md](docs/RELEASING.md).
- A release workflow (tag `v*`) builds, signs and publishes Windows and Linux files and the update manifests (`latest.json`, plus a `channel-beta` manifest for the Beta channel). Pre-releases have no `.rpm` (RPM versions can't contain `-`); Fedora users take the AppImage until the final release.
- Preact and htm are vendored in `src/renderer/vendor/` (`npm run vendor` refreshes them); the Content-Security-Policy now lives in `tauri.conf.json`.
- `npm run test:app` (Rust tests of the app: settings, protected locations, the portable file swap) and `npm run test:scripts` (changelog and manifest tooling).
- The screenshot script runs the UI in Chromium with a stand-in for the app bridge instead of driving Electron.
- `npm run test:scanner`, run in CI on Windows and Linux, checks the scanner against a temporary folder tree: scans, pause, snapshot, stop, duplicates, Recycle Bin / Trash, restore.
- Scanner tests in CI: unit tests, the NTFS fast scan on disk images (made with `mkntfs`/`ntfs-3g`), a fast scan vs. folder walk comparison on a real `C:`, and fuzzing of the NTFS reader. Before the old scanners were removed, CI also checked that the Rust one gives the same results, item by item.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the scanner's commands, messages and scan file.

## [0.1.0] - 2026-10-27

First public release.

### Added

- **Start screen:** every ready drive with bus and media type, file system, used/free space and a low-space warning. Folder picker, drag-and-drop anywhere, remembered scan options, and the last 8 scans saved for instant reopening.
- **Scanner:**
  - Multi-threaded folder walk with long-path support.
  - **Fast scan** that reads the NTFS master file table directly (administrator rights), with an offer to restart elevated and resume.
  - Optional hidden/system files, and junction and symlink following with loop protection.
- **Scanning screen:** live percentage, time estimate, counters, a map of top-level folders that fills in, and the biggest files so far. Pause, resume and cancel. *Explore partial results* while the scan continues, refreshed in place when it finishes. Progress also shows on the taskbar button.
- **Explorer:**
  - Treemap (cushion-shaded), sunburst and columns views with hover, select, zoom and a right-click menu.
  - Breadcrumb, folder tree in sync with the map, file-type legend that can highlight a type, and a details panel with a mini-map for folders.
  - Keyboard shortcuts.
- **Search** with name terms, globs, size filters and `type:`.
- **Smart views:** largest files, content-verified duplicates, untouched for 1 year, caches & temp, dev artifacts.
- **Cleanup review:**
  - Categorised suggestions with reasons and Safe/Review badges, select-all, a live "you'll free" total and the drive after cleanup.
  - Recycle Bin by default, or permanent deletion.
  - Protected system locations, cache folders emptied rather than removed, and files in use reported.
- **History:** 7-day log of removals, with restore from the Recycle Bin.
- **Settings:** accent color, cushion shading, restart as administrator, clear recent scans.
- Windows installer (per-user) and a single-file portable version that keeps its data next to the `.exe`.

[Unreleased]: https://github.com/florentvdry/strata/compare/v0.2.0-beta.1...HEAD
[0.2.0-beta.1]: https://github.com/florentvdry/strata/compare/v0.1.0...v0.2.0-beta.1
[0.1.0]: https://github.com/florentvdry/strata/releases/tag/v0.1.0
