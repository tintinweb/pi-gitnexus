import { ChildProcess, spawn } from 'child_process';
import { mcpClient } from './mcp-client';

let analyzeProc: ChildProcess | null = null;

/** Stop any in-flight analyze process. Safe to call when none is running. */
export function stopGitNexusAnalyze(): void {
  if (analyzeProc) {
    analyzeProc.kill('SIGTERM');
    analyzeProc = null;
  }
}

/**
 * Run `gitnexus analyze` as a one-shot child process.
 *
 * The extension's MCP process is stopped before analysis starts so it does not
 * linger across the reindex and does not hold onto stale repo state. It stays
 * stopped after analyze completes; the next tool call will lazily start a fresh
 * MCP server against the updated index.
 */
export async function runGitNexusAnalyze(
  cwd: string,
  gitnexusCmd: string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  mcpClient.stop();
  stopGitNexusAnalyze();

  return new Promise<number | null>((resolve_) => {
    const [bin, ...baseArgs] = gitnexusCmd;
    const proc = spawn(bin, [...baseArgs, 'analyze'], {
      cwd,
      stdio: 'ignore',
      env,
    });
    analyzeProc = proc;

    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (analyzeProc === proc) {
        analyzeProc = null;
      }
      // Keep MCP stopped after reindex so the next request starts a fresh server.
      mcpClient.stop();
      resolve_(code);
    };

    proc.on('close', settle);
    proc.on('error', () => settle(null));
  });
}
