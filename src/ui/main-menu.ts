/**
 * main-menu.ts — Interactive main menu for /gitnexus.
 *
 * Shows status in the title, with Analyze, Settings, and Help actions.
 */

import { spawn } from 'child_process';
import type { GitNexusConfig } from '../gitnexus.js';
import { openSettingsMenu } from './settings-menu.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type MenuUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type: 'info' | 'warning' | 'error'): void;
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

export interface MenuContext {
  ui: MenuUI;
  cwd: string;
  cfg: GitNexusConfig;
  state: { augmentEnabled: boolean };
  binaryAvailable: boolean;
  gitnexusCmd: string[];
  spawnEnv: NodeJS.ProcessEnv;
  getHookFires: () => number;
  getAugmentHits: () => number;
  findGitNexusIndex: (cwd: string) => boolean;
  clearIndexCache: () => void;
  setGitnexusCmd: (cmd: string[]) => void;
  setAugmentTimeout: (seconds: number) => void;
  syncState: () => void;
}

// ── Status ──────────────────────────────────────────────────────────────────

async function getStatusLine(mctx: MenuContext): Promise<string> {
  if (!mctx.binaryAvailable) return 'gitnexus not installed';
  if (!mctx.findGitNexusIndex(mctx.cwd)) return 'No index — run /gitnexus analyze';
  const out = await new Promise<string>((resolve_) => {
    let stdout = '';
    const [bin, ...baseArgs] = mctx.gitnexusCmd;
    const proc = spawn(bin, [...baseArgs, 'status'], {
      cwd: mctx.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: mctx.spawnEnv,
    });
    proc.stdout.on('data', (chunk: { toString(): string }) => { stdout += chunk.toString(); });
    proc.on('close', () => resolve_(stdout.trim()));
    proc.on('error', () => resolve_(''));
  });
  const augmentLine = mctx.state.augmentEnabled
    ? `Auto-augment: on (${mctx.getHookFires()} intercepted, ${mctx.getAugmentHits()} enriched)`
    : 'Auto-augment: off';
  return (out ? out + '\n' : '') + augmentLine;
}

// ── Analyze ─────────────────────────────────────────────────────────────────

async function runAnalyze(mctx: MenuContext): Promise<void> {
  if (!mctx.binaryAvailable) {
    mctx.ui.notify('gitnexus is not installed. Install: npm i -g gitnexus', 'warning');
    return;
  }
  mctx.state.augmentEnabled = false;
  mctx.syncState();
  mctx.ui.notify('GitNexus: analyzing codebase, this may take a while…', 'info');
  const exitCode = await new Promise<number | null>((resolve_) => {
    const [bin, ...baseArgs] = mctx.gitnexusCmd;
    const proc = spawn(bin, [...baseArgs, 'analyze'], {
      cwd: mctx.cwd,
      stdio: 'ignore',
      env: mctx.spawnEnv,
    });
    proc.on('close', resolve_);
    proc.on('error', () => resolve_(null));
  });
  if (exitCode === 0) {
    mctx.clearIndexCache();
    mctx.state.augmentEnabled = true;
    mctx.syncState();
    mctx.ui.notify('GitNexus: analysis complete. Knowledge graph ready.', 'info');
  } else {
    mctx.state.augmentEnabled = true;
    mctx.syncState();
    mctx.ui.notify('GitNexus: analysis failed. Check the terminal for details.', 'error');
  }
}

// ── Help ────────────────────────────────────────────────────────────────────

function showHelp(mctx: MenuContext): void {
  mctx.ui.notify(
    'Subcommands:\n' +
    '  /gitnexus status      — show index & augmentation stats\n' +
    '  /gitnexus analyze     — build/rebuild the knowledge graph\n' +
    '  /gitnexus on|off      — toggle auto-augment\n' +
    '  /gitnexus <pattern>   — manual graph lookup\n' +
    '  /gitnexus query <q>   — search execution flows\n' +
    '  /gitnexus context <n> — callers/callees of a symbol\n' +
    '  /gitnexus impact <n>  — blast radius of a change',
    'info',
  );
}

// ── Main menu ───────────────────────────────────────────────────────────────

export async function openMainMenu(mctx: MenuContext): Promise<void> {
  const mainMenu = async (): Promise<void> => {
    const statusLine = await getStatusLine(mctx);
    const title = `GitNexus\n${statusLine}`;
    const choices = [
      'Analyze',
      'Settings',
      'Help',
    ];
    const choice = await mctx.ui.select(title, choices);
    if (!choice) return;
    if (choice === 'Analyze') {
      await runAnalyze(mctx);
      return mainMenu();
    }
    if (choice === 'Settings') {
      await openSettingsMenu(mctx.ui, mctx.cfg, mctx.state, async () => {
        mctx.syncState();
      });
      return mainMenu();
    }
    if (choice === 'Help') {
      showHelp(mctx);
      return mainMenu();
    }
  };
  await mainMenu();
}
