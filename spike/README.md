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
