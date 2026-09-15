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
- No cost field in the API → ship a small admin‑overridable `model-pricing.json` keyed by
  family, storing **$/M‑token input / cached‑input / output** (usage‑based billing is priced
  per token per type, not a flat multiplier — see the confirmed seed table below). Unknown
  models show "cost unknown", never guessed. Prefer surfacing the **native** model‑picker cost
  tier over our own estimate.
- The output/cached ratio is **not a flat 5×/50×** — it varies by vendor (see below). Ship
  per‑family numbers, not one global constant.
- **Exclude internal/utility models** from anything user‑facing (downshift candidates, the
  model picker we build, the ledger's "you could have used X" suggestion): families like
  `copilot-utility`, `copilot-utility-small`, `copilot-dictation-cleanup-luna`, any entry with
  `maxInputTokens === 0`, or `vendor !== 'copilot'` are Copilot's own internal plumbing, not
  chat models a user would pick.
- The shipped **"Lean" mode** pins `model:` — the one clean way to steer built‑in Agent model
  choice without fighting the user mid‑session.

#### `model-pricing.json` — seed data (confirmed from a live org run + GitHub's pricing docs)

The spike's check [4] returned **19 models** (18 `vendor: 'copilot'`) from a real org on VS
Code 1.137.0 / Copilot Chat 0.65.0. Matched against GitHub's current per‑token pricing
($ / 1M tokens):

| Family | Input | Cached input | Output | Output ÷ input | Output ÷ cached |
|---|---|---|---|---|---|
| `gpt-5.6-luna` | $0.20 | $0.02 | $1.20 | 6× | 60× |
| `gpt-5-mini` | $0.25 | $0.025 | $2.00 | 8× | 80× |
| `gemini-3.7-flash` / `gemini-3.8-flash` | $0.75 | $0.075 | $3.75 | 5× | 50× |
| `gpt-5.4-mini` | $0.75 | $0.075 | $4.50 | 6× | 60× |
| `claude-haiku-4.5` | $1.00 | $0.10 | $5.00 | 5× | 50× |
| `gpt-5.3-codex` | $1.75 | $0.175 | $14.00 | 8× | 80× |
| `claude-sonnet-5` | $2.00 | $0.20 | $10.00 | 5× | 50× |
| `gpt-5.6-terra` | $2.00 | $0.20 | $12.00 | 6× | 60× |
| `gpt-5.6-sol` | $4.00 | $0.40 | $20.00 | 5× | 50× |
| `claude-opus-4.8` / `claude-opus-5` | $5.00 | $0.50 | $25.00 | 5× | 50× |
| `gpt-5.5` | $5.00 | $0.50 | $30.00 | 6× | 60× |

**Corrections to our earlier "output ≈5× input, ≈50× cached" rule of thumb:** it holds for
Anthropic, Gemini, and `gpt-5.6-sol`, but OpenAI's other families run **6–8× input / 60–80×
cached** — `gpt-5.3-codex` and `gpt-5-mini` are the most output‑expensive *relative to their
own input price*, which matters for Agent mode (which is output‑heavy). `gpt-4o-mini` — one of
the 18 returned by the API — **isn't in the current pricing table at all**; treat it as either
legacy/free or a fallback with unknown pricing, and flag it "cost unknown" rather than
guessing it's still the historical cheap option.

Also confirmed live: `maxInputTokens` varies far more than the docs' "GPT‑4o = 64K" figure
suggested — from **12,078** (`gpt-4o-mini`, `copilot-utility-small`) up to **~921K–982K**
(the flagship Claude/Gemini/GPT‑5.5+ families in this deployment). Don't hardcode a context‑size
assumption anywhere; always read `model.maxInputTokens` live.

> Source for prices: [github.com/…/models-and-pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) (usage‑based billing, not the legacy multiplier
> table — that page covers annual‑plan PRUs only and doesn't list most of these families).

---

## 4. Enterprise / tight‑environment constraints (design rules)

1. **No new outbound network calls.** All analysis local; only remote traffic is the
   already‑approved Copilot channel via `vscode.lm`. No third‑party servers or keys.
   **Named exception:** VS Code's **built‑in authentication broker**
   (`vscode.authentication.getSession('github' | 'github-enterprise', …)`, §6) — used only
   for the optional "Hi \<name\>" personalization, gated behind an explicit user‑clicked
   "Sign in" action, `read:user` scope only, and the extension never sees a password and
   never stores the token (VS Code's own secret storage holds it). Treated as an extension
   of the already‑trusted platform (the same broker Settings Sync / GitHub PRs use), not a
   new third‑party dependency — but it's the one place this rule is knowingly relaxed, so
   it's called out explicitly rather than silently expanded.
2. **Bundle a local tokenizer** for zero‑network estimates; use `countTokens` when a model +
   consent exist, else label output "estimated".
3. **No telemetry** — no telemetry code ships at all. (Locally‑stored benchmark/ledger history,
   §6, is not telemetry — it never leaves the machine and nothing reads it but the user.)
4. **Respect proxy settings**; ideally the extension makes **no** HTTP calls of its own.
5. **Never persist source code.** In‑memory analysis; reports carry counts + paths, never code.
   Persisted history (§6) stores only token counts, model ids, timestamps, and a project
   *name* — never file contents or prompts.
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
| **Cost ledger** | Local session tally split by **mode** and **token type** (output / fresh input / cached), priced via the confirmed per‑family `model-pricing.json` (§3). Export JSON/CSV. Points to native **Cache Explorer** / per‑response hover for ground truth. | `countTokens` |
| **Per‑file / selection lens** | CodeLens + command: token count for file / selection / symbol. | local tokenizer |
| **Instructions budget report** | Parse `copilot-instructions.md`, `*.instructions.md`, `*.agent.md`/`*.chatmode.md`, `AGENTS.md`; per‑file token cost, "paid every turn in every mode", verbosity + duplication flags, **missing‑brevity‑constraint** flag. | local tokenizer |

### Pillar 2 — Output discipline (highest $ impact)

| Feature | Description | Deps |
|---|---|---|
| **Terse‑output presets** | One command to add vetted brevity rules ("code only unless asked", "bullet points, no preamble/summary") to `copilot-instructions.md` and/or the shipped Lean mode. Diff preview. **✅ built in spike** (`applyTerseInstructions`). | — |
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
| **Smart tab manager** | Keep only *N* relevant editors (`contextprune.maxOpenTabs`, default 5); LRU + pin‑aware; Focus mode stashes/restores. **Reviewed‑close version ✅ built in spike** (`reviewOpenTabs` — lists real `countTokens` per tab, user picks what to close); the automatic LRU/Focus‑mode version is not built. | Tabs API |
| **Contextual Copilot toggling** | Scope `github.copilot.enable` / `editor.inlineSuggest.enabled` off for big / minified / generated files, non‑code langs, comment‑only regions, diff editors, active debug. **Detect either `GitHub.copilot` or `GitHub.copilot-chat`** — confirmed live that some orgs ship chat‑only, with completions folded into `copilot-chat`; don't assume the classic extension id exists. | settings API |
| **Exclusion assistant** | Scan for large/vendored dirs; propose `files.exclude` + `search.exclude` + a draft content‑exclusion YAML; lint existing. | fs scan |
| **"Prefer completions" nudge** | When a chat request looks like something Tab completion / NES could do, gently say so. Onboarding covers it too. | heuristic |

### Pillar 5 — Curb Agent‑mode spend

| Feature | Description | Deps |
|---|---|---|
| **`contextprune_retrieve` tool** | Returns a minimal ranked de‑duplicated context slice so the agent avoids whole‑file reads / broad greps. | `languageModelTools`, `prompt-tsx` |
| **"ContextPrune Lean" custom mode** | Shipped `.agent.md`: terse instructions, minimal `tools:` allowlist, low‑cost `model:`. Version‑gated ≥ 1.102. **✅ built in spike** (`addLeanMode`, writes `.github/agents/contextprune-lean.agent.md`; model pinned via the `contextprune.leanMode.model` setting since every org's model list differs). | custom‑mode support |
| **Tool / MCP hygiene report** | List enabled tools + MCP servers with estimated schema‑token overhead (~250 tok/tool/request rule of thumb); recommend disabling unused; deep‑link to "Configure Tools". | tools API |
| **Run guardrails** | Warn when a working set or single agent run crosses a configurable token / step budget. | editor APIs, ledger |

### Pillar 6 — Govern

| Feature | Description |
|---|---|
| **Team profile** `.contextprune.json` (checked in) | Shared limits, exclusion lists, model ceilings, default mode, enabled rules. |
| **Policy‑lockable settings** | All namespaced + documented for central management. |
| **FinOps report** | Local Markdown/JSON usage summary — counts + paths only, no code. |

---

## 6. Proving savings — measurement methodology, benchmark, dashboard, branding

This is the piece that makes ContextPrune *worth installing*, not just correct: a
skeptical org needs to **see** a number, trust where it came from, and see it again over
time. "Trust me, I counted tokens" isn't enough — so this section is explicit about what
we can prove, how, and with what caveats.

### Why we can't just show "you saved $X" from day one

- The LM API gives us **no billing data** — only `countTokens` on prompts *we* construct.
  We never see the actual bill for the built‑in inline/chat/agent engine.
- GitHub does expose an **org‑level Copilot usage/billing REST API** to admins, but it
  needs an admin PAT and org‑admin cooperation — a bigger, separate ask, not something the
  extension can quietly call (would also violate the "no new outbound calls by default"
  rule). Treated as an **optional, opt‑in Phase 4** correlation source, never a dependency.
- VS Code's own **native** cost surfaces (per‑response hover credit cost, the model‑picker
  cost tier, Agent Debug Logs → Cache Explorer) *are* ground truth, but they're rendered
  UI, not an API — we can't scrape them. We point users at them; we don't fake reading them.

So credible proof has to be built from **three legs**, not one invented number:

| Leg | What it is | Confidence | When |
|---|---|---|---|
| **A. Benchmark mode** | A small, fixed, repeatable set of real dev tasks, run twice through the **same model** in the user's **own org** — once "vanilla" (no brevity instruction), once "ContextPrune‑style" (terse instruction framing) — measuring real `countTokens` on the real responses. | High for the *isolated instruction‑discipline effect*; doesn't capture caching/model‑downshift/Agent‑mode savings. | Available **now** — added to the spike this session (see below). |
| **B. Production ledger, tagged with/without** | Every interaction ContextPrune observes (its own participant/tool calls, plus the inline "context footprint" estimate) logged locally with a flag: were ContextPrune's interventions active for this interaction. Aggregated over real usage, not a synthetic test. | Medium — real usage, but our own token estimate, and task mix isn't controlled. | Phase 1 (dashboard ships with it). |
| **C. Org billing correlation** (optional) | An admin pastes in (or points at) actual org Copilot usage numbers periodically; the dashboard overlays them against Leg B's estimate to show "our estimate tracked real spend within Y%." | Highest, but requires admin participation and is opt‑in only. | Phase 4, never required. |

**For an initial showcase to your org, Leg A (benchmark) is the right one to lead with** —
it's reproducible, uses your org's real models and real pricing, and doesn't require
weeks of production data first.

### Benchmark mode — added to the spike this session

New command: **`ContextPrune Spike: Run Token‑Savings Benchmark`**. It:

1. Picks the best available `copilot` model (same model for both variants — isolates the
   *instruction‑discipline* effect from any model‑choice or caching effect, so the
   comparison is fair and not inflated).
2. Runs a fixed set of **3 representative tasks** (explain a function, add error handling,
   write a unit test — kept small deliberately: 3 tasks × 2 variants = 6 real, billed model
   calls) as **independent single‑turn requests** (not part of one chat, so no shared‑cache
   confound between variants):
   - **Baseline variant** — the task, unmodified, no brevity instruction (mimics an
     un‑optimized Copilot Chat turn).
   - **Lean variant** — the same task prefixed with ContextPrune's terse‑output instruction
     ("Be concise. Code only unless asked. No preamble or summary.").
3. Measures real input/output tokens via `countTokens` on the actual prompt and streamed
   response text for every call.
4. Prices both variants using the seed `model-pricing.json` (§3) for whichever model ran,
   and reports input/output/estimated‑$ deltas and a % reduction, per task and totaled.
5. **Asks for confirmation before running** (shows call count + which model + "this uses
   real Copilot quota") — it is not silent, and never runs on its own.
6. Prints an explicit caveat block: same‑model comparison only (real savings compound
   further with model downshift + caching + fewer Agent tool round‑trips, none of which
   this benchmark measures); LLM output length varies run‑to‑run, so treat the % as
   illustrative, not a guarantee — run it a few times.

This gives you a **real number, from your own org's models, today** — "on 3 representative
tasks, terse instructions cut output tokens by N% and estimated cost by $Y" — to open a
conversation with your org, ahead of the full dashboard.

### Dashboard — an Activity Bar entry point, not just a command

Real extensions aren't opened by remembering a Command Palette string — clicking an icon in
the **Activity Bar** (the vertical strip on the far left; same place GitLens, Docker, etc. put
theirs) is the expected entry point. The spike now contributes exactly that:
`contributes.viewsContainers.activitybar` + `contributes.views` (a `type: "webview"` view),
backed by a `vscode.WebviewViewProvider`. Clicking the icon reveals a **compact sidebar**
(greeting, 3 stat tiles, top projects, "Run benchmark" / "Open full dashboard" buttons) — no
command needed. `ContextPrune Spike: Open Dashboard` still exists and opens the **full**
editor‑tab webview for the detailed by‑project table; the two share the same data and refresh
each other. The Activity Bar icon itself must be a **monochrome SVG** (`images/activitybar-icon.svg`)
— VS Code re‑tints it per theme — unlike the marketplace `icon` field, which must be PNG.

Both webviews are styled with VS Code's own theme variables (`--vscode-*`), not a mockup, and
read a **local, per‑project history file**. The full dashboard renders:

1. **Summary tiles** — runs logged, tasks benchmarked, avg. output‑token change, est. $ saved
   to date.
2. **By‑project table** — every distinct project (see storage below), its run count, average
   output‑token reduction, estimated $ saved, last‑run time. This is the "projectwise savings"
   view.
3. **Recent runs** — the last 15 benchmark runs, one row each.
4. **Personalization** — "Hi \<name\>" once signed in (see below), or a "Sign in with GitHub"
   button; and a **"Run another benchmark"** button that triggers a new run and refreshes in
   place.

**Storage:** `context.globalStorageUri/contextprune-history.json` — a flat JSON array of
benchmark records (timestamp, project, model, per‑task token counts, totals, estimated cost).
Purely local, never transmitted, survives across workspace sessions on this machine.
**Project id = the first workspace folder's name** — simple and enough to group by right now,
but *not* a stable identity across clones or renames of the same repo; a git‑remote‑derived id
is a reasonable upgrade, not done yet. Every run from `runBenchmark` is appended automatically
and the open dashboard (if any) refreshes itself.

The earlier **visual‑design mockup** (illustrative data, hand‑designed palette/typography) stays
useful as the target for Phase 1's *polish* pass — the real webview above is intentionally
plainer (VS Code theme tokens, simple tables) since it's wired to real, growing data now rather
than a one‑time design artifact.

### Personalization — signed‑in GitHub identity

`ContextPrune Spike: Sign in with GitHub` and the dashboard's own "Sign in" button both call
`vscode.authentication.getSession(...)` — VS Code's **built‑in** auth broker (the same one
Settings Sync and the GitHub Pull Requests extension use), not custom OAuth code in this
extension. Behavior:

- Tries **silently first** (`createIfNone: false`) against both `'github'` (github.com / GHEC)
  and `'github-enterprise'` (self‑hosted GHES, when `github-enterprise.uri` is configured) —
  if the user is already signed in to either for some other purpose, the dashboard greets them
  with no extra prompt.
- If neither has a session and the user explicitly clicks "Sign in," asks which GitHub
  (`github` vs `github-enterprise`) and only then calls `getSession(..., { createIfNone: true })`,
  which shows VS Code's own system consent dialog — never a form inside our extension.
- Requests **`read:user` only** — no repo, no write access. Uses just `session.account.label`
  for the greeting; the access token is never logged, stored, or read for anything else by
  ContextPrune.
- **Never automatic.** No sign‑in prompt fires on activation; it only ever happens after the
  user clicks something.

This is the enterprise‑constraints exception called out in §4.1 — worth an explicit decision
entry (§10) rather than quietly expanding the "no new network calls" rule.

### Branding — icon

VS Code requires a **PNG** icon (`icon` field in `package.json`; SVG is rejected by
`vsce package`). A simple mark was generated this session and wired into `package.json` *and*
the chat participant's `iconPath` — see `spike/images/icon.png`. **Known limitation:** the
`package.json` icon only renders in the Extensions view / a Marketplace‑style listing, which
only appears once the extension is **installed from a `.vsix`** — it does *not* show anywhere
when running via F5 (Extension Development Host), which is why it wasn't visible during
Phase 0 testing. The chat participant's icon (visible immediately, any way you run it) now
uses the same PNG rather than a generic `ThemeIcon`, so branding is visible in F5 too.

---

## 7. Architecture sketch

- **Language:** TypeScript. **Bundler:** `esbuild`. **No native modules.** Optional wasm tokenizer.
- **Modules:** `tokenizer/`, `context-model/` (inline footprint), `rules/` (toggle engine),
  `tabs/`, `chat/` (participant + tools + `prompt-tsx`), `modes/` (ship + lint the Lean mode),
  `models/` (`selectChatModels` wrapper + `model-pricing.json` + cache‑aware downshift), `cache/`
  (session‑state watchers for cache‑buster detection), `retrieval/` (lexical / TF‑IDF / symbol
  ranking, chunker, comment stripper), `report/` (ledger + FinOps), `config/`.
- **Activation:** `onStartupFinished`. Contributes: status bar, commands, chat participant, LM
  tools, a custom mode file, settings, CodeLens.
- **Testing:** `@vscode/test-electron`; unit tests for tokenizer parity, rule engine, retrieval
  ranking, multiplier lookup, cache‑buster detection; an **air‑gapped smoke test**.

---

## 8. Known limitations (state up front)

1. Cannot read/modify the built‑in **inline** or **chat/agent** prompt — only influence
   inputs, output constraints (via instructions/mode), request frequency, tools, and model.
2. **`@contextprune` is Ask‑only** — it does not run inside Agent mode's loop; Agent coverage
   is the contributed tools + the Lean mode.
3. Cannot read GitHub's **real** billing. Cost figures are **estimates** from local tokenizers
   + the confirmed per‑family `model-pricing.json` (§3) — which itself will drift as GitHub
   changes prices, and covers only the families we've seen. Native **Cache Explorer** and
   per‑response hover cost are the ground truth we point users to.
4. **No cost / multiplier / cache field in the LM API** — pricing must be maintained out of
   band and will go stale; ship a "prices as of `<date>`, verify against GitHub's docs" notice.
5. **Content exclusions** are admin‑only — we lint and draft, we don't apply.
6. `vscode.lm` needs **consent + entitlement**; without it only Measure + inline features work.
   `@contextprune` is **opt‑in**.
7. Cache‑buster detection is **heuristic** (from observable chat/session state), not a billing
   signal.
8. Lean custom mode needs VS Code **≥ 1.102**; hidden on older builds.
9. Undocumented `github.copilot.advanced.*` knobs — best‑effort only.

---

## 9. Phased roadmap

| Phase | Goal | Deliverable |
|---|---|---|
| **0 — Spike (~1 wk)** | De‑risk APIs | `countTokens`, `selectChatModels` (+ enumerate models), participant registration, `github.copilot.*` read, tab enumeration, custom‑mode detection — in Restricted Mode **and** offline. **Scaffolded → [`spike/`](spike/), compiles clean, `engines ^1.95.0`. Ran in the org — see §11.** |
| **0.5 — Proof (this session)** | A showcase‑ready number, fast | **Benchmark mode** → **local per‑project history** → a **real dashboard + Activity Bar sidebar** reading it → optional **"Hi \<name\>"** via VS Code's built‑in GitHub auth → **branded icon**. See §6. |
| **0.6 — First real interventions (this session)** | Stop being measurement‑only | Three commands that **edit real files, with a diff preview**: `applyTerseInstructions` (writes `.github/copilot-instructions.md`), `addLeanMode` (writes `.github/agents/contextprune-lean.agent.md`), `reviewOpenTabs` (closes user‑picked tabs). This is Pillars 2/4/5 made real, ahead of Phase 1 — a manually‑triggered, diff‑confirmed first cut, not the full automatic rule engine those pillars describe. |
| **1 — Measure + Output discipline** | Visibility + the cheapest big win | Token HUD, **real dashboard webview** (built from the Proof spec), cost ledger (per mode / token type, with/without tagging), instructions budget report, per‑file lens, terse‑output presets, prompt linter. Local tokenizer. Ship `.vsix`. |
| **2 — Reduce inline** | Cut wasted inline requests | Smart tab manager, contextual toggling, exclusion assistant, "prefer completions" nudge. |
| **3 — Chat + cache + Agent** | Ask path, cache hygiene, Agent hooks | `@contextprune` participant, cache‑buster warnings, cache‑friendly ordering, history nudge, cache‑aware model downshift, `/trim` + `contextprune_retrieve` tools, "Lean" custom mode, tool/MCP hygiene report, `prompt-tsx`. |
| **4 — Govern** | Org rollout | Team profile, policy‑lockable settings, FinOps report, run guardrails, signed `.vsix` + silent‑install layout, optional admin‑billing‑API correlation (Leg C, §6). |
| **5 — Polish** | Internal GA | Docs, onboarding (output discipline + Ask vs Agent + cache), Node‑free deps for a possible web build. |

---

## 10. Decisions (locked)

1. **Target surface:** both inline + chat (Ask + Agent). Phased, Measure first.
2. **Chat approach:** build both, end user chooses — `@contextprune` participant (opt‑in Ask
   path) **and** optimize built‑in via contributed tools + the "Lean" custom mode +
   instructions linting. Onboarding explains the trade‑off; nothing forced.
3. **Distribution:** signed `.vsix` only. No marketplace.
4. **Telemetry:** none.
5. **Engine:** `^1.95.0` core; the "Lean" mode feature activates only on **≥ 1.102** — confirmed:
   target org runs **1.137.0**, so both floors are satisfied and the Lean mode ships unconditionally
   there. Core floor stays `^1.95.0` for portability to other orgs.
6. **Content exclusions (open):** advisory‑only assumed (lint + draft), no admin dependency —
   confirm.
7. **Proof methodology:** lead with **Benchmark mode** (real, org‑specific, reproducible)
   for the initial showcase; production ledger with with/without tagging for ongoing proof;
   org billing‑API correlation stays **optional, Phase 4, admin opt‑in** — never required,
   never a default network call.
8. **Local history storage:** `context.globalStorageUri/contextprune-history.json`, a flat
   JSON array, one record per benchmark run — never a database, never synced. Project id =
   workspace‑folder name for now (simple, good enough to ship); revisit with a git‑remote‑based
   id only if folder‑name collisions turn out to matter in practice.
9. **GitHub identity is opt‑in personalization, not a dependency.** Uses VS Code's built‑in
   auth broker (`'github'` / `'github-enterprise'`), `read:user` scope only, silent‑check
   before ever prompting, never fires without an explicit user click. Every other feature
   (benchmark, dashboard, history) works fully signed‑out — this only changes "Sign in with
   GitHub" into "Hi \<name\>". Documented as the one named exception to the no‑new‑network
   rule (§4.1).

---

## 11. Phase 0 spike — org verification checklist

Run [`spike/`](spike/): `npm install && npm run compile`, **F5**, then **"ContextPrune Spike:
Run API Diagnostics"** → read the *ContextPrune Spike* output channel. It compiles clean here;
these need a run **inside the real org**:

| # | Check | How | Why it changes the plan | Status |
|---|---|---|---|---|
| 1 | LM API returns Copilot models | check [4] `OK` / `EMPTY` | If policy blocks the LM API for extensions, the `@contextprune` pillar dies → tools + Lean mode + advice only. | ✅ **18 `vendor:'copilot'` models** (19 incl. 1 `copilotcli` entry). LM API fully usable. |
| 2 | Consent dialog appears & is acceptable | first run of [4] | Admin‑blocked consent = same as #1. | ❓ pending — the run succeeded, but confirm a consent prompt actually appeared (vs. already‑granted from a prior session) so we know new users won't be silently blocked. |
| 3 | Which models are enabled + families | [4] model list | Feeds the pricing table + downshift; are cheap `*-mini` models even available? | ✅ **Done** — full 18‑model list captured and matched against GitHub's live pricing; seed `model-pricing.json` table added to §3. |
| 4 | `.vsix` sideload allowed | `code --install-extension …` | Signature / `extensions.allowed` policy may need the org signing path first. | ❓ pending |
| 5 | `countTokens` vs naive delta | [5] output | Whether a bundled offline tokenizer is trustworthy as fallback. | ✅ string=101, message=105, naive(chars/4)=113 — naive **overestimates by ~10–12%** on English prose. Usable as a "≤ this many, rounded up" fallback bound, not exact. |
| 6 | `github.copilot.advanced` + lock scope | [3] output | Which knobs are centrally managed vs. ours to set. | ✅ `advanced=undefined` (unset), `enable` only has a **default** value, no global/workspace override — nothing here is settings‑locked in this org. |
| 7 | Custom mode support (≥ 1.102, "Configure Chat Modes") | [6] output | Ship the Lean mode now or gate it. | ✅ **Confirmed OK** — VS Code 1.137.0, "Configure Chat Modes/Agents" command present. Ship the Lean mode unconditionally for this org. |
| 8 | Content exclusions in effect | open large/vendored files | Advisory‑only OK, or org expects us to drive exclusions. | ❓ pending |
| 9 | Restricted Mode default + spike still works | [1] says `RESTRICTED … works` | Confirms `untrustedWorkspaces: supported` suffices. | ⚠️ **Inconclusive** — this run had `isTrusted=true` (a trusted workspace), so Restricted Mode itself wasn't exercised. Re‑run after opening an actual untrusted folder (or *File → Restrict Workspace*) to confirm the extension still activates. |
| 10 | Offline behaviour | disconnect, re‑run | [1][2][3] pass; [4][5] fail *fast*. A hang is a Phase 1 bug. | ❓ pending |
| 11 | Auth proxy | note `http.proxy` / `http.proxySupport` | Confirms the real extension needs zero HTTP of its own. | ❓ pending |
| 12 | Deployed VS Code version | Help → About | Confirms `^1.95.0` and whether ≥ 1.102 features exist. | ✅ **1.137.0** — comfortably above both floors. |
| 13 | Native cost UI available | model picker cost tier? response‑hover cost? Agent Debug Logs → Cache Explorer? | If present, our ledger *links to* them instead of estimating; if stripped in the org build, our estimate matters more. | ❓ pending |
| 14 | *(new)* Which Copilot extension is actually installed | check [3] output | Changes our extension‑detection + settings‑targeting logic in Pillars 2/4. | ⚠️ **Finding:** `GitHub.copilot` (classic completions) is **NOT installed**; only `GitHub.copilot-chat` v0.65.0 is present and active. In this org, one unified extension covers both inline + chat. ContextPrune must detect **either** extension id, not assume `GitHub.copilot` exists — see follow‑ups below. |

---

## 12. Sources

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
