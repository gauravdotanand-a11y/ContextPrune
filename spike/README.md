# ContextPrune — Phase 0 Spike

Throwaway extension. Its only job: **prove the risky APIs work in your org** before we
commit to the real design in [`../Plans.md`](../Plans.md).

It imports only `vscode` and makes **zero direct network calls**.

## What it checks

| # | Check | Why it matters |
|---|---|---|
| 1 | Runs in **Restricted Mode** (`untrustedWorkspaces: supported`) | Enterprise repos often open untrusted by default |
| 2 | `vscode.window.tabGroups` enumeration | This is the "neighboring tabs" signal we act on for inline completions |
| 3 | Reads `github.copilot.*` settings + scopes; detects Copilot extensions | Pillar 2 (contextual toggling) depends on it |
| 4 | `vscode.lm.selectChatModels()` — enumerates **every enabled model + family**; notes the API has no cost field | Whole chat pillar + `countTokens` + the multiplier table depend on this |
| 5 | `model.countTokens(string \| message)` vs a naive estimate | Our measurement ground truth |
| 6 | Custom chat mode / "custom agent" support (VS Code ≥ 1.102) | Whether we can ship the "ContextPrune Lean" mode now or must gate it |
| 7 | No outbound traffic from this extension | Air-gapped / tight-network requirement |

Plus a `@contextprune-spike` chat participant that counts your prompt's tokens live, and
`@contextprune-spike /callmodel <prompt>` which also does one real `sendRequest` round-trip
(that one uses Copilot quota).

## Beyond diagnostics: an Activity Bar icon, benchmark, dashboard, sign-in

Click the **ContextPrune icon in the Activity Bar** (the vertical icon strip on the far left,
same place GitLens/Docker/etc. put theirs) — no command needed. It opens a compact sidebar
view: your GitHub identity (once signed in), runs logged, avg. output-token change, est. $
saved, a per-project breakdown, and buttons to run another benchmark or open the full
dashboard as an editor tab.

| Command | What it does | Uses quota / network? |
|---|---|---|
| **ContextPrune Spike: Run Token-Savings Benchmark** | Sends 3 fixed tasks to the same live model twice (plain vs. a terse instruction), measures real `countTokens` on the real responses, saves the result locally. **Asks for confirmation first** — see [What data it sends](#what-data-it-sends) below. | Yes — 6 real Copilot requests, confirmed before sending |
| **ContextPrune Spike: Open Dashboard** | The full-size webview (editor tab): summary tiles, a by-project table, recent runs. Same data as the sidebar, more of it. Empty until you've run the benchmark at least once. | No |
| **ContextPrune Spike: Sign in with GitHub** | Personalizes both the sidebar and dashboard ("Hi \<name\>") via VS Code's **built-in** GitHub auth broker — `read:user` scope only, never repo/write access, never fires without you clicking it. Works with github.com/GHEC or GHES (`github-enterprise.uri`). Everything else works fully signed-out. | Only if you click it — via VS Code's own auth flow, not this extension |

### What data it sends

The benchmark sends **only** a small hardcoded sample function plus one of two fixed
instruction strings — never your real files, open tabs, or `copilot-instructions.md`. See
`SAMPLE_FUNCTION`, `BENCHMARK_TASKS`, and `LEAN_INSTRUCTION` at the top of
[`src/extension.ts`](src/extension.ts) for the exact literal text of every one of the 6 calls.

### Where results are stored

`contextprune-history.json` in this extension's global storage folder (VS Code's own
per-extension data directory on disk — not the workspace, not synced, not uploaded). Grouped
by project, which is currently just the first workspace folder's **name** (not yet a stable
id across clones).

## Run it (F5 path — no packaging)

```bash
cd spike
npm install
npm run compile
```

Then open this `spike/` folder in VS Code and press **F5** ("Run ContextPrune Spike").
In the new Extension Development Host window:

1. Open a few files (so check 2 has tabs to see).
2. Command Palette → **ContextPrune Spike: Run API Diagnostics**.
3. Read the **ContextPrune Spike** output channel.
4. Open Chat, type `@contextprune-spike hello world`.
5. Optionally: `@contextprune-spike /callmodel what is 2+2`.

## Run it as a `.vsix` (matches real deployment)

```bash
cd spike
npm install
npm run compile
npx --yes @vscode/vsce package --no-dependencies -o contextprune-spike.vsix
code --install-extension contextprune-spike.vsix
```

> In an air-gapped org, `vsce` and the npm deps must come from your internal registry/mirror.
> If sideloading is blocked by policy, that itself is a finding — note it.

## Offline test

Disconnect the network, re-run **Run API Diagnostics**. Expected: checks 1–3 pass, checks
4–5 fail *fast* (no multi-second hang). If VS Code hangs, that's a finding.

## Interpreting check 4 = EMPTY

Not necessarily broken. Ordered by likelihood in a managed org:

- Consent dialog was dismissed → re-run, accept it.
- Signed-in account has no Copilot entitlement/seat.
- Org policy disables the Language Model API for third-party extensions.
- Copilot Chat extension not installed / not signed in.
