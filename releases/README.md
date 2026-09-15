# Pre-built `.vsix` releases

For orgs where `npm install` itself is blocked (registry access restrictions), these are
pre-built `.vsix` files you can install directly. **Always use the newest one** — install:

```bash
code --install-extension releases/contextprune-spike-0.0.1-2026-09-15-02ecf40.vsix
```

or via **Extensions view → `...` menu → Install from VSIX...** and point it at the file.

## Trust model — please read before installing a binary you didn't build

This is a **binary artifact built by Claude** (an AI assistant) on the developer's own
machine, from the exact source in this repo — not a reproducible CI build, not signed, not
published anywhere official. Treat it accordingly:

- **Prefer building it yourself** once you have any npm access at all (even a one-time
  connection, or an internal registry mirror) — see [`../spike/README.md`](../spike/README.md).
  This file exists only for the "I genuinely cannot run npm install at all" case.
- **Verify what's inside.** A `.vsix` is just a zip:
  ```bash
  unzip -o contextprune-spike-0.0.1-2026-09-15-d673893.vsix -d /tmp/cpv-check
  cat /tmp/cpv-check/extension/package.json   # matches spike/package.json?
  ```
  `extension/out/extension.js` is the compiled output of `spike/src/extension.ts` — to verify
  it byte-for-byte, `git checkout` the commit below, run `npm ci && npm run compile` yourself,
  and diff your `spike/out/extension.js` against the one inside the zip.
- **Checksum + provenance for each release** are recorded below — confirm the SHA-256 before
  installing anything from this folder.

## Releases

Newest first — install the top row unless you have a specific reason to use an older one.

| File | Built from commit | Date (UTC) | SHA-256 |
|---|---|---|---|
| `contextprune-spike-0.0.1-2026-09-15-02ecf40.vsix` | [`02ecf40`](https://github.com/gauravdotanand-a11y/ContextPrune/commit/02ecf40) | 2026-09-15 | `89f90c17fc97111c4ef10db72a0f9294d5a7cc91ab6d5dbe0b414a2adba751bd` |
| `contextprune-spike-0.0.1-2026-09-15-d673893.vsix` | [`d673893`](https://github.com/gauravdotanand-a11y/ContextPrune/commit/d673893) | 2026-09-15 | `31063035901e35b54467a97688d9d6e0dba7d5fe0460155130eb25289e15ff6e` |

**What changed in `02ecf40`:** adds the Activity Bar icon + sidebar view (previous release
had none), and the three real interventions — `applyTerseInstructions`, `addLeanMode`,
`reviewOpenTabs` — that actually edit files in your workspace instead of only measuring. If
you installed `d673893` and only see diagnostics/benchmark/dashboard with no Activity Bar
icon and no "Reduce tokens now" buttons, you're on the old one — reinstall from the newer file
(installing over the old extension id upgrades it in place).

Verify on your machine before installing:

```bash
shasum -a 256 releases/contextprune-spike-0.0.1-2026-09-15-02ecf40.vsix
```

Built with `@vscode/vsce@^3`, Node v20.15.0, `vsce package --no-dependencies`. This is the
**spike** (Phase 0 de-risking extension), not the production ContextPrune extension — see
[`../Plans.md`](../Plans.md) for what it actually does and doesn't do.
