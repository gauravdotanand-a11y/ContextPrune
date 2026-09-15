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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'contextprune.spike.runDiagnostics',
      runDiagnostics,
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
