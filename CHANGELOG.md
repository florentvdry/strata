# Changelog

All notable changes to Strata are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **One scanner for Windows and Linux, in Rust** (`scanner/`), instead of a C# scanner for Windows and a JavaScript one for Linux, which are removed. Same commands, messages and scan file, so scans saved by 0.1.0 still open.
  - Faster: about 6× on Linux on a folder of 200,000 files, and it no longer runs inside Electron's Node.js.
  - Static binaries: no Visual C++ runtime needed on Windows, and one Linux build (musl) for every distribution.
  - Bus and SSD/HDD come from the storage driver instead of WMI.
  - Restoring from History asks the scanner, which now lists and restores Recycle Bin / Trash items itself (`trash-list`, `restore`).
  - Files whose names aren't valid UTF-8 are now counted on Linux (the old scanner skipped them).
- Updated Preact to 11. The UI now loads its ES module builds (`.mjs`).

### Added

- **Linux support** for the common x64 distributions, packaged as AppImage, `.deb` (Ubuntu, Debian, Mint…), `.rpm` (Fedora, RHEL, openSUSE…), `.pacman` (Arch, Manjaro…) and `.tar.gz`, all built in CI.
  - Linux scanning: mounted drives with bus, SSD/HDD and labels, a multi-threaded walk that stays on one file system, counts hard links once and sparse files by what they use.
  - Deleting goes to the freedesktop.org Trash, which History can restore from.
  - Linux cleanup rules: `~/.cache`, thumbnails, `/tmp` and `/var/tmp`, core dumps, APT/DNF/YUM/Pacman/Zypper package caches, Linux browser profiles and `.deb`/`.rpm`/AppImage installers in Downloads.
  - Linux paths, drive names and wording (Trash, file manager) throughout the UI; the Windows-only fast scan and admin restart are hidden.
- `npm run test:scanner`, run in CI on Windows and Linux, checks the scanner against a temporary folder tree: scans, pause, snapshot, stop, duplicates, Recycle Bin / Trash, restore.
- Scanner tests in CI: unit tests, the NTFS fast scan on disk images (made with `mkntfs`/`ntfs-3g`), a fast scan vs. folder walk comparison on a real `C:`, and fuzzing of the NTFS reader. Before the old scanners were removed, CI also checked that the Rust one gives the same results, item by item.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the scanner's commands, messages and scan file.
- `npm run check`, run in CI, verifies that every file in the UI's import map exists and that the Content-Security-Policy hash matches it. A mismatch would otherwise leave the window blank without any build error.

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

[Unreleased]: https://github.com/florentvdry/strata/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/florentvdry/strata/releases/tag/v0.1.0
