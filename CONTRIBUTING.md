# Contributing to Strata

Thanks for helping! This guide covers how to get set up, how the code is organised, and what a good pull request looks like.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug:** open an issue with the *Bug report* template. Include your Windows version, the Strata version (shown in the footer and in Settings) and the steps to reproduce.
- **Suggest a feature:** open an issue with the *Feature request* template and describe the problem before the solution.
- **Improve cleanup rules:** if Strata misses a common cache or suggests something it shouldn't, that's very useful to know. Rules live in [`src/renderer/lib/cleanup.js`](src/renderer/lib/cleanup.js).
- **Send a pull request:** for anything bigger than a small fix, open an issue first so we can agree on the approach.

Security problems should **not** go in public issues. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Windows 10/11, Node.js 20+ (22+ for `npm run screenshots`), Git.

```bash
git clone https://github.com/florentvdry/strata.git
cd strata
npm install
npm start
```

`npm start` compiles the scanner (`scanner/StrataScan.cs`) with the C# compiler included in Windows, then launches Electron. Press <kbd>F12</kbd> for DevTools and <kbd>Ctrl</kbd> + <kbd>R</kbd> to reload the UI.

If Electron didn't download during `npm install` (newer npm versions can block install scripts), run `node node_modules/electron/install.js`.

## How the code is organised

| Path | What's there |
|---|---|
| `scanner/StrataScan.cs` | The scanner process: folder walk, NTFS MFT reader, duplicate finder, deletion. |
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
- **The scanner targets C# 5.** It's compiled by the .NET Framework `csc.exe`, so no string interpolation, `?.`, expression-bodied members or tuples.
- **Keep the design.** Colors, spacing and type sizes come from the original mockups. Reuse the existing tokens (`--accent`, the gray scale, `Geist` / `Geist Mono`) rather than adding new ones.
- **Be careful with anything that deletes.** Changes to cleanup rules or deletion code need a clear reason and a manual test on throwaway files.
- **No network access and no telemetry.** Strata works offline and should stay that way.

## Testing your change

There's no automated UI test suite yet, so please check your change by hand. A good minimum:

1. `npm run check` if you touched dependencies or `src/renderer/index.html`. The UI loads Preact and htm through an import map protected by a CSP hash, and `node scripts/check-renderer.js --fix` updates that hash after you edit the map.
2. `npm start`, then scan a small folder and a drive. Try both normal and, if you can, fast scan as administrator.
3. Exercise what you touched: the map views, search, smart views, cleanup selection.
4. For deletion changes, use a throwaway folder: recycle, delete permanently, a file that's in use, a path longer than 260 characters.
5. `npm run pack` and run `dist/win-unpacked/Strata.exe` to make sure the packaged build works.

If your change affects how a screen looks, run `npm run screenshots` and commit the updated images.

## Commits and pull requests

- Keep pull requests focused: one fix or feature per PR.
- Write commit messages in the imperative, with a short summary line: `Add sunburst labels for the second ring`. [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`fix:`, `feat:`, `docs:`) are welcome but not required.
- Update [CHANGELOG.md](CHANGELOG.md) under **Unreleased** for user-visible changes.
- Fill in the pull request template, including how you tested.

## Releasing (maintainers)

1. Update the version in `package.json` and move the **Unreleased** notes in `CHANGELOG.md` under the new version.
2. `npm run dist`. This builds `dist/Strata-Setup-<version>.exe` and `dist/Strata-<version>-Portable.exe`.
3. Smoke-test both, commit, tag `v<version>`, push, and create a GitHub release with both files and their SHA-256 checksums.
