# ContextPrune

A VS Code extension to minimize GitHub Copilot token usage — designed to run inside
locked-down enterprise environments (restricted network, no telemetry, `.vsix`-only
distribution).

**Status:** planning + Phase 0 spike. Nothing production-ready yet.

- [**Plans.md**](Plans.md) — the full design doc: cost model, API research, feature set,
  enterprise constraints, roadmap, and decisions made so far.
- [**spike/**](spike/) — a throwaway extension that de-risks the VS Code APIs the plan depends
  on (`vscode.lm`, chat participants, tab enumeration, Copilot settings, custom chat modes).
  See [spike/README.md](spike/README.md) to run it.

## Try the spike

```bash
cd spike
npm install
npm run compile
```

Open `spike/` in VS Code, press **F5**, then run **"ContextPrune Spike: Run API Diagnostics"**
from the Command Palette in the Extension Development Host window.
