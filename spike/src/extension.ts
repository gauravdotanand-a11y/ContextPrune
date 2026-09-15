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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'contextprune.spike.runDiagnostics',
      runDiagnostics,
    ),
    vscode.commands.registerCommand(
      'contextprune.spike.runBenchmark',
      runBenchmark,
    ),
  );

  const participant = vscode.chat.createChatParticipant(
    'contextprune.spike',
    handleChatRequest,
  );
  participant.iconPath = new vscode.ThemeIcon('symbol-ruler');
  context.subscriptions.push(participant);

  CHANNEL.appendLine(
    `[activate] ContextPrune Spike active. isTrusted=${vscode.workspace.isTrusted}. ` +
      `Run "ContextPrune Spike: Run API Diagnostics" from the command palette.`,
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

  let costLine = 'estimated cost: pricing unknown for this model family';
  if (pricing) {
    const cost = (inTok: number, outTok: number): number =>
      (inTok * pricing.input + outTok * pricing.output) / 1_000_000;
    const baselineCost = cost(totalBaselineIn, totalBaselineOut);
    const leanCost = cost(totalLeanIn, totalLeanOut);
    const costPct = baselineCost > 0 ? Math.round(((baselineCost - leanCost) / baselineCost) * 100) : 0;
    costLine = `  estimated cost (fresh-input assumption, no cache credit): baseline=$${baselineCost.toFixed(5)}  lean=$${leanCost.toFixed(5)}  (${costPct >= 0 ? '-' : '+'}${Math.abs(costPct)}%)`;
    log(costLine);
  } else {
    log(`  ${costLine}`);
  }
  log('\nThis is illustrative, from one run, on 3 tasks, one model. Re-run a few times');
  log('before quoting a single number to your org.');

  void vscode.window.showInformationMessage(
    `Benchmark done: output tokens ${outPct >= 0 ? '-' : '+'}${Math.abs(outPct)}% with terse ` +
      `instructions (same "${model.family}" model, 3 tasks). See the output channel for detail.`,
  );
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
