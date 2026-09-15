# ContextPrune — Plan

A VS Code extension to **minimize token usage for GitHub Copilot**, designed to run inside a
locked‑down enterprise environment (restricted network, no third‑party telemetry, private
extension distribution).

Status: **research + planning**. Nothing built yet. This document is for us to agree on scope
and approach before writing code.

---

## 1. What "minimize token usage for Copilot" actually means

Under **usage‑based billing** (GitHub, from 2026‑06‑01) cost = *f(model, token type, token
count)*. The token *types* are not equal — widely reported figures:

| Token type | Relative cost |
|---|---|
| **Output tokens** | **~5× a fresh input token, ~50× a cached input token** — the dominant cost line |
| Fresh (uncached) input | baseline |
| **Cached input** | **~10× cheaper** than fresh input; Copilot hits **~94%** cache reuse in agentic Anthropic workloads |

So the priority order for saving money is:

1. **Produce fewer output tokens** (force terse answers / code‑only) — highest impact.
2. **Keep the prompt prefix cacheable** (don't switch models mid‑session, don't churn the
   instructions, don't let agent sessions idle > ~5 min) — a cache miss re‑bills the whole
   context as fresh input.
3. **Send fewer fresh input tokens** (scope context, prune history, trim instructions).
4. **Make fewer / cheaper requests** (prefer inline completions; lighter model for simple
   tasks; fewer tool round‑trips).

The three levers, and how much a 3rd‑party extension can move each:

| Lever | Can a 3rd‑party extension move it? |
|---|---|
| **Output volume** | **Indirectly but strongly** — via instructions files, a shipped custom mode, and our own participant's system prompt. |
| **Cache preservation** | **Indirectly** — advise/nudge on model switches, instructions churn, idle gaps; order our own prompts for prefix reuse. |
| **Input volume** | **Fully** for prompts we build; **indirectly** (context pool, tabs, exclusions) for the built‑in engine. |
| **Request count / model** | **Yes** for inline gating and our own calls; **nudge only** for built‑in chat. |

---

## 2. Hard reality check — what is and isn't possible

### GitHub Copilot inline completions (ghost text)

- Closed‑source; **no public API** to intercept/inspect/rewrite the prompt sent to
  `copilot-proxy.githubusercontent.com`.
- Context sources: active file around the cursor, **"neighboring tabs"**, recently viewed
  files, language, path, and (newer) workspace/symbol context.
- Inline completions are **cheap** — effectively not billed as premium requests and far
  cheaper than a chat turn. Encouraging their use *instead of* chat is itself an optimization.
- Indirect levers only: reduce open tabs, contextually disable Copilot (comments / generated /
  huge files / debugging), keep big/vendored files out via `files.exclude` + `search.exclude`
  + content exclusions, trim `copilot-instructions.md`.

### GitHub Copilot Chat (Ask / Agent / custom modes)

Public APIs we can build on:

- **Language Model API** (`vscode.lm`): `selectChatModels` (org‑gated, needs consent),
  `sendRequest`, **`countTokens`** (our measurement ground truth), `maxInputTokens`.
  **No cost / multiplier / cache field.**
- **Chat Participant API**: register **`@contextprune`** — builds its *own* minimal prompt
  (`request.prompt`, `request.model`, `context.history`). Runs in the **Ask‑style** flow only;
  **not** invoked inside Agent mode's loop.
- **Language Model Tools API** (`languageModelTools` + `registerTool`): the only real hook into
  **Agent mode** — tools the agent calls autonomously.
- **Custom modes / "custom agents"** (`.chatmode.md` → `.agent.md`): checked‑in file =
  instructions + `tools:` allowlist + `model:` preference. GA VS Code **1.102**.
- **`@vscode/prompt-tsx`**: budget‑aware prompt renderer — priority‑ordered pruning,
  `flexGrow`, `flexReserve`, `passPriority`, `TokenLimit`, `HTMLTracer`, **cache breakpoints**.

### What VS Code / Copilot already do (so we don't rebuild it)

The June 2026 token‑efficiency work is largely **already shipped** in VS Code + the Copilot
service. ContextPrune should *surface, default, and enforce* these — not reimplement them:

| Built‑in | What it does |
|---|---|
| Prompt caching + rolling cache breakpoints | ~94% reuse across agent turns (Anthropic); ~10× cheaper cached input |
| `prompt_cache_retention: "24h"` (OpenAI, service‑side) | Long cache retention across idle gaps |
| Tool‑search deferral / embedding‑guided tool selection | ~9–18% fewer tokens per session by not sending every tool schema |
| `/compact` | Summarizes older conversation to reclaim context window |
| ⌘N new chat / "fork conversation" | Drop stale history instead of re‑billing it every turn |
| "Configure Tools" button + custom‑agent `tools:` | Disable unused tools/MCP → less tool‑call output |
| Model picker cost tier (Low/Med/High) + per‑token cost | Cheap model choice at a glance |
| Hover a response → per‑request credit cost; context‑window control → session total | Native cost visibility |
| Agent Debug Logs → **Cache Explorer** | Actual cache hit rate + reused input tokens |
| Adaptive reasoning / default thinking effort | Avoids over‑spending on reasoning |

### Prior art — `VishwasNayak5.copilot-token-optimizer`

"Copilot Token Optimizer – Context & Prompt Advisor" (v3.9.6, Aug 2026, ~105 installs, no
public source repo, MS Marketplace only) is the closest existing tool. Worth knowing exactly
what it does and doesn't do:

| It does | It does **not** do |
|---|---|
| Activity‑bar sidebar ("🧠 Copilot Advisor"), `Ctrl/Cmd+Shift+J`; Context tab + Prompt Tips tab | **No measurement** — no `countTokens`, no token/HUD numbers, no cost or output/input/cache breakdown |
| Context flags: files > 500 lines, irrelevant tabs, verbose types (XML/YAML/lock/logs), stray test tabs, MCP overhead (~250 tok/request), recommends Ask/Agent/Edit | **No enforcement** — never toggles `github.copilot.enable`, never manages tabs, no shipped custom mode, no LM tool, no participant |
| Prompt linter: 12+ checks — filler, multi‑task, missing `#file:`, undefined output format, vague terms, ambiguous pronouns, missing stop conditions, unclear success criteria, mixed research/impl, unsafe agent config | **No output‑token discipline**, **no cache hygiene**, **no `copilot-instructions.md` budget** analysis |
| 100% local core; optional Ollama + Qwen‑2.5‑Coder‑7B for better prompt rewrites; "Open in Copilot Chat" sends the rewritten prompt | Optional 7B model download + Ollama = dead weight (or blocked) in a tight org; no source for security review; not a signed `.vsix` distribution |

**What we borrow:** its prompt‑check catalogue (feeds our Pillar 2 linter), the ~250‑tok/MCP‑tool
heuristic (Pillar 5), and the low‑friction **"rewrite prompt → Open in Copilot Chat"** command
(Pillar 2). **Where we differ:** measurement‑first (real `countTokens` + cost ledger), explicit
**output** and **cache** pillars, actual **enforcement** (toggles, tab management, shipped Lean
mode, LM tool + `@contextprune`), and hard enterprise fit (vsix‑only, zero telemetry, offline,
reviewable source). ContextPrune ⊃ this extension's advisory feature set.

### Net conclusion

> ContextPrune's job is **(1) make per‑mode, output‑vs‑input‑vs‑cache cost visible**,
> **(2) drive output volume down** (instructions + shipped lean mode + our participant),
> **(3) protect the prompt cache** (nudge on model switches / instructions churn / idle gaps),
> **(4) shrink inline context and cut wasted inline requests**, and **(5) an aggressively
> minimized Ask path we fully control**. It cannot shrink the built‑in inline/agent prompt or
> read GitHub's real billing.

---

## 3. Copilot Chat modes & model selection — where ContextPrune plugs in

| Mode | Token profile | What ContextPrune can do | Mechanism |
|---|---|---|---|
| **Ask** | Low–medium | **Full control** via `@contextprune` (retrieval not whole files, pruned history, terse‑output system prompt, cache‑aware model choice). Else: measure + lint. | participant; `prompt-tsx`; instructions lint |
| **Edit** (folding into Agent) | Medium | Advisory: warn on oversized working set; HUD total; `/trim`. | limited editor APIs, `/trim` |
| **Agent** | **Highest** — many round‑trips, tool calls, tool schemas, history re‑sent | Can't shrink its prompt. Can: contribute a **lean retrieval tool**; ship a **"Lean" custom mode** (minimal `tools:`, low‑cost `model:`, terse instructions); per‑turn cost meter; idle‑gap / model‑switch cache warnings. | `languageModelTools`, `.agent.md`, ledger |
| **Inline chat** (⌘I) | Low | Measure; suggest lighter model for trivial edits. | limited |
| **Custom mode / agent** | Configurable | **We ship "ContextPrune Lean"** — the main lever for output + tool + model discipline in built‑in chat. | `.chatmode.md` / `.agent.md` (≥ 1.102) |

### Model selection — and its tension with caching

- `selectChatModels()` returns only org‑enabled models; disabled ones never appear.
- `request.model` = the user's dropdown pick. **Default: respect it.**
- **Model downshift** (route trivial tasks to a cheaper model) is only a win at the **start of
  a fresh chat / isolated task**. Mid‑conversation it **invalidates the ~94% prompt cache**,
  re‑billing the whole context as fresh input — usually a net loss. So the feature must be
  **cache‑aware**: downshift only on a new conversation, otherwise just *advise*.
- No cost field in the API → ship a small admin‑overridable `model-multipliers.json`; unknown
  models show "cost unknown", never guessed. Prefer surfacing the **native** model‑picker cost
  tier over our own estimate.
- The shipped **"Lean" mode** pins `model:` — the one clean way to steer built‑in Agent model
  choice without fighting the user mid‑session.

---

## 4. Enterprise / tight‑environment constraints (design rules)

1. **No new outbound network calls.** All analysis local; only remote traffic is the
   already‑approved Copilot channel via `vscode.lm`. No third‑party servers or keys.
2. **Bundle a local tokenizer** for zero‑network estimates; use `countTokens` when a model +
   consent exist, else label output "estimated".
3. **No telemetry** — no telemetry code ships at all.
4. **Respect proxy settings**; ideally the extension makes **no** HTTP calls of its own.
5. **Never persist source code.** In‑memory analysis; reports carry counts + paths, never code.
6. **Minimal capabilities.** Narrow `activationEvents`; `untrustedWorkspaces: supported`;
   Node‑free deps so a web build stays possible.
7. **Distribution: signed `.vsix` only** (`code --install-extension` / `bootstrap/extensions`).
   No marketplace. Single self‑contained `.vsix`.
8. **Policy‑friendly.** Every behavior a lockable setting; never fight admin Copilot policy
   (model allowlist, content exclusions, LM‑API enablement).

---

## 5. Proposed feature set

### Pillar 1 — Measure (per‑mode, output/input/cache aware)

| Feature | Description | Deps |
|---|---|---|
| **Token HUD** | Status‑bar estimate of the inline "context footprint" (active file + open tabs + instructions). Click → per‑mode breakdown. | local tokenizer |
| **Cost ledger** | Local session tally split by **mode** and **token type** (output / fresh input / cached), using the ~5×/~50×/~10× ratios + the multiplier table. Export JSON/CSV. Points to native **Cache Explorer** / per‑response hover for ground truth. | `countTokens` |
| **Per‑file / selection lens** | CodeLens + command: token count for file / selection / symbol. | local tokenizer |
| **Instructions budget report** | Parse `copilot-instructions.md`, `*.instructions.md`, `*.agent.md`/`*.chatmode.md`, `AGENTS.md`; per‑file token cost, "paid every turn in every mode", verbosity + duplication flags, **missing‑brevity‑constraint** flag. | local tokenizer |

### Pillar 2 — Output discipline (highest $ impact)

| Feature | Description | Deps |
|---|---|---|
| **Terse‑output presets** | One command to add vetted brevity rules ("code only unless asked", "bullet points, no preamble/summary") to `copilot-instructions.md` and/or the shipped Lean mode. Diff preview. | — |
| **Participant output guard** | `@contextprune`'s own system prompt enforces code‑only / short‑answer; optional hard `maxOutputTokens`. | `vscode.lm` |
| **Prompt linter** | Rule catalogue (superset of the prior‑art tool's 12): filler / pleasantries, multi‑task prompt, missing `#file:` reference, undefined output format, vague terms, ambiguous pronouns, missing stop condition, unclear success criteria, mixed research + implementation, unsafe agent config, likely‑long answer. | local tokenizer |
| **Rewrite → Open in Chat** | One command: take the current selection / a scratch input, produce a compressed imperative version + estimated token delta, and open it in Copilot Chat (or hand to `@contextprune`). Low‑friction alternative to the participant. | local tokenizer |

### Pillar 3 — Cache hygiene (protect the ~94% reuse)

| Feature | Description | Deps |
|---|---|---|
| **Cache‑buster warnings** | Detect + warn on: model switch mid‑conversation, frequent instructions‑file edits during a session, agent sessions idling > ~5 min between turns (known cache‑expiry issue). Show the cost implication. | chat/session state |
| **Cache‑friendly prompt ordering** | For prompts we build: stable content (instructions, project facts) first, volatile content (question, selection) last; use `prompt-tsx` cache breakpoints. | `prompt-tsx` |
| **History hygiene nudge** | "This chat ≈ N turns / ~X history tokens re‑sent each turn — run `/compact` or start a new chat (⌘N)." Surfaces built‑ins, doesn't replace them. | chat history API |

### Pillar 4 — Reduce inline context & request count

| Feature | Description | Deps |
|---|---|---|
| **Smart tab manager** | Keep only *N* relevant editors (`contextprune.maxOpenTabs`, default 5); LRU + pin‑aware; Focus mode stashes/restores. | Tabs API |
| **Contextual Copilot toggling** | Scope `github.copilot.enable` / `editor.inlineSuggest.enabled` off for big / minified / generated files, non‑code langs, comment‑only regions, diff editors, active debug. | settings API |
| **Exclusion assistant** | Scan for large/vendored dirs; propose `files.exclude` + `search.exclude` + a draft content‑exclusion YAML; lint existing. | fs scan |
| **"Prefer completions" nudge** | When a chat request looks like something Tab completion / NES could do, gently say so. Onboarding covers it too. | heuristic |

### Pillar 5 — Curb Agent‑mode spend

| Feature | Description | Deps |
|---|---|---|
| **`contextprune_retrieve` tool** | Returns a minimal ranked de‑duplicated context slice so the agent avoids whole‑file reads / broad greps. | `languageModelTools`, `prompt-tsx` |
| **"ContextPrune Lean" custom mode** | Shipped `.agent.md`: terse instructions, minimal `tools:` allowlist, low‑cost `model:`. Version‑gated ≥ 1.102. | custom‑mode support |
| **Tool / MCP hygiene report** | List enabled tools + MCP servers with estimated schema‑token overhead (~250 tok/tool/request rule of thumb); recommend disabling unused; deep‑link to "Configure Tools". | tools API |
| **Run guardrails** | Warn when a working set or single agent run crosses a configurable token / step budget. | editor APIs, ledger |

### Pillar 6 — Govern

| Feature | Description |
|---|---|
| **Team profile** `.contextprune.json` (checked in) | Shared limits, exclusion lists, model ceilings, default mode, enabled rules. |
| **Policy‑lockable settings** | All namespaced + documented for central management. |
| **FinOps report** | Local Markdown/JSON usage summary — counts + paths only, no code. |

---

## 6. Architecture sketch

- **Language:** TypeScript. **Bundler:** `esbuild`. **No native modules.** Optional wasm tokenizer.
- **Modules:** `tokenizer/`, `context-model/` (inline footprint), `rules/` (toggle engine),
  `tabs/`, `chat/` (participant + tools + `prompt-tsx`), `modes/` (ship + lint the Lean mode),
  `models/` (`selectChatModels` wrapper + multiplier table + cache‑aware downshift), `cache/`
  (session‑state watchers for cache‑buster detection), `retrieval/` (lexical / TF‑IDF / symbol
  ranking, chunker, comment stripper), `report/` (ledger + FinOps), `config/`.
- **Activation:** `onStartupFinished`. Contributes: status bar, commands, chat participant, LM
  tools, a custom mode file, settings, CodeLens.
- **Testing:** `@vscode/test-electron`; unit tests for tokenizer parity, rule engine, retrieval
  ranking, multiplier lookup, cache‑buster detection; an **air‑gapped smoke test**.

---

## 7. Known limitations (state up front)

1. Cannot read/modify the built‑in **inline** or **chat/agent** prompt — only influence
   inputs, output constraints (via instructions/mode), request frequency, tools, and model.
2. **`@contextprune` is Ask‑only** — it does not run inside Agent mode's loop; Agent coverage
   is the contributed tools + the Lean mode.
3. Cannot read GitHub's **real** billing. Cost figures are **estimates** from local tokenizers
   + the reported ~5× / ~50× / ~10× ratios + a static multiplier table. Native **Cache
   Explorer** and per‑response hover cost are the ground truth we point users to.
4. **No cost / multiplier / cache field in the LM API.**
5. **Content exclusions** are admin‑only — we lint and draft, we don't apply.
6. `vscode.lm` needs **consent + entitlement**; without it only Measure + inline features work.
   `@contextprune` is **opt‑in**.
7. Cache‑buster detection is **heuristic** (from observable chat/session state), not a billing
   signal.
8. Lean custom mode needs VS Code **≥ 1.102**; hidden on older builds.
9. Undocumented `github.copilot.advanced.*` knobs — best‑effort only.

---

## 8. Phased roadmap

| Phase | Goal | Deliverable |
|---|---|---|
| **0 — Spike (~1 wk)** | De‑risk APIs | `countTokens`, `selectChatModels` (+ enumerate models), participant registration, `github.copilot.*` read, tab enumeration, custom‑mode detection — in Restricted Mode **and** offline. **Scaffolded → [`spike/`](spike/), compiles clean, `engines ^1.95.0`. Awaiting an org run (§10).** |
| **1 — Measure + Output discipline** | Visibility + the cheapest big win | Token HUD, cost ledger (per mode / token type), instructions budget report, per‑file lens, terse‑output presets, prompt linter. Local tokenizer. Ship `.vsix`. |
| **2 — Reduce inline** | Cut wasted inline requests | Smart tab manager, contextual toggling, exclusion assistant, "prefer completions" nudge. |
| **3 — Chat + cache + Agent** | Ask path, cache hygiene, Agent hooks | `@contextprune` participant, cache‑buster warnings, cache‑friendly ordering, history nudge, cache‑aware model downshift, `/trim` + `contextprune_retrieve` tools, "Lean" custom mode, tool/MCP hygiene report, `prompt-tsx`. |
| **4 — Govern** | Org rollout | Team profile, policy‑lockable settings, FinOps report, run guardrails, signed `.vsix` + silent‑install layout. |
| **5 — Polish** | Internal GA | Docs, onboarding (output discipline + Ask vs Agent + cache), Node‑free deps for a possible web build. |

---

## 9. Decisions (locked)

1. **Target surface:** both inline + chat (Ask + Agent). Phased, Measure first.
2. **Chat approach:** build both, end user chooses — `@contextprune` participant (opt‑in Ask
   path) **and** optimize built‑in via contributed tools + the "Lean" custom mode +
   instructions linting. Onboarding explains the trade‑off; nothing forced.
3. **Distribution:** signed `.vsix` only. No marketplace.
4. **Telemetry:** none.
5. **Engine:** `^1.95.0` core; the "Lean" mode feature activates only on **≥ 1.102** — confirm
   the org's deployed build.
6. **Content exclusions (open):** advisory‑only assumed (lint + draft), no admin dependency —
   confirm.

---

## 10. Phase 0 spike — org verification checklist

Run [`spike/`](spike/): `npm install && npm run compile`, **F5**, then **"ContextPrune Spike:
Run API Diagnostics"** → read the *ContextPrune Spike* output channel. It compiles clean here;
these need a run **inside the real org**:

| # | Check | How | Why it changes the plan |
|---|---|---|---|
| 1 | LM API returns Copilot models | check [4] `OK` / `EMPTY` | If policy blocks the LM API for extensions, the `@contextprune` pillar dies → tools + Lean mode + advice only. |
| 2 | Consent dialog appears & is acceptable | first run of [4] | Admin‑blocked consent = same as #1. |
| 3 | Which models are enabled + families | [4] model list | Feeds the multiplier table + downshift; are cheap `*-mini` models even available? |
| 4 | `.vsix` sideload allowed | `code --install-extension …` | Signature / `extensions.allowed` policy may need the org signing path first. |
| 5 | `countTokens` vs naive delta | [5] output | Whether a bundled offline tokenizer is trustworthy as fallback. |
| 6 | `github.copilot.advanced` + lock scope | [3] output | Which knobs are centrally managed vs. ours to set. |
| 7 | Custom mode support (≥ 1.102, "Configure Chat Modes") | [6] output | Ship the Lean mode now or gate it. |
| 8 | Content exclusions in effect | open large/vendored files | Advisory‑only OK, or org expects us to drive exclusions. |
| 9 | Restricted Mode default + spike still works | [1] says `RESTRICTED … works` | Confirms `untrustedWorkspaces: supported` suffices. |
| 10 | Offline behaviour | disconnect, re‑run | [1][2][3] pass; [4][5] fail *fast*. A hang is a Phase 1 bug. |
| 11 | Auth proxy | note `http.proxy` / `http.proxySupport` | Confirms the real extension needs zero HTTP of its own. |
| 12 | Deployed VS Code version | Help → About | Confirms `^1.95.0` and whether ≥ 1.102 features exist. |
| 13 | Native cost UI available | model picker cost tier? response‑hover cost? Agent Debug Logs → Cache Explorer? | If present, our ledger *links to* them instead of estimating; if stripped in the org build, our estimate matters more. |

---

## 11. Sources

- [Improving token efficiency for GitHub Copilot in VS Code — VS Code blog (Jun 2026)](https://code.visualstudio.com/blogs/2026/06/17/improving-token-efficiency-in-github-copilot)
- [Optimize your usage of premium requests — VS Code docs](https://code.visualstudio.com/docs/agents/guides/optimize-usage)
- [Decoding Copilot token costs using VS Code — Ken Muse](https://www.kenmuse.com/blog/decoding-copilot-token-costs-using-vs-code/)
- [VS Code curbs token use ahead of Copilot's usage-based billing switch — Visual Studio Magazine](https://visualstudiomagazine.com/articles/2026/04/30/vs-code-curbs-token-use-ahead-of-copilots-controversial-usage-based-billing-switch.aspx)
- [Getting more from each token: context handling and model routing — GitHub Blog](https://github.blog/ai-and-ml/github-copilot/getting-more-from-each-token-how-copilot-improves-context-handling-and-model-routing/)
- [Optimizing your AI usage to maximize efficiency and reduce cost — GitHub Docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/tutorials/optimize-ai-usage)
- [vscode#321551 — prompt cache expires during active agent sessions (> 5 min gap)](https://github.com/microsoft/vscode/issues/321551)
- [GitHub Copilot is moving to usage-based billing — GitHub Blog](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)
- [About premium requests / model multipliers — GitHub Docs](https://docs.github.com/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests)
- [Language Model API — VS Code](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [Chat Participant API — VS Code](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [Language Model Tool API — VS Code](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [Custom agents (formerly custom chat modes) — VS Code](https://code.visualstudio.com/docs/agent-customization/custom-agents)
- [Craft language model prompts (`@vscode/prompt-tsx`) — VS Code](https://code.visualstudio.com/api/extension-guides/ai/prompt-tsx)
- [microsoft/vscode-prompt-tsx (README)](https://github.com/microsoft/vscode-prompt-tsx/blob/main/README.md)
- [github-copilot-token-optimization (olivomarco)](https://github.com/olivomarco/github-copilot-token-optimization)
- [Prior art: Copilot Token Optimizer – Context & Prompt Advisor (VishwasNayak5)](https://marketplace.visualstudio.com/items?itemName=VishwasNayak5.copilot-token-optimizer)
- [Proxy server and firewall settings for Copilot — GitHub Docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/proxy-server-and-firewall-settings-for-copilot)
- [Manage extensions in enterprise environments — VS Code](https://code.visualstudio.com/docs/enterprise/extensions)
