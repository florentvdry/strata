# Contributing to Strata

Thanks for helping! This guide covers how to get set up, how the code is organised, and what a good pull request looks like.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug:** open an issue with the *Bug report* template. Include your Windows version or Linux distribution, the Strata version (shown in the footer and in Settings) and the steps to reproduce.
- **Suggest a feature:** open an issue with the *Feature request* template and describe the problem before the solution.
- **Improve cleanup rules:** if Strata misses a common cache or suggests something it shouldn't, that's very useful to know. Rules live in [`src/renderer/lib/cleanup.js`](src/renderer/lib/cleanup.js).
- **Send a pull request:** for anything bigger than a small fix, open an issue first so we can agree on the approach.

Security problems should **not** go in public issues. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Windows 10/11 or Linux, Node.js 20+ (22+ for `npm run screenshots`), Git, and [Rust](https://rustup.rs) (on Windows with the Visual Studio Build Tools; on Linux preferably with `rustup target add x86_64-unknown-linux-musl` and `musl-tools`). See [Building from source](README.md#building-from-source).

```bash
git clone https://github.com/florentvdry/strata.git
cd strata
npm install
npm start
```

`npm start` builds the scanner (`scanner/`, Rust) when its sources changed, then launches Electron. Press <kbd>F12</kbd> for DevTools and <kbd>Ctrl</kbd> + <kbd>R</kbd> to reload the UI.

If Electron didn't download during `npm install` (newer npm versions can block install scripts), run `node node_modules/electron/install.js`.

## How the code is organised

| Path | What's there |
|---|---|
| `scanner/src/` | The scanner process (Rust): protocol, scan file, folder walk, duplicate finder, deletion. |
| `scanner/src/platform/` | What differs between Windows and Linux: folder listing, drives, Recycle Bin / Trash. |
| `scanner/src/mft/` | The NTFS fast scan (Windows), tested on disk images in `scanner/tests/fixtures/`. |
| `src/main/platform.js` | Wording and protected locations that differ between Windows and Linux in the main process. |
| `src/renderer/lib/platform.js` | Path separator, case-sensitivity and wording that differ between Windows and Linux. |
| `src/main/` | Electron main process: window, spawning the scanner, files, settings, history, IPC. |
| `src/main/preload.js` | The only bridge between the UI and the system (`window.strata`). |
| `src/renderer/views/` | The four screens: Start, Scanning, Explorer, Cleanup. |
| `src/renderer/components/` | Space map (canvas layouts), dialogs, icons. |
| `src/renderer/lib/` | Scan file parser and tree model, search, cleanup rules, formatting, store. |
| `src/renderer/actions.js` | Everything the UI can do. Views call these. |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the data flow in more depth.

## Coding guidelines

- **Match the surrounding code.** Same naming, comment density and idioms. Comments explain *why*, not *what*.
- **No build step in the UI.** The renderer is plain ES modules with Preact + htm, loaded straight from disk. Don't add a bundler or transpiler.
- **htm templates need self-closing void tags.** Write `<input ... />`, not `<input ...>`.
- **The scanner is one program for both systems.** Shared code goes in `scanner/src/`; only what really differs goes in `platform/windows` or `platform/linux`, behind the same functions. A protocol or scan-file change also updates [docs/PROTOCOL.md](docs/PROTOCOL.md); a file-type change updates `src/renderer/lib/types.js` if the UI lists that extension (a test checks they agree). Never hard-code `\` in the UI: use `sep`, `fold` and friends from `lib/platform.js`.
- **Scanner code must not panic on bad input.** Everything read from the disk is bounds-checked. Run `cargo fmt`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in `scanner/` (CI does, on Windows and Linux). For the Windows code from Linux, `cargo clippy --target x86_64-pc-windows-gnu` catches most mistakes.
- **Keep the design.** Colors, spacing and type sizes come from the original mockups. Reuse the existing tokens (`--accent`, the gray scale, `Geist` / `Geist Mono`) rather than adding new ones.
- **Be careful with anything that deletes.** Changes to cleanup rules or deletion code need a clear reason and a manual test on throwaway files.
- **No network access and no telemetry.** Strata works offline and should stay that way.

## Testing your change

The scanner has automated tests: `npm run test:rust` (unit tests, including the NTFS fast scan on disk images) and `npm run test:scanner` (the built scanner against a temporary folder tree). CI also compares it with the scanner it replaced (`npm run parity`) and fuzzes the NTFS reader (`cargo +nightly fuzz run mft_record` in `scanner/`). There's no automated UI test suite yet, so please check the rest by hand. A good minimum:

1. `npm run check` if you touched dependencies or `src/renderer/index.html`. The UI loads Preact and htm through an import map protected by a CSP hash, and `node scripts/check-renderer.js --fix` updates that hash after you edit the map.
2. `npm start`, then scan a small folder and a drive. Try both normal and, if you can, fast scan as administrator.
3. Exercise what you touched: the map views, search, smart views, cleanup selection.
4. For deletion changes, use a throwaway folder: recycle, delete permanently, a file that's in use, a path longer than 260 characters.
5. `npm run pack` and run `dist/win-unpacked/Strata.exe` to make sure the packaged build works. On Linux: `npm run pack:linux` and run `dist/linux-unpacked/strata`.

If your change affects how a screen looks, run `npm run screenshots` and commit the updated images.

## Commits and pull requests

- Keep pull requests focused: one fix or feature per PR.
- Write commit messages in the imperative, with a short summary line: `Add sunburst labels for the second ring`. [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`fix:`, `feat:`, `docs:`) are welcome but not required.
- Update [CHANGELOG.md](CHANGELOG.md) under **Unreleased** for user-visible changes.
- Fill in the pull request template, including how you tested.

## Releasing (maintainers)

1. Update the version in `package.json` and move the **Unreleased** notes in `CHANGELOG.md` under the new version.
2. `npm run dist` on Windows builds `dist/Strata-Setup-<version>.exe` and `dist/Strata-<version>-Portable.exe`; `npm run dist:linux` on Linux builds the AppImage, `.deb`, `.rpm`, `.pacman` and `.tar.gz` (or take both sets from the CI artifacts).
3. Smoke-test them, commit, tag `v<version>`, push, and create a GitHub release with all the files and their SHA-256 checksums.
