import * as vscode from 'vscode';

/**
 * ContextPrune — Phase 0 de-risking spike.
 *
 * This extension exists only to answer: "do the APIs we plan to build on actually
 * work in a locked-down org, in a Restricted-Mode workspace, and with the network off?"
 *
 * It imports nothing except `vscode` and makes zero direct network calls.
 */

const CHANNEL = vscode.window.createOutputChannel('ContextPrune Spike');

/**
 * Seed pricing ($ / 1M tokens), confirmed against GitHub's usage-based pricing docs on
 * 2026-09-15 and matched to models actually returned by a live org. Family names Copilot
 * doesn't expose pricing for (e.g. gpt-4o-mini) are deliberately omitted — "cost unknown"
 * beats a guessed number. Keep in sync with Plans.md §3 if prices change.
 */
const MODEL_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'gemini-3.7-flash': { input: 0.75, cachedInput: 0.075, output: 3.75 },
  'gemini-3.8-flash': { input: 0.75, cachedInput: 0.075, output: 3.75 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'claude-haiku-4.5': { input: 1.0, cachedInput: 0.1, output: 5.0 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.0 },
  'claude-sonnet-5': { input: 2.0, cachedInput: 0.2, output: 10.0 },
  'gpt-5.6-terra': { input: 2.0, cachedInput: 0.2, output: 12.0 },
  'gpt-5.6-sol': { input: 4.0, cachedInput: 0.4, output: 20.0 },
  'claude-opus-4.8': { input: 5.0, cachedInput: 0.5, output: 25.0 },
  'claude-opus-5': { input: 5.0, cachedInput: 0.5, output: 25.0 },
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
};

/** Copilot's own internal/utility models — never offer these as benchmark or downshift picks. */
const NON_USER_FACING_FAMILIES = new Set([
  'copilot-utility',
  'copilot-utility-small',
  'copilot-dictation-cleanup-luna',
]);

const SAMPLE_FUNCTION = `function parseAmount(input) {
  const cleaned = input.replace(/[^0-9.]/g, '');
  return parseFloat(cleaned);
}`;

const BENCHMARK_TASKS: { id: string; task: string }[] = [
  {
    id: 'explain',
    task: `Explain what this function does:\n\n${SAMPLE_FUNCTION}`,
  },
  {
    id: 'error-handling',
    task: `Add input validation and error handling to this function:\n\n${SAMPLE_FUNCTION}`,
  },
  {
    id: 'unit-tests',
    task: `Write unit tests for this function:\n\n${SAMPLE_FUNCTION}`,
  },
];

const LEAN_INSTRUCTION =
  'Be concise. Code only unless asked for an explanation. No preamble, no summary, ' +
  'no restating the task.';

/** Set once in activate(); every helper below reads global storage / extensionUri through this. */
let EXTENSION_CONTEXT: vscode.ExtensionContext;
let dashboardPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  EXTENSION_CONTEXT = context;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'contextprune.spike.runDiagnostics',
      runDiagnostics,
    ),
    vscode.commands.registerCommand(
      'contextprune.spike.runBenchmark',
      runBenchmark,
    ),
    vscode.commands.registerCommand(
      'contextprune.spike.openDashboard',
      openDashboard,
    ),
    vscode.commands.registerCommand(
      'contextprune.spike.signInWithGithub',
      signInWithGithub,
    ),
  );

  const participant = vscode.chat.createChatParticipant(
    'contextprune.spike',
    handleChatRequest,
  );
  // A real .png icon (not a generic ThemeIcon) so the extension's own branding
  // actually shows up somewhere visible during F5 debugging, not just once
  // sideloaded as a .vsix (where the Extensions view icon appears).
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');
  context.subscriptions.push(participant);

  CHANNEL.appendLine(
    `[activate] ContextPrune Spike active. isTrusted=${vscode.workspace.isTrusted}. ` +
      `Run "ContextPrune Spike: Run API Diagnostics" from the command palette. Note: this ` +
      `extension's package.json "icon" only appears in the Extensions view / Marketplace-style ` +
      `listing when installed from a .vsix — not when run via F5 (Extension Development Host).`,
  );
}

export function deactivate(): void {
  CHANNEL.dispose();
}

// ---------------------------------------------------------------------------
// Diagnostics command — checks every risky API assumption in one pass.
// ---------------------------------------------------------------------------

async function runDiagnostics(): Promise<void> {
  CHANNEL.clear();
  CHANNEL.show(true);
  const log = (s = ''): void => CHANNEL.appendLine(s);
  const results: Record<string, string> = {};

  log('='.repeat(64));
  log('ContextPrune Phase 0 — API de-risking diagnostics');
  log(new Date().toISOString());
  log(`VS Code ${vscode.version}`);
  log('='.repeat(64));

  // --- [1] Workspace trust ------------------------------------------------
  log('\n[1] Workspace trust (does the extension run in Restricted Mode?)');
  log(`    workspace.isTrusted = ${vscode.workspace.isTrusted}`);
  results.workspaceTrust = vscode.workspace.isTrusted
    ? 'trusted'
    : 'RESTRICTED — and this code is still executing, so untrustedWorkspaces:supported works';

  // --- [2] Tab / editor enumeration ------------------------------------
  log('\n[2] Tab enumeration (vscode.window.tabGroups) — the neighboring-tabs signal');
  try {
    const groups = vscode.window.tabGroups.all;
    let total = 0;
    let textTabs = 0;
    for (const g of groups) {
      for (const t of g.tabs) {
        total++;
        if (t.input instanceof vscode.TabInputText) {
          textTabs++;
          const rel = vscode.workspace.asRelativePath(t.input.uri);
          log(`    - [text]  ${rel}${t.isActive ? '   (active)' : ''}`);
        } else {
          const kind = t.input?.constructor?.name ?? 'unknown';
          log(`    - [${kind}] ${t.label}`);
        }
      }
    }
    log(`    groups=${groups.length}  totalTabs=${total}  textTabs=${textTabs}`);
    results.tabEnumeration = `OK — ${textTabs} text tabs visible across ${groups.length} group(s)`;
  } catch (err) {
    results.tabEnumeration = `FAILED: ${errText(err)}`;
    log(`    FAILED: ${errText(err)}`);
  }

  // --- [3] Copilot presence + settings read --------------------------
  log('\n[3] GitHub Copilot presence + settings readability');
  const copilot = vscode.extensions.getExtension('GitHub.copilot');
  const copilotChat = vscode.extensions.getExtension('GitHub.copilot-chat');
  log(
    `    GitHub.copilot       installed=${!!copilot} active=${copilot?.isActive ?? false} ` +
      `v=${(copilot?.packageJSON as { version?: string } | undefined)?.version ?? '-'}`,
  );
  log(
    `    GitHub.copilot-chat  installed=${!!copilotChat} active=${copilotChat?.isActive ?? false} ` +
      `v=${(copilotChat?.packageJSON as { version?: string } | undefined)?.version ?? '-'}`,
  );

  const cfg = vscode.workspace.getConfiguration('github.copilot');
  const enable = cfg.get<unknown>('enable');
  const advanced = cfg.get<unknown>('advanced');
  const inlineSuggest = vscode.workspace
    .getConfiguration('editor.inlineSuggest')
    .get<boolean>('enabled');
  log(`    github.copilot.enable        = ${JSON.stringify(enable)}`);
  log(`    github.copilot.advanced      = ${JSON.stringify(advanced)}`);
  log(`    editor.inlineSuggest.enabled = ${JSON.stringify(inlineSuggest)}`);

  const insp = cfg.inspect('enable');
  log(
    `    enable scopes: default=${JSON.stringify(insp?.defaultValue)} ` +
      `global=${JSON.stringify(insp?.globalValue)} ` +
      `workspace=${JSON.stringify(insp?.workspaceValue)} ` +
      `workspaceFolder=${JSON.stringify(insp?.workspaceFolderValue)}`,
  );
  results.copilotSettingsRead = copilot
    ? 'OK — Copilot installed, settings + scopes readable'
    : 'PARTIAL — settings API works; Copilot extension not installed in this host';

  // --- [4] vscode.lm.selectChatModels -------------------------------
  log('\n[4] vscode.lm.selectChatModels (must be user-initiated — this command counts)');
  let model: vscode.LanguageModelChat | undefined;
  try {
    const all = await vscode.lm.selectChatModels();
    log(`    models (any vendor): ${all.length}`);
    for (const m of all) {
      log(
        `    - vendor=${m.vendor} family=${m.family} id=${m.id} ` +
          `version=${m.version} maxInputTokens=${m.maxInputTokens}`,
      );
    }
    const copilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    log(`    copilot models: ${copilotModels.length}`);
    const families = [...new Set(all.map((m) => m.family))].sort();
    log(`    distinct families: ${families.join(', ') || '(none)'}`);
    log('    NOTE: the LM API exposes no cost/multiplier field — ContextPrune must ship a');
    log('          static multiplier table keyed by family.');
    model = copilotModels[0] ?? all[0];

    if (copilotModels.length > 0) {
      results.selectChatModels = `OK — ${copilotModels.length} copilot model(s)`;
    } else if (all.length > 0) {
      results.selectChatModels = `PARTIAL — ${all.length} model(s), none from vendor "copilot"`;
    } else {
      results.selectChatModels =
        'EMPTY — no models. Causes: consent not granted, no Copilot entitlement, ' +
        'or org policy blocks the LM API for extensions';
    }
  } catch (err) {
    results.selectChatModels = `FAILED: ${errText(err)}`;
    log(`    FAILED: ${errText(err)}`);
  }

  // --- [5] LanguageModelChat.countTokens --------------------------
  log('\n[5] LanguageModelChat.countTokens (our measurement ground truth)');
  if (model) {
    try {
      const sample = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
      const strTokens = await model.countTokens(sample);
      const msgTokens = await model.countTokens(
        vscode.LanguageModelChatMessage.User(sample),
      );
      const naive = Math.ceil(sample.length / 4);
      log(`    sample: ${sample.length} chars`);
      log(`    countTokens(string)  = ${strTokens}`);
      log(`    countTokens(message) = ${msgTokens}`);
      log(`    naive (chars / 4)    = ${naive}   (delta ${strTokens - naive})`);
      results.countTokens = `OK — string=${strTokens}, message=${msgTokens}, naive=${naive}`;
    } catch (err) {
      results.countTokens = `FAILED: ${errText(err)}`;
      log(`    FAILED: ${errText(err)}`);
    }
  } else {
    results.countTokens = 'SKIPPED — no model from check [4]';
    log('    SKIPPED — no model available');
  }

  // --- [6] Custom chat mode ("custom agent") support ------------
  log('\n[6] Custom chat mode / custom agent support (for the shipped "Lean" mode)');
  {
    const [maj, min] = vscode.version.split('.').map((n) => parseInt(n, 10));
    const versionOk = maj > 1 || (maj === 1 && min >= 102);
    const cmds = await vscode.commands.getCommands(true);
    const hasConfigureModes = cmds.some((c) =>
      /workbench\.action\.chat\.(configure|manage).*(mode|agent)/i.test(c),
    );
    log(`    VS Code ${vscode.version} — custom modes need >= 1.102 : ${versionOk ? 'OK' : 'TOO OLD'}`);
    log(`    "configure chat modes/agents" command present : ${hasConfigureModes}`);
    results.customModeSupport = versionOk
      ? `OK (>=1.102${hasConfigureModes ? ', command present' : ''})`
      : 'UNAVAILABLE — ship the Lean mode gated on version';
  }

  // --- [7] Outbound network ---------------------------------------
  log('\n[7] Outbound network from THIS extension');
  log('    Source imports: only "vscode". No fetch / http / https / net / axios / undici.');
  log('    Any LM traffic originates from the Copilot extension host, not from ContextPrune.');
  log('    External verification (do this yourself):');
  log('      - disconnect the network, re-run this command: [1][2][3] pass, [4][5] fail fast (no hang)');
  log('      - or watch with Little Snitch / `sudo nettop -m route` while running diagnostics');
  results.outboundNetwork = 'none in code — verify externally (offline run + traffic monitor)';

  // --- Summary --------------------------------------------------
  log('\n' + '='.repeat(64));
  log('SUMMARY');
  log('='.repeat(64));
  for (const [k, v] of Object.entries(results)) {
    log(`  ${k.padEnd(20)} : ${v}`);
  }
  const failed = Object.values(results).filter((v) => v.startsWith('FAILED')).length;
  void vscode.window.showInformationMessage(
    `ContextPrune spike: ${Object.keys(results).length} checks, ${failed} failed. ` +
      `See the "ContextPrune Spike" output channel.`,
  );
}

// ---------------------------------------------------------------------------
// Benchmark — real, org-specific evidence: the same model, the same 3 tasks, run once
// "vanilla" and once with ContextPrune's terse-output instruction, measuring actual
// countTokens on actual responses. This is Leg A of the "prove savings" methodology
// in Plans.md §6. It makes real, billed model calls — nothing runs without confirmation.
// ---------------------------------------------------------------------------

async function runBenchmark(): Promise<void> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  const model = models.find(
    (m) => m.maxInputTokens > 0 && !NON_USER_FACING_FAMILIES.has(m.family) && m.id !== 'auto',
  );

  if (!model) {
    void vscode.window.showErrorMessage(
      'ContextPrune benchmark: no usable copilot chat model available (run ' +
        '"ContextPrune Spike: Run API Diagnostics" first to see why).',
    );
    return;
  }

  const callCount = BENCHMARK_TASKS.length * 2;
  const confirm = await vscode.window.showWarningMessage(
    `Run the ContextPrune benchmark? This sends ${callCount} real requests to ` +
      `"${model.family}" (${BENCHMARK_TASKS.length} tasks × 2 variants) and uses your ` +
      'org\'s Copilot quota.',
    { modal: true },
    'Run benchmark',
  );
  if (confirm !== 'Run benchmark') {
    return;
  }

  CHANNEL.clear();
  CHANNEL.show(true);
  const log = (s = ''): void => CHANNEL.appendLine(s);
  const pricing = MODEL_PRICING[model.family];

  log('='.repeat(64));
  log('ContextPrune token-savings benchmark');
  log(new Date().toISOString());
  log(`Model: ${model.vendor}/${model.family} (maxInputTokens=${model.maxInputTokens})`);
  log(pricing ? `Pricing: known ($${pricing.input}/${pricing.output} per 1M in/out)` : 'Pricing: UNKNOWN for this family — $ estimates omitted');
  log('CAVEATS: same model both variants (isolates instruction-discipline only — real');
  log('  savings compound further with model downshift, caching, fewer Agent tool calls,');
  log('  none of which this measures); LLM output length varies run-to-run — treat the %');
  log('  as illustrative and re-run a few times before quoting a single number.');
  log('='.repeat(64));

  type Variant = { label: string; promptTokens: number; outputTokens: number };
  const rows: { taskId: string; baseline: Variant; lean: Variant }[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Running ContextPrune benchmark' },
    async (progress, token) => {
      for (const [i, t] of BENCHMARK_TASKS.entries()) {
        progress.report({ message: `${t.id} (${i + 1}/${BENCHMARK_TASKS.length})`, increment: (100 / BENCHMARK_TASKS.length) });
        log(`\n[${t.id}]`);
        const baseline = await runVariant(model, 'baseline', t.task, token);
        const lean = await runVariant(model, 'lean', `${LEAN_INSTRUCTION}\n\n${t.task}`, token);
        rows.push({ taskId: t.id, baseline, lean });
        log(`    baseline: input=${baseline.promptTokens} output=${baseline.outputTokens}`);
        log(`    lean:     input=${lean.promptTokens} output=${lean.outputTokens}`);
        const outputDelta = baseline.outputTokens - lean.outputTokens;
        const outputPct = baseline.outputTokens > 0 ? Math.round((outputDelta / baseline.outputTokens) * 100) : 0;
        log(`    output tokens: ${outputPct >= 0 ? '-' : '+'}${Math.abs(outputPct)}% (${outputDelta >= 0 ? '-' : '+'}${Math.abs(outputDelta)} tokens)`);
      }
    },
  );

  log('\n' + '='.repeat(64));
  log('TOTALS');
  log('='.repeat(64));
  const totalBaselineOut = rows.reduce((s, r) => s + r.baseline.outputTokens, 0);
  const totalLeanOut = rows.reduce((s, r) => s + r.lean.outputTokens, 0);
  const totalBaselineIn = rows.reduce((s, r) => s + r.baseline.promptTokens, 0);
  const totalLeanIn = rows.reduce((s, r) => s + r.lean.promptTokens, 0);
  const outPct = totalBaselineOut > 0 ? Math.round(((totalBaselineOut - totalLeanOut) / totalBaselineOut) * 100) : 0;
  log(`  output tokens: baseline=${totalBaselineOut}  lean=${totalLeanOut}  (${outPct >= 0 ? '-' : '+'}${Math.abs(outPct)}%)`);
  log(`  input tokens:  baseline=${totalBaselineIn}  lean=${totalLeanIn}`);
  if (totalLeanIn > totalBaselineIn) {
    const overhead = totalLeanIn - totalBaselineIn;
    let prefixTokens: number | undefined;
    try {
      prefixTokens = await model.countTokens(LEAN_INSTRUCTION);
    } catch {
      prefixTokens = undefined;
    }
    log(
      `    (lean input is ${overhead} tokens HIGHER — that's the ${prefixTokens ?? '~20'}-token ` +
        'instruction prefix itself, paid on every call. It is worth it exactly when the output',
    );
    log(
      `    savings above exceed those ${overhead} tokens, which they clearly do here — but on a ` +
        'trivial task with a naturally one-line answer, it might not be.)',
    );
  }

  let baselineCostVal = 0;
  let leanCostVal = 0;
  let costPctVal = 0;
  if (pricing) {
    const cost = (inTok: number, outTok: number): number =>
      (inTok * pricing.input + outTok * pricing.output) / 1_000_000;
    baselineCostVal = cost(totalBaselineIn, totalBaselineOut);
    leanCostVal = cost(totalLeanIn, totalLeanOut);
    costPctVal = baselineCostVal > 0 ? Math.round(((baselineCostVal - leanCostVal) / baselineCostVal) * 100) : 0;
    log(
      `  estimated cost (fresh-input assumption, no cache credit): baseline=$${baselineCostVal.toFixed(5)} ` +
        `lean=$${leanCostVal.toFixed(5)}  (${costPctVal >= 0 ? '-' : '+'}${Math.abs(costPctVal)}%)`,
    );
  } else {
    log('  estimated cost: pricing unknown for this model family');
  }
  log('\nThis is illustrative, from one run, on 3 tasks, one model. Re-run a few times');
  log('before quoting a single number to your org.');

  const record: BenchmarkRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    project: getProjectId(),
    vendor: model.vendor,
    family: model.family,
    tasks: rows.map((r) => ({
      id: r.taskId,
      baselineIn: r.baseline.promptTokens,
      baselineOut: r.baseline.outputTokens,
      leanIn: r.lean.promptTokens,
      leanOut: r.lean.outputTokens,
    })),
    totals: {
      baselineIn: totalBaselineIn,
      baselineOut: totalBaselineOut,
      leanIn: totalLeanIn,
      leanOut: totalLeanOut,
      outputPct: outPct,
      pricingKnown: !!pricing,
      baselineCost: baselineCostVal,
      leanCost: leanCostVal,
      costPct: costPctVal,
    },
  };
  await appendHistory(record);
  log(`\nSaved locally under project "${record.project}" — open "ContextPrune Spike: Open Dashboard" to see it.`);
  await updateDashboardPanel();

  void vscode.window.showInformationMessage(
    `Benchmark done: output tokens ${outPct >= 0 ? '-' : '+'}${Math.abs(outPct)}% with terse ` +
      `instructions (same "${model.family}" model, 3 tasks). Saved to the local dashboard.`,
    'Open Dashboard',
  ).then((choice) => {
    if (choice === 'Open Dashboard') {
      void vscode.commands.executeCommand('contextprune.spike.openDashboard');
    }
  });
}

async function runVariant(
  model: vscode.LanguageModelChat,
  label: string,
  promptText: string,
  token: vscode.CancellationToken,
): Promise<{ label: string; promptTokens: number; outputTokens: number }> {
  const messages = [vscode.LanguageModelChatMessage.User(promptText)];
  const promptTokens = await model.countTokens(promptText);
  let responseText = '';
  try {
    const resp = await model.sendRequest(messages, {}, token);
    for await (const chunk of resp.text) {
      responseText += chunk;
    }
  } catch (err) {
    CHANNEL.appendLine(`    [${label}] sendRequest failed: ${errText(err)}`);
  }
  const outputTokens = responseText ? await model.countTokens(responseText) : 0;
  return { label, promptTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Local, per-project history — every benchmark run is appended here. Purely local
// (VS Code's own extension global-storage folder on disk), never uploaded, never
// synced. "Project" is the first workspace folder's name — simple and good enough
// to start with, but not a stable ID across clones/renames of the same repo; a
// git-remote-derived ID is a reasonable future improvement, not done here.
// ---------------------------------------------------------------------------

interface BenchmarkTaskRecord {
  id: string;
  baselineIn: number;
  baselineOut: number;
  leanIn: number;
  leanOut: number;
}

interface BenchmarkRecord {
  id: string;
  timestamp: string;
  project: string;
  vendor: string;
  family: string;
  tasks: BenchmarkTaskRecord[];
  totals: {
    baselineIn: number;
    baselineOut: number;
    leanIn: number;
    leanOut: number;
    outputPct: number;
    pricingKnown: boolean;
    baselineCost: number;
    leanCost: number;
    costPct: number;
  };
}

function getProjectId(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? '(no workspace open)';
}

function historyFileUri(): vscode.Uri {
  return vscode.Uri.joinPath(EXTENSION_CONTEXT.globalStorageUri, 'contextprune-history.json');
}

async function loadHistory(): Promise<BenchmarkRecord[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(historyFileUri());
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return Array.isArray(parsed) ? (parsed as BenchmarkRecord[]) : [];
  } catch {
    return []; // no file yet, or unreadable — start fresh rather than fail the benchmark
  }
}

async function appendHistory(record: BenchmarkRecord): Promise<void> {
  const history = await loadHistory();
  history.push(record);
  await vscode.workspace.fs.createDirectory(EXTENSION_CONTEXT.globalStorageUri);
  await vscode.workspace.fs.writeFile(
    historyFileUri(),
    Buffer.from(JSON.stringify(history, null, 2), 'utf8'),
  );
}

// ---------------------------------------------------------------------------
// GitHub identity — uses VS Code's BUILT-IN authentication broker, not a network
// call this extension makes itself. read:user scope only (never repo/write access);
// the extension only ever reads `session.account.label` for a greeting — the token
// itself is held by VS Code, never logged, stored, or exported by ContextPrune.
// Tries silently (already signed in for Settings Sync / GitHub PRs?) before ever
// prompting. Supports both github.com/GHEC ('github') and self-hosted GHES
// ('github-enterprise', when the org has github-enterprise.uri configured).
// ---------------------------------------------------------------------------

type GithubProvider = 'github' | 'github-enterprise';

async function getGithubSession(createIfNone: boolean): Promise<vscode.AuthenticationSession | undefined> {
  for (const providerId of ['github', 'github-enterprise'] as GithubProvider[]) {
    try {
      const session = await vscode.authentication.getSession(providerId, ['read:user'], {
        createIfNone: false,
      });
      if (session) return session;
    } catch {
      // provider unavailable in this build, or no cached session — try the next one
    }
  }
  if (!createIfNone) return undefined;

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'GitHub.com', id: 'github' as GithubProvider },
      {
        label: 'GitHub Enterprise Server',
        id: 'github-enterprise' as GithubProvider,
        description: 'requires the github-enterprise.uri setting to already be configured',
      },
    ],
    { placeHolder: 'Sign in with which GitHub?' },
  );
  if (!choice) return undefined;

  try {
    return await vscode.authentication.getSession(choice.id, ['read:user'], { createIfNone: true });
  } catch (err) {
    void vscode.window.showErrorMessage(`GitHub sign-in failed: ${errText(err)}`);
    return undefined;
  }
}

async function signInWithGithub(): Promise<void> {
  const session = await getGithubSession(true);
  if (session) {
    void vscode.window.showInformationMessage(
      `Signed in as ${session.account.label} (scope: read:user only — ContextPrune never ` +
        'requests write or repo access).',
    );
  }
  await updateDashboardPanel();
}

// ---------------------------------------------------------------------------
// Dashboard — a real webview reading the local history above, not the earlier
// published mockup. Styled with VS Code's own theme variables so it matches
// whatever light/dark/high-contrast theme the user has, rather than a fixed palette.
// ---------------------------------------------------------------------------

async function openDashboard(): Promise<void> {
  if (dashboardPanel) {
    dashboardPanel.reveal();
  } else {
    dashboardPanel = vscode.window.createWebviewPanel(
      'contextprune.spike.dashboard',
      'ContextPrune Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    dashboardPanel.iconPath = vscode.Uri.joinPath(EXTENSION_CONTEXT.extensionUri, 'images', 'icon.png');
    dashboardPanel.onDidDispose(() => {
      dashboardPanel = undefined;
    });
    dashboardPanel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
      if (msg?.type === 'signIn') {
        await signInWithGithub();
      } else if (msg?.type === 'runBenchmark') {
        await vscode.commands.executeCommand('contextprune.spike.runBenchmark');
      }
    });
  }
  await updateDashboardPanel();
}

async function updateDashboardPanel(): Promise<void> {
  if (!dashboardPanel) return;
  dashboardPanel.webview.html = await renderDashboardHtml();
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function dashboardCss(): string {
  return `
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
      background: var(--vscode-editor-background); padding: 20px 26px 40px; font-size: 13px; }
    h2 { margin: 0; font-size: 16px; }
    h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
      color: var(--vscode-descriptionForeground); margin: 26px 0 8px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--vscode-panel-border); }
    .greet { font-size: 13px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .greet .muted { font-size: 11.5px; margin-left: 6px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 6px 13px; border-radius: 4px; cursor: pointer; font-size: 12.5px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 18px; }
    .tile { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 14px; }
    .tile .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em;
      color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
    .tile .value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .tile .value.accent { color: var(--vscode-charts-green); }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }
    th { text-align: left; font-size: 10.5px; text-transform: uppercase;
      color: var(--vscode-descriptionForeground); padding: 0 8px 6px;
      border-bottom: 1px solid var(--vscode-panel-border); }
    td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border);
      font-variant-numeric: tabular-nums; }
    th.num, td.num { text-align: right; }
    td.mono { font-family: var(--vscode-editor-font-family, monospace); }
    .empty { margin-top: 44px; display: flex; flex-direction: column; align-items: flex-start;
      gap: 14px; color: var(--vscode-descriptionForeground); }
    .footnote { font-size: 11px; margin-top: 22px; max-width: 660px; line-height: 1.55; }
  `;
}

function dashboardScript(nonce: string): string {
  return `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('signInBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
    document.getElementById('runBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'runBenchmark' }));
  </script>`;
}

async function renderDashboardHtml(): Promise<string> {
  const history = await loadHistory();
  const session = await getGithubSession(false);
  const nonce = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;

  const greetingHtml = session
    ? `<div class="greet">Hi <b>${escapeHtml(session.account.label)}</b><span class="muted">read:user only</span></div>`
    : `<div class="greet"><button id="signInBtn">Sign in with GitHub</button>` +
      `<span class="muted">to personalize this dashboard</span></div>`;

  const topbar = `<div class="topbar"><h2>ContextPrune Dashboard</h2>${greetingHtml}</div>`;

  if (history.length === 0) {
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>${dashboardCss()}</style></head>
      <body>${topbar}
        <div class="empty">
          <p>No benchmark runs saved yet for this machine.</p>
          <button id="runBtn">Run Token-Savings Benchmark</button>
        </div>
      ${dashboardScript(nonce)}</body></html>`;
  }

  const byProject = new Map<string, BenchmarkRecord[]>();
  for (const r of history) {
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }

  const totalRuns = history.length;
  const totalTasks = history.reduce((s, r) => s + r.tasks.length, 0);
  const avgOutputPct = Math.round(history.reduce((s, r) => s + r.totals.outputPct, 0) / totalRuns);
  const anyPricing = history.some((r) => r.totals.pricingKnown);
  const totalSaved = history.reduce(
    (s, r) => s + (r.totals.pricingKnown ? r.totals.baselineCost - r.totals.leanCost : 0),
    0,
  );

  const projectRows = [...byProject.entries()]
    .map(([project, records]) => {
      const runs = records.length;
      const avgPct = Math.round(records.reduce((s, r) => s + r.totals.outputPct, 0) / runs);
      const last = records.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
      const savedHere = records.reduce(
        (s, r) => s + (r.totals.pricingKnown ? r.totals.baselineCost - r.totals.leanCost : 0),
        0,
      );
      return `<tr>
        <td>${escapeHtml(project)}</td>
        <td class="num">${runs}</td>
        <td class="num">${avgPct}%</td>
        <td class="num">${savedHere > 0 ? '$' + savedHere.toFixed(5) : '—'}</td>
        <td>${escapeHtml(new Date(last.timestamp).toLocaleString())}</td>
      </tr>`;
    })
    .join('');

  const recentRows = [...history]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 15)
    .map(
      (r) => `<tr>
        <td>${escapeHtml(new Date(r.timestamp).toLocaleString())}</td>
        <td>${escapeHtml(r.project)}</td>
        <td class="mono">${escapeHtml(r.family)}</td>
        <td class="num">${r.totals.baselineOut} → ${r.totals.leanOut}</td>
        <td class="num">${r.totals.outputPct}%</td>
        <td class="num">${r.totals.pricingKnown ? '$' + (r.totals.baselineCost - r.totals.leanCost).toFixed(5) : '—'}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>${dashboardCss()}</style></head>
    <body>${topbar}
      <div class="stats">
        <div class="tile"><div class="label">Runs logged</div><div class="value">${totalRuns}</div></div>
        <div class="tile"><div class="label">Tasks benchmarked</div><div class="value">${totalTasks}</div></div>
        <div class="tile"><div class="label">Avg. output-token change</div>
          <div class="value accent">${avgOutputPct >= 0 ? '−' : '+'}${Math.abs(avgOutputPct)}%</div></div>
        <div class="tile"><div class="label">Est. saved to date</div>
          <div class="value">${anyPricing ? '$' + totalSaved.toFixed(5) : 'pricing unknown'}</div></div>
      </div>

      <h3>By project</h3>
      <table>
        <thead><tr><th>Project</th><th class="num">Runs</th><th class="num">Avg. output Δ</th>
          <th class="num">Est. saved</th><th>Last run</th></tr></thead>
        <tbody>${projectRows}</tbody>
      </table>

      <h3>Recent runs</h3>
      <table>
        <thead><tr><th>When</th><th>Project</th><th>Model</th><th class="num">Output tokens</th>
          <th class="num">Δ</th><th class="num">Est. saved</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>

      <p style="margin-top:22px;"><button id="runBtn">Run another benchmark</button></p>
      <p class="muted footnote">Local data only — stored under this machine's extension storage,
        never uploaded anywhere. "Project" is currently the workspace folder name (not yet a
        stable ID across clones/renames of the same repo). Cost figures assume fresh-input
        pricing with no cache credit — see Plans.md §6 for the full measurement methodology.</p>
    ${dashboardScript(nonce)}</body></html>`;
}

// ---------------------------------------------------------------------------
// Chat participant — proves participant registration + request.model +
// countTokens + (optionally) a full model round-trip, all in the real chat UI.
// ---------------------------------------------------------------------------

async function handleChatRequest(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const model = request.model;
  stream.markdown(
    `**Model from \`request.model\`:** \`${model.vendor}/${model.family}\` ` +
      `(id \`${model.id}\`), \`maxInputTokens=${model.maxInputTokens}\`\n\n`,
  );

  try {
    const promptTokens = await model.countTokens(request.prompt);
    stream.markdown(
      `**Your prompt:** ${request.prompt.length} chars → \`${promptTokens}\` tokens\n\n`,
    );
  } catch (err) {
    stream.markdown(`\`countTokens\` failed: ${errText(err)}\n\n`);
  }

  stream.markdown(
    `**History turns visible to this participant:** ${context.history.length}\n\n`,
  );

  const refCount = request.references?.length ?? 0;
  stream.markdown(
    `**Context the user attached (\`request.references\`):** ${refCount}` +
      (request.command ? `  ·  **slash command:** \`/${request.command}\`` : '') +
      '\n\n',
  );

  if (request.command === 'callmodel') {
    stream.markdown('**Model round-trip** (minimal 1-message prompt): ');
    try {
      const messages = [
        vscode.LanguageModelChatMessage.User(
          `Reply in one short sentence. ${request.prompt}`,
        ),
      ];
      const resp = await model.sendRequest(messages, {}, token);
      for await (const chunk of resp.text) {
        stream.markdown(chunk);
      }
      stream.markdown('\n');
    } catch (err) {
      stream.markdown(`\nsendRequest failed: ${errText(err)}\n`);
    }
  } else {
    stream.markdown(
      '_Run `@contextprune-spike /callmodel <prompt>` to also test `sendRequest` ' +
        '(that one consumes Copilot quota)._\n',
    );
  }
}

// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    return `LanguageModelError[code=${err.code}]: ${err.message}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
