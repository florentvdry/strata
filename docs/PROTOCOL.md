# Scanner protocol

The contract between the Electron main process and the scanner (`strata-scan`, built from [`scanner/`](../scanner)). The UI never talks to the scanner directly.

- The main process starts one scanner process per job: `strata-scan <command> [arguments]`.
- The scanner writes **one JSON object per line** on stdout. Every message has a `type`.
- During a scan it reads **plain-text commands** on stdin, one per line.
- List files (for `dupes`, `delete`, `restore`) are UTF-8 text, one entry per line.
- Exit codes: `0` success, `1` error (an `error` message says why), `2` missing or unknown command.

The old scanners (`scanner/StrataScan.cs` on Windows, `scanner/linux/` on Linux) speak the same protocol, without `trash-list`, `restore` and `trashDirs`. They stay in the repository until 0.2.0 so CI can compare results ([`scripts/parity.js`](../scripts/parity.js)).

## `info`

Drives, whether the scanner runs as administrator (elevated on Windows, root on Linux), and where the Trash is.

```json
{"type":"info","admin":false,"trashDirs":[],"drives":[
  {"letter":"C","root":"C:\\","label":"Windows","fs":"NTFS","total":511101108224,"free":120395931648,
   "kind":"Fixed","bus":"NVMe","media":"SSD","cluster":4096,"system":true}]}
```

| Field | Windows | Linux |
|---|---|---|
| `letter` | `"C"` | `null` (the UI names drives by label or mount point) |
| `root` | `"C:\\"` | the mount point, `"/"`, `"/home"`, `"/run/media/me/USB"` |
| `label` | volume label | from `/dev/disk/by-label`, or `null` |
| `fs` | `NTFS`, `exFAT`, `FAT32`, `ReFS`… | `ext4`, `btrfs`, `xfs`, `ntfs3`, `sshfs`… |
| `kind` | `Fixed`, `Removable`, `Network`, `Ram`… | `Fixed`, `Removable`, `Network` |
| `bus` | `NVMe`, `SATA`, `USB`, `SD`, `Virtual`, `Network`, `Removable`… or `null` | `NVMe`, `SATA`, `SCSI`, `USB`, `SD`, `Virtual`, `Network` or `null` |
| `media` | `SSD`, `HDD`, `SCM` or `null` | `SSD`, `HDD` or `null` |
| `system` | holds `%SystemRoot%` | mounted at `/` |
| `trashDirs` | `[]` | `["/home/me/.local/share/Trash"]`: never deleted as a whole |

CD/DVD drives and drives that aren't ready are left out. On Linux, pseudo file systems (`proc`, `tmpfs`, `overlay`, `squashfs`…) and system mounts (`/boot`, `/snap`, container storage…) are left out; `/run/media/…` is kept.

## `scan <path> <out> [--mft] [--hidden] [--links]`

Scans a drive or folder and writes `<out>` (see [The scan file](#the-scan-file)), first as `<out>.part`, renamed when complete.

| Option | Meaning |
|---|---|
| `--mft` | Windows, as administrator, NTFS only: read the master file table instead of listing folders. Falls back to a folder walk with a `notice` otherwise. Ignored on Linux. |
| `--hidden` | Include hidden and system items (Windows attributes; names starting with `.` on Linux). |
| `--links` | Follow junctions and symbolic links to folders. Each target is entered once, never an ancestor. |

Messages:

```json
{"type":"progress","phase":"walk","files":1200,"dirs":85,"bytes":73400320,"errors":0,"pct":0.4127,
 "current":"C:\\Users\\me\\Videos","tops":[{"name":"Videos","dir":true,"bytes":70000000,"state":1,"type":1}],
 "biggest":[{"path":"Videos\\movie.mkv","size":70000000,"type":1}]}
{"type":"notice","message":"Fast scan needs administrator rights — using a normal scan."}
{"type":"snapshot","out":"C:\\…\\scans\\abc.partial.strata"}
{"type":"snapshot","error":"not ready"}
{"type":"done","out":"C:\\…\\scans\\abc.strata","partial":false,"method":"Walk"}
{"type":"error","message":"Folder not found: D:\\nope"}
```

- `progress` comes about every 180 ms. `phase` is `walk`, `mft`, `build` or `paused`. `pct` (0–1) only moves forward: bytes found over bytes used for a whole drive, finished top-level items otherwise.
- `tops` are the scanned folder's direct children, for the map building up: `state` 0 pending, 1 active, 2 done; `type` is the dominant file type. `biggest` lists up to 5 files over 64 MB, with paths relative to the scanned folder.
- `done.method` is `MFT` or `Walk`; `done.partial` is true after `stop`.

Commands on stdin:

| Command | Effect |
|---|---|
| `pause` / `resume` | Pauses and resumes; progress says `paused` meanwhile. |
| `stop` | Finishes now: writes what was found, `partial: true`. |
| `snapshot <file>` | Writes the tree found so far to `<file>` without stopping, then a `snapshot` message (this is *Explore partial results*). |

## `dupes <list>`

`<list>` holds `size<TAB>path` lines, grouped by size (candidates of the same size, found by the UI). Groups with the biggest potential savings go first. Each file is hashed on three 64 KB samples (start, middle, end), then in full up to 1 GB; bigger files are grouped on samples only. Stops after 4 minutes.

```json
{"type":"progress","done":104857600,"total":524288000}
{"type":"group","size":2097152,"verified":true,"paths":["/home/me/a.zip","/home/me/b.zip"]}
{"type":"done"}
```

## `delete <list> [recycle|permanent]`

Deletes each listed path. `recycle` (the default) sends items to the Recycle Bin (Windows, in batches, with Windows' own warning when something is too big to recycle) or to the freedesktop.org Trash (Linux). `permanent` deletes recursively and removes links without following them.

```json
{"type":"progress","done":0,"total":2,"current":"C:\\Users\\me\\AppData\\Local\\Temp\\x"}
{"type":"result","path":"C:\\Users\\me\\AppData\\Local\\Temp\\x","ok":false,"remaining":4096,"error":"Some files are in use or protected"}
{"type":"done"}
```

`remaining` is how many bytes are still there when `ok` is false.

## `trash-list [path]`

Items in the Recycle Bin or the Trash that could have come from `path`: the Recycle Bin of its drive on Windows; the home Trash plus the Trash of the path's drive on Linux.

```json
{"type":"entry","info":"C:\\$Recycle.Bin\\S-1-5-21-…\\$IAB12CD.txt","data":"C:\\$Recycle.Bin\\S-1-5-21-…\\$RAB12CD.txt","original":"C:\\Users\\me\\notes.txt","deletedAt":1793097384000}
{"type":"done"}
```

`info` is the metadata file (`$I…`, `….trashinfo`), `data` the item itself, `deletedAt` Unix milliseconds.

## `restore <list>`

`<list>` holds `info` paths from `trash-list`. Each item goes back to where it came from, unless something already exists there.

```json
{"type":"result","info":"/home/me/.local/share/Trash/info/docs.trashinfo","path":"/home/me/docs","ok":true,"error":null}
{"type":"result","info":"…","path":null,"ok":false,"error":"Something already exists at the original location"}
{"type":"done"}
```

## The scan file

A compact binary format; the UI maps its sections straight into typed arrays (`src/renderer/lib/tree.js`). Little-endian.

```
"STRATA01"                        8 bytes
int32 headerLength
header (UTF-8 JSON)               version, root, fs, cluster, total, free, method, scannedAt (ms),
                                  duration (s), partial, files, dirs (without the root), errors, bytes,
                                  options { mft, hidden, links }
zero padding to 8 bytes
int32 N, int32 0
float64[N]  size                  file sizes (folders are 0, summed by the UI)
float64[N]  mtime                 Unix seconds
int32[N]    parent                -1 for the root; always smaller than the node's own index
uint8[N]    flags                 1 dir · 2 hidden · 4 system · 8 reparse/link/mount point · 16 access denied · 32 cloud-only
uint8[N]    type                  0 other · 1 video · 2 app · 3 system · 4 image · 5 archive · 6 code · 7 audio · 8 doc
int32 namesLength
names (UTF-8, NUL-separated)      the root's name is the full scanned path
```

How sizes are counted:

- **Windows:** logical size; cloud placeholders (OneDrive "online-only") count 0 and get flag 32. The fast scan shows a hard-linked file once, under one of its names.
- **Linux:** the allocated size when it's smaller than the length (sparse files), and a hard-linked file counts once (its other names count 0). Other file systems mounted inside the scanned folder are listed with flag 8 and not entered. Symbolic links that aren't followed have type 0.
