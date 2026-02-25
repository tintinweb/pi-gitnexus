import { spawn } from 'child_process';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { findGitNexusIndex, clearIndexCache, extractPattern, extractFilePatternsFromContent, extractFilesFromReadMany, runAugment, spawnEnv, updateSpawnEnv, gitnexusCmd, setGitnexusCmd, loadSavedConfig, saveConfig } from './gitnexus';
import { mcpClient } from './mcp-client';
import { registerTools } from './tools';

const SEARCH_TOOLS = new Set(['grep', 'find', 'bash', 'read', 'read_many']);

/** Resolve PATH from a login shell so nvm/fnm/volta binaries are visible. */
async function resolveShellPath(): Promise<void> {
  const shell = process.env.SHELL ?? '/bin/sh';
  const path = await new Promise<string>((resolve_) => {
    let out = '';
    const proc = spawn(shell, ['-lc', 'echo $PATH'], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.on('data', (d: { toString(): string }) => { out += d.toString(); });
    proc.on('close', () => resolve_(out.trim()));
    proc.on('error', () => resolve_(process.env.PATH ?? ''));
  });
  updateSpawnEnv({ ...process.env, PATH: path });
}

function trySpawn(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve_) => {
    const proc = spawn(bin, args, { stdio: 'ignore', env: spawnEnv });
    proc.on('close', (code: number | null) => resolve_(code === 0));
    proc.on('error', () => resolve_(false));
  });
}

/** Probe for gitnexus using the configured command. */
async function probeGitNexusBinary(): Promise<boolean> {
  const [bin, ...args] = gitnexusCmd;
  return trySpawn(bin, [...args, '--version']);
}

/** Cached from session_start/session_switch — avoids re-probing on every /gitnexus status. */
let binaryAvailable = false;

/** Working directory of the current session — ctx.cwd in tool_result events may differ. */
let sessionCwd = '';

/** Controls whether the tool_result hook auto-appends graph context. Tools are unaffected. */
let augmentEnabled = true;

/** Number of successful augmentations this session. Shown in /gitnexus status. */
let augmentHits = 0;

/** Number of times the tool_result hook intercepted a search tool result this session. */
let hookFires = 0;

/**
 * Patterns already augmented this session.
 * Prevents the same symbol/file from being looked up repeatedly.
 */
const augmentedCache = new Set<string>();

export default function(pi: ExtensionAPI) {
  registerTools(pi);

  pi.registerFlag('gitnexus-cmd', {
    type: 'string',
    default: 'gitnexus',
    description: 'Command used to invoke gitnexus, e.g. "npx gitnexus@latest"',
  });

  // Append a one-liner so the agent understands graph context in search results.
  pi.on('before_agent_start', async (event: { systemPrompt?: string }, ctx: ExtensionContext) => {
    if (!findGitNexusIndex(ctx.cwd)) return;
    if (event.systemPrompt == null) return;
    return {
      systemPrompt:
        event.systemPrompt +
        '\n\n[GitNexus active] Graph context will appear after search results. ' +
        'Use gitnexus_query, gitnexus_context, gitnexus_impact, gitnexus_detect_changes, ' +
        'gitnexus_list_repos for deeper analysis of call chains and execution flows. ' +
        'If the index is stale after code changes, run /gitnexus analyze to rebuild it.',
    };
  });

  // Core hook: mirrors the Claude Code PreToolUse integration.
  // Intercepts grep/find/bash/read results, appends knowledge graph context.
  pi.on('tool_result', async (event, ctx) => {
    if (!augmentEnabled) return;
    if (!SEARCH_TOOLS.has(event.toolName)) return;
    hookFires++;
    const cwd = sessionCwd || ctx.cwd;
    if (!findGitNexusIndex(cwd)) return;

    // read_many: per-file labeled context so the agent knows which context belongs to which file.
    if (event.toolName === 'read_many') {
      const files = extractFilesFromReadMany(event.input, event.content);
      const fresh = files.filter(f => !augmentedCache.has(f.pattern)).slice(0, 5);
      if (fresh.length === 0) return;
      fresh.forEach(f => augmentedCache.add(f.pattern));
      const results = await Promise.all(fresh.map(f => runAugment(f.pattern, cwd).then(out => ({ f, out }))));
      const sections = results.filter(r => r.out);
      if (sections.length === 0) return;
      augmentHits++;
      const label = sections.length === 1
        ? `[GitNexus: ${sections[0].f.path.split('/').pop()}]`
        : '[GitNexus]';
      const body = sections.length === 1
        ? sections[0].out
        : sections.map(({ f, out }) => `### ${f.path.split('/').pop()}\n${out}`).join('\n\n');
      return {
        content: [
          ...event.content,
          { type: 'text' as const, text: `\n\n${label}\n${body}` },
        ],
      };
    }

    // Collect patterns: primary from input, secondary filenames from result content.
    const primary = extractPattern(event.toolName, event.input);
    const secondary = (event.toolName === 'grep' || event.toolName === 'bash')
      ? extractFilePatternsFromContent(event.content)
      : [];
    const candidates = [...new Set([primary, ...secondary].filter((p): p is string => !!p))];

    // Filter patterns already augmented this session.
    const fresh = candidates.filter(p => !augmentedCache.has(p));
    if (fresh.length === 0) return;

    // Run up to 3 augments in parallel, merge results.
    const toRun = fresh.slice(0, 3);
    toRun.forEach(p => augmentedCache.add(p));
    const results = await Promise.all(toRun.map(p => runAugment(p, cwd)));
    const combined = results.filter(Boolean).join('\n\n');
    if (!combined) return;

    augmentHits++;
    return {
      content: [
        ...event.content,
        { type: 'text' as const, text: `\n\n[GitNexus: ${toRun.join(', ')}]\n${combined}` },
      ],
    };
  });

  async function onSession(ctx: ExtensionContext) {
    mcpClient.stop();
    clearIndexCache();
    augmentEnabled = true;
    augmentHits = 0;
    hookFires = 0;
    augmentedCache.clear();
    sessionCwd = ctx.cwd;
    await resolveShellPath();

    // Resolve command: default → saved config → CLI flag (highest precedence)
    const saved = loadSavedConfig().cmd;
    const flag = pi.getFlag('gitnexus-cmd') as string | undefined;
    const cmdStr = flag ?? saved ?? 'gitnexus';
    setGitnexusCmd(cmdStr.trim().split(/\s+/));

    binaryAvailable = await probeGitNexusBinary();
    if (!findGitNexusIndex(ctx.cwd)) return;

    if (binaryAvailable) {
      ctx.ui.notify(
        'GitNexus: knowledge graph active — searches will be enriched automatically.',
        'info',
      );
    } else {
      ctx.ui.notify(
        'GitNexus index found but gitnexus is not on PATH. Install: npm i -g gitnexus',
        'warning',
      );
    }
  }

  pi.on('session_start',  (_event: unknown, ctx: ExtensionContext) => { void onSession(ctx); });
  pi.on('session_switch', (_event: unknown, ctx: ExtensionContext) => { void onSession(ctx); });

  pi.registerCommand('gitnexus', {
    description: 'GitNexus knowledge graph. Type /gitnexus help for usage.',
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? '';
      const rest = parts.slice(1).join(' ');

      // /gitnexus  or  /gitnexus status
      if (!sub || sub === 'status') {
        if (!binaryAvailable) {
          ctx.ui.notify('gitnexus is not installed. Install: npm i -g gitnexus', 'warning');
          return;
        }
        if (!findGitNexusIndex(ctx.cwd)) {
          ctx.ui.notify('No GitNexus index found. Run: /gitnexus analyze', 'info');
          return;
        }
        const out = await new Promise<string>((resolve_) => {
          let stdout = '';
          const [bin, ...baseArgs] = gitnexusCmd;
          const proc = spawn(bin, [...baseArgs, 'status'], {
            cwd: ctx.cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: spawnEnv,
          });
          proc.stdout.on('data', (chunk: { toString(): string }) => { stdout += chunk.toString(); });
          proc.on('close', () => resolve_(stdout.trim()));
          proc.on('error', () => resolve_(''));
        });
        const augmentLine = augmentEnabled
          ? `Auto-augment: on (${hookFires} intercepted, ${augmentHits} enriched this session)`
          : 'Auto-augment: off';
        ctx.ui.notify((out ? out + '\n' : '') + augmentLine, 'info');
        return;
      }

      // /gitnexus help
      if (sub === 'help') {
        ctx.ui.notify(
          '/gitnexus — GitNexus knowledge graph\n' +
          '\n' +
          'Commands:\n' +
          '  /gitnexus             — show status\n' +
          '  /gitnexus analyze     — index the codebase\n' +
          '  /gitnexus on|off      — enable/disable auto-augment on searches\n' +
          '  /gitnexus config      — set the gitnexus command (saved to ~/.pi/pi-gitnexus.json)\n' +
          '  /gitnexus <pattern>   — manual graph lookup\n' +
          '  /gitnexus query <q>   — search execution flows\n' +
          '  /gitnexus context <n> — callers/callees of a symbol\n' +
          '  /gitnexus impact <n>  — blast radius of a change\n' +
          '\n' +
          'Tools (always available to the agent):\n' +
          '  gitnexus_list_repos, gitnexus_query, gitnexus_context,\n' +
          '  gitnexus_impact, gitnexus_detect_changes',
          'info',
        );
        return;
      }

      // /gitnexus on | off
      if (sub === 'on' || sub === 'off') {
        augmentEnabled = sub === 'on';
        ctx.ui.notify(`GitNexus auto-augment ${augmentEnabled ? 'enabled' : 'disabled'}.`, 'info');
        return;
      }

      // /gitnexus config
      if (sub === 'config') {
        const current = gitnexusCmd.join(' ');
        const input = await ctx.ui.input('gitnexus command', current);
        if (input === undefined) return; // cancelled
        const trimmed = input.trim();
        if (!trimmed) return;
        setGitnexusCmd(trimmed.split(/\s+/));
        saveConfig({ cmd: trimmed });
        ctx.ui.notify(`GitNexus command set to: ${trimmed}`, 'info');
        return;
      }

      // /gitnexus analyze
      if (sub === 'analyze') {
        if (!binaryAvailable) {
          ctx.ui.notify('gitnexus is not installed. Install: npm i -g gitnexus', 'warning');
          return;
        }
        augmentEnabled = false;
        ctx.ui.notify('GitNexus: analyzing codebase, this may take a while…', 'info');
        const exitCode = await new Promise<number | null>((resolve_) => {
          const [bin, ...baseArgs] = gitnexusCmd;
          const proc = spawn(bin, [...baseArgs, 'analyze'], {
            cwd: ctx.cwd,
            stdio: 'ignore',
            env: spawnEnv,
          });
          proc.on('close', resolve_);
          proc.on('error', () => resolve_(null));
        });
        if (exitCode === 0) {
          clearIndexCache();
          augmentEnabled = true;
          ctx.ui.notify('GitNexus: analysis complete. Knowledge graph ready.', 'info');
        } else {
          augmentEnabled = true;
          ctx.ui.notify('GitNexus: analysis failed. Check the terminal for details.', 'error');
        }
        return;
      }

      // /gitnexus query <text>
      if (sub === 'query') {
        if (!rest) { ctx.ui.notify('Usage: /gitnexus query <text>', 'info'); return; }
        const out = await mcpClient.callTool('query', { query: rest }, ctx.cwd);
        if (out) pi.sendUserMessage(out, { deliverAs: 'followUp' });
        else ctx.ui.notify('No results.', 'info');
        return;
      }

      // /gitnexus context <name>
      if (sub === 'context') {
        if (!rest) { ctx.ui.notify('Usage: /gitnexus context <name>', 'info'); return; }
        const out = await mcpClient.callTool('context', { name: rest }, ctx.cwd);
        if (out) pi.sendUserMessage(out, { deliverAs: 'followUp' });
        else ctx.ui.notify('No results.', 'info');
        return;
      }

      // /gitnexus impact <name>
      if (sub === 'impact') {
        if (!rest) { ctx.ui.notify('Usage: /gitnexus impact <name>', 'info'); return; }
        const out = await mcpClient.callTool('impact', { target: rest, direction: 'upstream' }, ctx.cwd);
        if (out) pi.sendUserMessage(out, { deliverAs: 'followUp' });
        else ctx.ui.notify('No results.', 'info');
        return;
      }

      // /gitnexus <pattern>  — manual augment lookup
      const pattern = sub + (rest ? ' ' + rest : '');
      if (pattern.length < 3) { ctx.ui.notify('Pattern too short (min 3 chars).', 'info'); return; }
      const out = await runAugment(pattern, ctx.cwd);
      if (out) pi.sendUserMessage('[GitNexus]\n' + out, { deliverAs: 'followUp' });
      else ctx.ui.notify('No graph context found for: ' + pattern, 'info');
    },
  });
}
