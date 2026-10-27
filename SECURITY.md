# Security policy

Strata reads your whole disk and can delete files, so security and data-safety reports are taken seriously.

## Supported versions

Only the latest release receives fixes.

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| older | ❌ |

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub instead:

1. Go to the repository's [**Security** tab](https://github.com/florentvdry/strata/security).
2. Click **Report a vulnerability** ([direct link](https://github.com/florentvdry/strata/security/advisories/new)).
3. Describe the issue, the affected version, and steps to reproduce. Include a proof of concept if you have one.

You should get a first answer within a few days. Once a fix is ready, it ships in a new release and the advisory is published with credit to you (unless you prefer to stay anonymous).

## What counts

Examples of things worth reporting:

- Strata deleting, or offering to delete, files outside what the user selected, or protected system locations.
- Deletion following a junction or symlink into another location.
- Ways for a crafted file name, path or scan file to run code or escape the renderer sandbox.
- Problems with the "restart as administrator" flow.

General bugs and wrong cleanup suggestions that don't put data at risk are better reported as regular [issues](https://github.com/florentvdry/strata/issues).
