// Generated from CHANGELOG.md by `npm run sync:changelog`. Don't edit.
export default [
  {
    "version": "0.2.0",
    "date": "2026-10-27",
    "prerelease": false,
    "summary": "",
    "sections": [
      {
        "title": "Fixed",
        "items": [
          {
            "text": "A finished scan no longer stays stuck on \"100%\": the map now opens as soon as the scan ends. If loading the results ever fails, Strata shows the error instead of freezing.",
            "children": []
          }
        ]
      }
    ]
  },
  {
    "version": "0.2.0-beta.1",
    "date": "2026-10-27",
    "prerelease": true,
    "summary": "",
    "sections": [
      {
        "title": "Changed",
        "items": [
          {
            "text": "**Strata now runs on Tauri instead of Electron.** It uses the web view already on your system (WebView2 on Windows, WebKitGTK on Linux), so the downloads are a few megabytes instead of a bundled browser (the Linux AppImage, which carries its own web view, is about 80 MB), and it starts faster and uses less memory. The look and every feature are the same.",
            "children": [
              "**Windows:** needs the WebView2 runtime. It is already part of Windows 11 and of up-to-date Windows 10; the installer adds it if it is missing. The portable build is still a single `.exe`, and keeps everything (including the web view's files) in a `Strata Data` folder next to it.",
              "**Linux:** the `.deb`, `.rpm` and `.pacman` packages depend on `webkit2gtk-4.1` and `gtk3` (Ubuntu 22.04+, Debian 12+, Fedora, Arch). The AppImage and `.tar.gz` no longer need `--no-sandbox` on Ubuntu 24.04.",
              "Right-click menus are drawn by Strata itself, and dropped folders are read natively."
            ]
          },
          {
            "text": "**One scanner for Windows and Linux, in Rust** (`scanner/`), instead of a C# scanner for Windows and a JavaScript one for Linux, which are removed. Same commands, messages and scan file, so scans saved by 0.1.0 still open.",
            "children": [
              "Faster: about 6× on Linux on a folder of 200,000 files.",
              "Static binaries: no Visual C++ runtime needed on Windows, and one Linux build (musl) for every distribution.",
              "Bus and SSD/HDD come from the storage driver instead of WMI.",
              "Restoring from History asks the scanner, which now lists and restores Recycle Bin / Trash items itself.",
              "Files whose names aren't valid UTF-8 are now counted on Linux (the old scanner skipped them)."
            ]
          },
          {
            "text": "Updated Preact to 11.",
            "children": []
          }
        ]
      },
      {
        "title": "Added",
        "items": [
          {
            "text": "**Strata speaks 16 languages**: English, Chinese (Simplified), Hindi, Spanish, Arabic, French, Portuguese, Russian, German, Japanese, Korean, Italian, Turkish, Dutch, Polish and Indonesian. It follows your system language; change it in Settings › Language. Dates and numbers follow the language too.",
            "children": []
          },
          {
            "text": "**Updates, only when you want them.** Settings › Updates checks github.com once a day if you allow it (Strata asks the first time), or when you press *Check now*. Nothing about you or your files is sent, and nothing installs without your say.",
            "children": [
              "Updates are verified with a signature before they are installed. Choose the Stable or Beta channel.",
              "Works for the Windows installer, the **Windows portable `.exe`** (replaced in place), the Linux AppImage and the `.deb` / `.rpm` packages (Linux asks for your password). Other builds are told when a new version exists and open the download page.",
              "An *Update to x.y.z* button appears on the start screen with the release notes of the new version."
            ]
          },
          {
            "text": "**What's new.** After an update, Strata shows what changed since the version you last ran. All release notes are in Settings › Updates.",
            "children": []
          },
          {
            "text": "**Linux support** for the common x64 distributions, packaged as AppImage, `.deb` (Ubuntu, Debian, Mint…), `.rpm` (Fedora, RHEL, openSUSE…), `.pacman` (Arch, Manjaro…) and `.tar.gz`, all built in CI.",
            "children": [
              "Linux scanning: mounted drives with bus, SSD/HDD and labels, a multi-threaded walk that stays on one file system, counts hard links once and sparse files by what they use.",
              "Deleting goes to the freedesktop.org Trash, which History can restore from.",
              "Linux cleanup rules: `~/.cache`, thumbnails, `/tmp` and `/var/tmp`, core dumps, APT/DNF/YUM/Pacman/Zypper package caches, Linux browser profiles and `.deb`/`.rpm`/AppImage installers in Downloads.",
              "Linux paths, drive names and wording (Trash, file manager) throughout the UI; the Windows-only fast scan and admin restart are hidden."
            ]
          },
          {
            "text": "Every release now comes with `SHA256SUMS.txt`, and the website has a [changelog page](https://florentvdry.github.io/strata/changelog) and an RSS feed.",
            "children": []
          }
        ]
      },
      {
        "title": "Fixed",
        "items": [
          {
            "text": "The window could stay blank if the app finished loading its data before the screen had subscribed to it.",
            "children": []
          }
        ]
      }
    ]
  },
  {
    "version": "0.1.0",
    "date": "2026-10-27",
    "prerelease": false,
    "summary": "First public release.",
    "sections": [
      {
        "title": "Added",
        "items": [
          {
            "text": "**Start screen:** every ready drive with bus and media type, file system, used/free space and a low-space warning. Folder picker, drag-and-drop anywhere, remembered scan options, and the last 8 scans saved for instant reopening.",
            "children": []
          },
          {
            "text": "**Scanner:**",
            "children": [
              "Multi-threaded folder walk with long-path support.",
              "**Fast scan** that reads the NTFS master file table directly (administrator rights), with an offer to restart elevated and resume.",
              "Optional hidden/system files, and junction and symlink following with loop protection."
            ]
          },
          {
            "text": "**Scanning screen:** live percentage, time estimate, counters, a map of top-level folders that fills in, and the biggest files so far. Pause, resume and cancel. *Explore partial results* while the scan continues, refreshed in place when it finishes. Progress also shows on the taskbar button.",
            "children": []
          },
          {
            "text": "**Explorer:**",
            "children": [
              "Treemap (cushion-shaded), sunburst and columns views with hover, select, zoom and a right-click menu.",
              "Breadcrumb, folder tree in sync with the map, file-type legend that can highlight a type, and a details panel with a mini-map for folders.",
              "Keyboard shortcuts."
            ]
          },
          {
            "text": "**Search** with name terms, globs, size filters and `type:`.",
            "children": []
          },
          {
            "text": "**Smart views:** largest files, content-verified duplicates, untouched for 1 year, caches & temp, dev artifacts.",
            "children": []
          },
          {
            "text": "**Cleanup review:**",
            "children": [
              "Categorised suggestions with reasons and Safe/Review badges, select-all, a live \"you'll free\" total and the drive after cleanup.",
              "Recycle Bin by default, or permanent deletion.",
              "Protected system locations, cache folders emptied rather than removed, and files in use reported."
            ]
          },
          {
            "text": "**History:** 7-day log of removals, with restore from the Recycle Bin.",
            "children": []
          },
          {
            "text": "**Settings:** accent color, cushion shading, restart as administrator, clear recent scans.",
            "children": []
          },
          {
            "text": "Windows installer (per-user) and a single-file portable version that keeps its data next to the `.exe`.",
            "children": []
          }
        ]
      }
    ]
  }
];
