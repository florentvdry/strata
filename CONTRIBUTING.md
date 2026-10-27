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

Requirements: Windows 10/11 or Linux, Node.js 20+ (22+ for `npm run screenshots`), Git, and [Rust](https://rustup.rs) (on Windows with the Visual Studio Build Tools; on Linux with `rustup target add x86_64-unknown-linux-musl`, `musl-tools`, and WebKitGTK 4.1 and GTK 3 with their development files). See [Building from source](README.md#building-from-source).

```bash
git clone https://github.com/florentvdry/strata.git
cd strata
npm install
npm start
```

`npm start` builds the scanner (`scanner/`, Rust) when its sources changed, then runs the app with `tauri dev` (the first build compiles Tauri and takes a few minutes). Right-click › Inspect opens the web inspector in debug builds. The UI is plain files, so after changing one, restart the app (`npm start`) to see it.

## How the code is organised

| Path | What's there |
|---|---|
| `scanner/src/` | The scanner process (Rust): protocol, scan file, folder walk, duplicate finder, deletion. |
| `scanner/src/platform/` | What differs between Windows and Linux: folder listing, drives, Recycle Bin / Trash. |
| `scanner/src/mft/` | The NTFS fast scan (Windows), tested on disk images in `scanner/tests/fixtures/`. |
| `src/app/platform.rs` | Wording and protected locations that differ between Windows and Linux in the app. |
| `src/renderer/lib/platform.js` | Path separator, case-sensitivity and wording that differ between Windows and Linux. |
| `src/app/` | The app (Rust): window, spawning the scanner, files, settings, history, updates. `commands.rs` has one command per `window.strata` call. |
| `src/renderer/bridge.js` | The only bridge between the UI and the system (`window.strata`). |
| `scripts/changelog.js`, `scripts/package-release.js` | Release tooling: see [docs/RELEASING.md](docs/RELEASING.md). |
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
- **No telemetry, and no network unless the person asked for it.** Strata works offline. The only network call is the update check (Settings › Updates), which is off until they say yes and sends nothing about them. It lives in `src/app/updates.rs`; the UI itself can't reach the network (see the CSP in `tauri.conf.json`).

## Testing your change

The scanner has automated tests: `npm run test:rust` (unit tests, including the NTFS fast scan on disk images) and `npm run test:scanner` (the built scanner against a temporary folder tree). CI also checks that the NTFS fast scan matches a folder walk on a real `C:` (`npm run check:fast-scan`) and fuzzes the NTFS reader (`cargo +nightly fuzz run mft_record` in `scanner/`). There's no automated UI test suite yet, so please check the rest by hand. A good minimum:

1. `npm run check` if you touched dependencies, `src/renderer/index.html` or the changelog. The UI loads Preact and htm from `src/renderer/vendor/` through an import map; `npm run vendor` refreshes the copies after you update the packages. `npm run test:app` and `npm run test:scripts` run the app's and the release tooling's tests.
2. `npm start`, then scan a small folder and a drive. Try both normal and, if you can, fast scan as administrator.
3. Exercise what you touched: the map views, search, smart views, cleanup selection.
4. For deletion changes, use a throwaway folder: recycle, delete permanently, a file that's in use, a path longer than 260 characters.
5. `npm run build` (Windows) or `npm run build:linux`, then run `node scripts/smoke-test.js` (on Linux without a display: `xvfb-run -a node scripts/smoke-test.js`): it starts the built app on a small folder and waits for the scan.

If your change affects how a screen looks, run `npm run screenshots` and commit the updated images.

## Commits and pull requests

- Keep pull requests focused: one fix or feature per PR.
- Write commit messages in the imperative, with a short summary line: `Add sunburst labels for the second ring`. [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`fix:`, `feat:`, `docs:`) are welcome but not required.
- Update [CHANGELOG.md](CHANGELOG.md) under **Unreleased**: user-visible changes under Added / Changed / Fixed (these become the release notes in the app, on the website and on GitHub), CI, tests and tooling under **Internal**. CI asks for an entry when a PR changes `src/` or `scanner/src/` (label it `no-changelog` when there is nothing to say).
- Fill in the pull request template, including how you tested.

## Releasing (maintainers)

`npm run release -- <version>` moves the changelog's Unreleased notes under the new version and bumps every version number; merge that, then tag the merge commit (`git tag v<version> && git push origin v<version>`). The Release workflow builds, signs and publishes everything. The full steps, and the one-time signing setup, are in [docs/RELEASING.md](docs/RELEASING.md).
