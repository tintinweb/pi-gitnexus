import spawn from 'cross-spawn';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, extname, join, posix, relative, resolve, sep } from 'path';

/** Max output chars returned to the LLM. Prevents context flooding. JS strings are UTF-16 chars, not bytes. */
export const MAX_OUTPUT_CHARS = 8 * 1024;

/**
 * Environment passed to all child processes.
 * On session_start, the agent's PATH is merged with the login shell's PATH
 * (via resolveShellPath) so that nvm/fnm/volta paths are picked up while
 * preserving any directories the agent already had (e.g. ~/.local/share/nvm/…).
 */
export let spawnEnv: NodeJS.ProcessEnv = process.env;
export function updateSpawnEnv(env: NodeJS.ProcessEnv): void { spawnEnv = env; }

/**
 * Resolved command prefix for invoking gitnexus.
 * Defaults to ['gitnexus']; session_start may override it from the flag or saved config.
 */
export let gitnexusCmd: string[] = ['gitnexus'];
export function setGitnexusCmd(cmd: string[]): void { gitnexusCmd = cmd; }

const CONFIG_PATH = join(homedir(), '.pi', 'pi-gitnexus.json');

export interface GitNexusConfig {
  cmd?: string;
  autoAugment?: boolean;
  augmentTimeout?: number;
  maxAugmentsPerResult?: number;
  maxSecondaryPatterns?: number;
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

export function resolveGitNexusCmd(flag: string | undefined, saved: string | undefined): string[] {
  const cmd = flag?.trim() || saved?.trim() || 'gitnexus';
  return cmd.split(/\s+/);
}

export function normalizePathArg(path: string): string {
  return path.startsWith('@') ? path.slice(1) : path;
}

export function expandUserPath(path: string): string {
  return path === '~' || path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path;
}

/** Default augment subprocess timeout in ms. Overridden by config.augmentTimeout. */
const DEFAULT_AUGMENT_TIMEOUT = 8_000;

/** Current augment timeout in ms. Updated by setAugmentTimeout(). */
let augmentTimeout = DEFAULT_AUGMENT_TIMEOUT;

export function setAugmentTimeout(seconds: number): void {
  augmentTimeout = seconds * 1000;
}


/** Per-cwd cache: resolved repo root with .gitnexus, or null if none found. */
const indexRootCache = new Map<string, string | null>();

/** Walk up ancestors looking for a .gitnexus/ directory. Result is cached per cwd. */
export function findGitNexusRoot(cwd: string): string | null {
  if (indexRootCache.has(cwd)) return indexRootCache.get(cwd)!;
  let dir = cwd;
  while (true) {
    if (existsSync(resolve(dir, '.gitnexus'))) {
      indexRootCache.set(cwd, dir);
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  indexRootCache.set(cwd, null);
  return null;
}

export function findGitNexusIndex(cwd: string): boolean {
  return findGitNexusRoot(cwd) != null;
}

/** Clear the index cache. Call on session_start when cwd may have changed. */
export function clearIndexCache(): void {
  indexRootCache.clear();
}

/** File extensions worth augmenting when the agent reads a file. */
const CODE_EXTENSIONS = new Set([
  '.sol', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.vy', '.fe', '.huff', '.md', '.mdx',
]);

/**
 * Extract the longest identifier-like literal from a regex pattern.
 * Splits on metacharacters, returns the longest segment that looks like
 * a code identifier (>= 3 chars, starts with letter/underscore).
 */
export function extractLiteralFromRegex(raw: string): string | null {
  const segments = raw.split(/[\\^$.*+?()[\]{}|]+/);
  let best: string | null = null;
  for (const seg of segments) {
    const clean = seg.replace(/['"]/g, '');
    if (clean.length >= 3 && /^[a-zA-Z_]\w*$/.test(clean)) {
      if (!best || clean.length > best.length) best = clean;
    }
  }
  return best;
}

/**
 * Simple shell-aware tokenizer for bash commands.
 * Respects single/double quotes. Inserts a '|' boundary token at
 * pipe, &&, ||, and ; boundaries so extractPattern can reset state.
 */
function tokenizeBashCmd(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  const flush = () => { if (current) { tokens.push(current); current = ''; } };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (inSingle) {
      if (ch === "'") { inSingle = false; } else { current += ch; }
      continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; } else { current += ch; }
      continue;
    }

    // Command boundaries: |, &&, ||, ;
    if (ch === '|' || ch === ';') {
      flush();
      tokens.push('|'); // boundary marker
      if (ch === '|' && cmd[i + 1] === '|') i++; // skip ||
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      flush();
      tokens.push('|'); // boundary marker
      i++; // skip second &
      continue;
    }

    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }

    if (/\s/.test(ch)) {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return tokens;
}

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
    pattern = raw ? extractLiteralFromRegex(raw) : null;
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
    const tokens = tokenizeBashCmd(cmd);
    let foundCmd = false;
    let foundFileCmd = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      // Reset state at command boundaries (pipe, &&, ||, ;)
      if (tok === '|') { foundCmd = false; foundFileCmd = false; continue; }

      // grep/rg: first non-flag arg after the command is the search pattern
      if (tok === 'grep' || tok === 'rg') { foundCmd = true; foundFileCmd = false; continue; }
      if (foundCmd) {
        if (tok.startsWith('-')) continue;
        pattern = extractLiteralFromRegex(tok);
        break;
      }

      // cat / head / tail / less / wc: next non-flag arg is a file path → use basename
      if (tok === 'cat' || tok === 'head' || tok === 'tail' || tok === 'less' || tok === 'wc') {
        foundFileCmd = true; foundCmd = false; continue;
      }
      if (foundFileCmd) {
        if (tok.startsWith('-')) continue;
        const ext = extname(tok);
        if (CODE_EXTENSIONS.has(ext)) {
          pattern = basename(tok).replace(/\.\w+$/, '');
          break;
        }
        // Non-code file — reset and keep scanning for grep/rg in later segments.
        foundFileCmd = false;
        continue;
      }

      // find -name / -iname: strip glob chars and extension from value
      if (tok === 'find') { foundCmd = false; foundFileCmd = false; continue; }
      if ((tok === '-name' || tok === '-iname') && tokens[i + 1]) {
        const seg = basename(tokens[i + 1]).replace(/\.\w+$/, '').replace(/[*?[\]{}]/g, '');
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

export function toRepoRelativePath(file: string, repoRoot: string): string | null {
  const resolved = safeResolvePath(file, repoRoot);
  if (!resolved) return null;
  return relative(repoRoot, resolved) || '.';
}

export function validateRepoRelativePath(file: string): string | null {
  const normalized = posix.normalize(file.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '') return null;
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) return null;
  return normalized;
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
    }, augmentTimeout);

    proc.stderr!.on('data', (chunk: { toString(): string }) => { output += chunk.toString(); });

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
