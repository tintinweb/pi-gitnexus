import { spawn } from 'child_process';
import { resolve, sep, basename, extname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';

/** Max output chars returned to the LLM. Prevents context flooding. JS strings are UTF-16 chars, not bytes. */
export const MAX_OUTPUT_CHARS = 8 * 1024;

/**
 * Environment passed to all child processes.
 * Resolved from a login shell on session_start to pick up nvm/fnm/volta PATH entries
 * that are missing when pi launches as a GUI app.
 */
export let spawnEnv: NodeJS.ProcessEnv = process.env;
export function updateSpawnEnv(env: NodeJS.ProcessEnv): void { spawnEnv = env; }

/**
 * Resolved command prefix for invoking gitnexus.
 * Set to ['gitnexus'] when the binary is on PATH, otherwise ['npx', '-y', 'gitnexus@latest'].
 * Updated by setGitnexusCmd() during session_start probe.
 */
export let gitnexusCmd: string[] = ['gitnexus'];
export function setGitnexusCmd(cmd: string[]): void { gitnexusCmd = cmd; }

const CONFIG_PATH = join(homedir(), '.pi', 'pi-gitnexus.json');

interface GitNexusConfig {
  cmd?: string;
}

export function loadSavedConfig(): GitNexusConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as GitNexusConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: GitNexusConfig): void {
  try {
    mkdirSync(join(homedir(), '.pi'), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  } catch { /* ignore write errors */ }
}

/** Augment subprocess timeout in ms. Applied via setTimeout + proc.kill('SIGTERM') — spawn has no built-in timeout. */
const AUGMENT_TIMEOUT = 8_000;

/** Per-cwd cache: true = index found, false = not found. Invalidated on session_switch. */
const indexCache = new Map<string, boolean>();

/** Walk up to 5 ancestors looking for a .gitnexus/ directory. Result is cached per cwd. */
export function findGitNexusIndex(cwd: string): boolean {
  if (indexCache.has(cwd)) return indexCache.get(cwd)!;
  let dir = cwd;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, '.gitnexus'))) {
      indexCache.set(cwd, true);
      return true;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  indexCache.set(cwd, false);
  return false;
}

/** Clear the index cache. Call on session_switch when cwd may have changed. */
export function clearIndexCache(): void {
  indexCache.clear();
}

/** File extensions worth augmenting when the agent reads a file. */
const CODE_EXTENSIONS = new Set([
  '.sol', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.vy', '.fe', '.huff',
]);

/**
 * Extract the primary search pattern from a tool's input object.
 *
 * grep  → input.pattern
 * find  → basename of the glob pattern (e.g. "**\/foo.ts" → "foo")
 * bash  → grep/rg pattern, find -name value, or cat/head/tail filename
 * read  → basename of the file path (code files only)
 *
 * Returns null if pattern is missing or shorter than 3 chars.
 */
export function extractPattern(toolName: string, input: Record<string, unknown>): string | null {
  let pattern: string | null = null;

  if (toolName === 'grep') {
    const raw = typeof input.pattern === 'string' ? input.pattern : null;
    // Strip regex metacharacters — gitnexus augment expects a plain symbol/identifier name.
    pattern = raw ? raw.replace(/[\\^$.*+?()[\]{}|]/g, '') : null;
  } else if (toolName === 'find') {
    // pi's find tool field name is unconfirmed — try common variants
    const raw =
      typeof input.pattern === 'string' ? input.pattern :
      typeof input.glob    === 'string' ? input.glob    :
      typeof input.path    === 'string' ? input.path    :
      null;
    if (raw) {
      const seg = basename(raw).replace(/\.\w+$/, '').replace(/[*?[\]{}]/g, '');
      pattern = seg || null;
    }
  } else if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let foundFileCmd = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      // grep/rg: first non-flag arg after the command is the search pattern
      if (tok === 'grep' || tok === 'rg') { foundCmd = true; foundFileCmd = false; continue; }
      if (foundCmd) {
        if (tok.startsWith('-')) continue;
        // Strip quotes and regex metacharacters — gitnexus augment expects a plain symbol name.
        pattern = tok.replace(/['"]/g, '').replace(/[\\^$.*+?()[\]{}|]/g, '');
        break;
      }

      // cat / head / tail / less / wc: next non-flag arg is a file path → use basename
      if (tok === 'cat' || tok === 'head' || tok === 'tail' || tok === 'less' || tok === 'wc') {
        foundFileCmd = true; foundCmd = false; continue;
      }
      if (foundFileCmd) {
        if (tok.startsWith('-')) continue;
        const unquoted = tok.replace(/['"]/g, '');
        const ext = extname(unquoted);
        if (CODE_EXTENSIONS.has(ext)) {
          pattern = basename(unquoted).replace(/\.\w+$/, '');
        }
        break;
      }

      // find -name / -iname: strip glob chars and extension from value
      if (tok === 'find') { foundCmd = false; foundFileCmd = false; continue; }
      if ((tok === '-name' || tok === '-iname') && tokens[i + 1]) {
        const unquoted = tokens[i + 1].replace(/['"]/g, '');
        const seg = basename(unquoted).replace(/\.\w+$/, '').replace(/[*?[\]{}]/g, '');
        if (seg.length >= 3) { pattern = seg; }
        break;
      }
    }
  } else if (toolName === 'read') {
    const raw = typeof input.path === 'string' ? input.path : null;
    if (raw && CODE_EXTENSIONS.has(extname(raw))) {
      pattern = basename(raw).replace(/\.\w+$/, '');
    }
  }

  if (!pattern || pattern.length < 3) return null;
  return pattern;
}

/**
 * Extract { path, pattern } pairs from a read_many tool input.
 * read_many input is { files: Array<{ path: string, ... }> }.
 * Falls back to scanning content for @path lines if input lacks a files array.
 * Returns code files only, deduplicated by basename pattern.
 */
export function extractFilesFromReadMany(
  input: Record<string, unknown>,
  content: { type: string; text?: string }[],
): Array<{ path: string; pattern: string }> {
  const seen = new Set<string>();
  const results: Array<{ path: string; pattern: string }> = [];

  const add = (filePath: string) => {
    const ext = extname(filePath);
    if (!CODE_EXTENSIONS.has(ext)) return;
    const pattern = basename(filePath).replace(/\.\w+$/, '');
    if (pattern.length < 3 || seen.has(pattern)) return;
    seen.add(pattern);
    results.push({ path: filePath, pattern });
  };

  // Primary: extract from structured input
  const files = Array.isArray(input.files) ? input.files : [];
  for (const f of files) {
    if (typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).path === 'string') {
      add((f as Record<string, unknown>).path as string);
    }
  }

  // Fallback: parse @path lines from content (if input was empty/unknown)
  if (results.length === 0) {
    const text = content.map(c => c.text ?? '').join('\n');
    for (const line of text.split('\n')) {
      const m = line.match(/^@(.+)$/);
      if (m) add(m[1].trim());
    }
  }

  return results;
}

/**
 * Extract up to `limit` unique file basenames (without extension) from
 * grep-style output lines of the form "path/to/file.ext:lineno:content".
 * Used to augment secondary context from search results.
 */
export function extractFilePatternsFromContent(
  content: { type: string; text?: string }[],
  limit = 2,
): string[] {
  const text = content.map(c => c.text ?? '').join('\n');
  const seen = new Set<string>();
  const results: string[] = [];
  for (const line of text.split('\n')) {
    // Match "some/path/File.ext:digits:" at the start of a line
    const m = line.match(/^([^\n:]+\.\w+):\d+:/);
    if (!m) continue;
    const base = basename(m[1]).replace(/\.\w+$/, '');
    if (base.length >= 3 && !seen.has(base)) {
      seen.add(base);
      results.push(base);
    }
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Validate that a file path stays within cwd (path traversal guard).
 * Returns the resolved absolute path, or null if it escapes cwd.
 */
export function safeResolvePath(file: string, cwd: string): string | null {
  const resolved = resolve(cwd, file);
  return resolved.startsWith(cwd + sep) || resolved === cwd ? resolved : null;
}

/**
 * Spawn `gitnexus augment <pattern>` and return its output.
 * gitnexus augment writes results to stderr (not stdout).
 * Used by the tool_result hook — not by registered tools (those use mcp-client).
 * Returns output trimmed and truncated to MAX_OUTPUT_CHARS, or "" on any error.
 */
export async function runAugment(pattern: string, cwd: string): Promise<string> {
  return new Promise((resolve_) => {
    // gitnexus augment writes results to stderr (not stdout)
    let output = '';
    let done = false;

    const [bin, ...baseArgs] = gitnexusCmd;
    const proc = spawn(bin, [...baseArgs, 'augment', pattern], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: spawnEnv,
    });

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill('SIGTERM');
        resolve_('');
      }
    }, AUGMENT_TIMEOUT);

    proc.stderr.on('data', (chunk: { toString(): string }) => { output += chunk.toString(); });

    proc.on('close', (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve_(code === 0 ? output.trim().slice(0, MAX_OUTPUT_CHARS) : '');
    });

    proc.on('error', () => {
      if (!done) { done = true; clearTimeout(timer); resolve_(''); }
    });
  });
}
