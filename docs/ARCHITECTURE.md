# Architecture

Strata has three parts: a small **scanner** process that touches the disk, the Electron **main process** that orchestrates it, and the **UI** that turns a scan into maps and cleanup suggestions.

The scanner has two implementations that speak the same protocol and write the same scan file: `scanner/StrataScan.cs` on Windows and `scanner/linux/` on Linux (see [Linux scanner](#linux-scanner-scannerlinux)). The main process and the UI only differ in small platform details: the path separator, case-sensitivity, drive names, and Recycle Bin vs. Trash.

```mermaid
flowchart LR
  subgraph UI["Renderer (sandboxed)"]
    V["Views<br/>Start · Scanning · Explorer · Cleanup"]
    S[("Store")]
    T["Tree model<br/>lib/tree.js"]
    M["Space map<br/>treemap · sunburst · columns"]
    C["Cleanup rules<br/>lib/cleanup.js"]
    V --> S
    S --> T
    T --> M
    T --> C
  end
  P["preload.js<br/>window.strata"]
  subgraph Main["Main process"]
    IPC["IPC handlers<br/>scans · files · settings · history"]
  end
  subgraph Scanner["StrataScan.exe"]
    W["Folder walk"]
    MFT["NTFS MFT reader"]
    D["Duplicate finder"]
    X["Recycle / delete"]
  end
  Disk[("Disk")]
  V <--> P <--> IPC
  IPC <-- "JSON lines + stdin commands" --> Scanner
  Scanner --> Disk
  IPC -- "scan file (.strata)" --> T
```

## Scanner (`scanner/StrataScan.cs`)

A console program written in C# 5 so the .NET Framework compiler built into Windows can build it. It has four commands:

| Command | Purpose |
|---|---|
| `info` | Drives (label, file system, size, free space, cluster size) plus bus and media type from the Storage WMI provider, and whether the process is elevated. |
| `scan <path> <out> [--mft] [--hidden] [--links]` | Scans a drive or folder and writes a `.strata` file. |
| `dupes <list>` | Given same-size candidate files, finds byte-identical groups. |
| `delete <list> [recycle\|permanent]` | Deletes paths and reports what is left of each. |

### Talking to the main process

The scanner writes **JSON lines** to stdout and reads plain-text **commands** from stdin.

- During a scan, a `progress` message goes out about 5 times per second: phase, counters, current path, estimated fraction done, the top-level items with their state (pending, active, done) and dominant file type, and the biggest files so far.
- `notice` reports a fallback, such as fast scan → normal scan. `done` and `error` end the scan.
- Commands: `pause`, `resume`, `stop` (finish now with partial results) and `snapshot <file>`. A snapshot writes the current partial tree without stopping; this is what *Explore partial results* uses.

### Folder walk

A pool of worker threads takes folders from a shared stack. Each folder is listed once with `FindFirstFileExW` (large fetch, basic info), which returns sizes, attributes and times without opening every file. Paths longer than 260 characters use the `\\?\` prefix.

- Junctions and symlinks are listed but not entered, unless *Follow* is on. Then the target is resolved with `GetFinalPathNameByHandle`, and each target is entered once and never when it's an ancestor.
- Cloud placeholders (OneDrive "online-only" files) count as 0 bytes, since they don't use local space.

### NTFS MFT reader (fast scan)

With administrator rights, the scanner opens the volume (`\\.\C:`) and reads the master file table directly:

1. The boot sector gives the cluster size, the MFT position and the record size.
2. Record 0 (`$MFT`) gives the MFT's own data runs, including any continued through an `$ATTRIBUTE_LIST`.
3. All records are read sequentially in 1 MB chunks. Each record is checked (`FILE` signature and update-sequence fixups), then parsed:
   - `$STANDARD_INFORMATION` gives attributes and modification time.
   - `$FILE_NAME` gives the parent and name; Win32 names win over DOS 8.3 names.
   - The unnamed `$DATA` attribute gives the logical size, which may come from an extension record.
4. Parent references are linked into a tree, which is walked depth-first from the root (or from the scanned folder) to produce nodes in parent-before-child order.

If anything fails (not NTFS, no rights, an unexpected structure), the scanner reports a `notice` and falls back to the folder walk.

### The `.strata` scan file

A compact binary format. The UI can map its sections straight into typed arrays.

```
"STRATA01"                        8 bytes
int32 headerLength                header JSON: root, fs, cluster, total, free, method,
header (UTF-8 JSON)               scannedAt, duration, partial, files, dirs, bytes, options
zero padding to 8 bytes
int32 N, int32 0
float64[N]  size                  file sizes (folders are 0, summed by the UI)
float64[N]  mtime                 Unix seconds
int32[N]    parent                -1 for the root; always smaller than the node's own index
uint8[N]    flags                 1 dir · 2 hidden · 4 system · 8 reparse · 16 access denied · 32 cloud-only
uint8[N]    type                  0 other · 1 video · 2 app · 3 system · 4 image · 5 archive · 6 code · 7 audio · 8 doc
int32 namesLength
names (UTF-8, NUL-separated)
```

Saved scans live in the data folder (`scans/`), alongside an `index.json` of recent scans.

## Linux scanner (`scanner/linux/`)

Plain JavaScript (`strata-scan.js`), run by the Node.js built into Electron: the main process spawns its own executable with `ELECTRON_RUN_AS_NODE=1`. Nothing is compiled, so the same files work on every distribution. Packaged builds ship them in `resources/scanner/`. Commands, messages and the `.strata` file are the same as on Windows; `--mft` is accepted and ignored.

- **`info`** lists the mounted file systems from `/proc/self/mountinfo`. Pseudo file systems (proc, sysfs, tmpfs, overlay, squashfs…) and system mounts (`/boot`, `/snap`, container storage…) are left out; drives mounted under `/run/media` are kept. Sizes come from `statfs`; bus, SSD/HDD and removable come from `/sys/class/block` (through partitions, LVM and LUKS to the disk), labels from `/dev/disk/by-label`. `admin` means running as root. Drives have `letter: null`; the UI names them by label or mount point.
- **`scan`** keeps the folder walk's structure (a stack of folders, depth-first, parents before children), but folders are listed by a pool of worker threads with blocking `readdir` + `lstat`, which is several times faster than a promise per file while still reading several folders at once. The main thread builds the node columns, the progress, the snapshots and the stdin commands.
  - It stays on one file system: other mount points inside the scanned folder are listed (as links) but not entered, so `/proc`, `/sys` and other drives aren't counted.
  - Hidden means a name starting with `.`. Symlinks are links: not followed unless *Follow* is on, and then each target folder (by device and inode) is entered once.
  - Hard-linked files count once, and a file counts its allocated size when that's smaller than its length (sparse files).
- **`delete`** moves items to the **freedesktop.org Trash** (`trash.js`): the home Trash (`~/.local/share/Trash`) when the item is on the same file system, otherwise `$topdir/.Trash/$uid` or `$topdir/.Trash-$uid` on the item's own drive. A `.trashinfo` file with the original path and date is written first, as the spec asks. Permanent deletion removes links without following them.
- **Restore** (main process) reads those `.trashinfo` files to find where an item came from, then moves it back.

## Main process (`src/main/`)

- Creates the window (sandboxed renderer, context isolation, no Node in the UI) and exposes a narrow API through `preload.js`.
- Starts the scanner for scans, duplicates and deletions, forwards progress to the UI, and mirrors scan progress on the taskbar button.
- Keeps settings, recent scans and the 7-day history as small JSON files. Writes go to a temporary file first, then get renamed.
- **Deletion:** targets are expanded (a "contents only" target, such as a temp folder, becomes its children), protected paths are refused, and the scanner does the work:
  - **Recycle Bin:** `SHFileOperation` in batches, with a warning if something is too big to recycle.
  - **Permanent:** a recursive delete that removes links without following them.
- **Restore:** reads the Recycle Bin's `$I` metadata files to find where an item came from, then moves the matching `$R` file back.
- **Restart as administrator:** relaunches through `Start-Process -Verb RunAs` and passes the pending scan along. Windows only: Linux has no file-table fast scan, and GUI apps shouldn't run as root.

## UI (`src/renderer/`)

Plain ES modules with [Preact](https://preactjs.com/) and [htm](https://github.com/developit/htm), and no build step.

- **`lib/store.js`:** one global store, plus a separate tiny store for the hovered item so mouse moves don't re-render the whole screen.
- **`lib/tree.js`:** loads a `.strata` file into typed arrays and builds:
  - folder sizes and file counts (one backwards pass, which works because parents come first),
  - each folder's children sorted by size,
  - per-folder bytes by file type, used to color folders by their dominant type.
  
  After a deletion, nodes are removed and every ancestor's numbers are updated.
- **`components/layouts.js`:** the three canvas layouts.
  - The **treemap** uses the squarified algorithm and only goes as deep as blocks stay visible; anything smaller merges into its folder's block.
  - The cushion shading is a single unit-square radial gradient, stretched per block with a canvas transform.
  - The **sunburst** and **columns** layouts share the same hit-testing and outline contract.
- **`components/map.js`:** two stacked canvases. The base holds the layout; the overlay draws hover and selection, so mouse moves never repaint the map.
- **`lib/cleanup.js`:** suggestion rules by folder name, location and age. It tracks which nodes are already covered so nothing is suggested twice, and selection totals never count a nested item twice.
- **`lib/search.js`:** parses queries (`*.mkv >1 GB type:video`) and searches the zoomed folder.

## Screenshots

`scripts/screenshots/` builds a made-up drive (`demo-data.mjs`, deterministic), launches the app against a throwaway data folder, loads the demo scan, and captures each screen through the Chrome DevTools Protocol. Run it with `npm run screenshots`.
