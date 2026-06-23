import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  classifyAugmentTool,
  expandUserPath,
  extractFilesFromReadMany,
  extractLiteralFromRegex,
  extractPattern,
  findGitNexusRoot,
  getAugmentToolAliases,
  normalizePathArg,
  resolveGitNexusCmd,
  validateRepoRelativePath,
} from '../src/gitnexus';

describe('gitnexus helpers', () => {
  it('prefers saved config over the empty default flag value', () => {
    expect(resolveGitNexusCmd('', 'npx gitnexus@latest')).toEqual(['npx', 'gitnexus@latest']);
    expect(resolveGitNexusCmd(undefined, 'npx gitnexus@latest')).toEqual(['npx', 'gitnexus@latest']);
    expect(resolveGitNexusCmd('gitnexus --debug', 'npx gitnexus@latest')).toEqual(['gitnexus', '--debug']);
  });

  it('finds the nearest gitnexus repo root even from deep nested directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-gitnexus-root-'));
    const nested = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    mkdirSync(join(root, '.gitnexus'));
    mkdirSync(nested, { recursive: true });

    try {
      expect(findGitNexusRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('augments markdown reads and read_many batches', () => {
    expect(extractPattern('read', { path: '/repo/README.md' })).toBe('README');
    expect(
      extractFilesFromReadMany(
        {
          files: [
            { path: '/repo/docs/ARCHITECTURE.md' },
            { path: '/repo/src/index.ts' },
          ],
        },
        [],
      ),
    ).toEqual([
      { path: '/repo/docs/ARCHITECTURE.md', pattern: 'ARCHITECTURE' },
      { path: '/repo/src/index.ts', pattern: 'index' },
    ]);
  });

  it('normalizes path args with a leading @ prefix', () => {
    expect(normalizePathArg('@src/auth.ts')).toBe('src/auth.ts');
    expect(normalizePathArg('src/auth.ts')).toBe('src/auth.ts');
  });

  it('expands ~/ repo paths before filesystem resolution', () => {
    expect(expandUserPath('~/demo')).toBe(join(homedir(), 'demo'));
    expect(expandUserPath('/tmp/demo')).toBe('/tmp/demo');
  });

  it('rejects invalid repo-relative paths', () => {
    expect(validateRepoRelativePath('src/auth.ts')).toBe('src/auth.ts');
    expect(validateRepoRelativePath('../etc/passwd')).toBeNull();
    expect(validateRepoRelativePath('/etc/passwd')).toBeNull();
    expect(validateRepoRelativePath('')).toBeNull();
  });
});

describe('extractLiteralFromRegex', () => {
  it('returns plain identifiers unchanged', () => {
    expect(extractLiteralFromRegex('validateUser')).toBe('validateUser');
    expect(extractLiteralFromRegex('foo_bar')).toBe('foo_bar');
  });

  it('extracts longest literal from regex with metacharacters', () => {
    // Foo, Bar, Baz are all 3 chars — Foo is found first
    expect(extractLiteralFromRegex('(Foo|Bar)Baz')).toBe('Foo');
    expect(extractLiteralFromRegex('foo\\.bar')).toBe('foo');
    expect(extractLiteralFromRegex('^export\\s+function\\s+(\\w+)')).toBe('function');
  });

  it('handles alternation — picks longest branch', () => {
    expect(extractLiteralFromRegex('(validateUser|check)')).toBe('validateUser');
  });

  it('returns null for patterns with no valid identifier', () => {
    expect(extractLiteralFromRegex('.*')).toBeNull();
    expect(extractLiteralFromRegex('^$')).toBeNull();
    expect(extractLiteralFromRegex('ab')).toBeNull(); // too short
  });

  it('strips surrounding quotes', () => {
    expect(extractLiteralFromRegex('"validateUser"')).toBe('validateUser');
    expect(extractLiteralFromRegex("'authenticate'")).toBe('authenticate');
  });
});

describe('augment tool aliases', () => {
  it('uses defaults when no env vars are set', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(getAugmentToolAliases(env)).toEqual({
      read: ['read'],
      read_many: ['read_many'],
      grep: ['grep'],
      find: ['find'],
      bash: ['bash'],
    });
    expect(classifyAugmentTool('grep', env)).toBe('grep');
    expect(classifyAugmentTool('read', env)).toBe('read');
    expect(classifyAugmentTool('ctx_grep', env)).toBeNull();
    expect(classifyAugmentTool('ctx_read', env)).toBeNull();
  });

  it('supports csv env overrides', () => {
    const env: NodeJS.ProcessEnv = {
      GITNEXUS_AUGMENT_GREP_TOOLS: 'grep,ctx_grep',
      GITNEXUS_AUGMENT_READ_TOOLS: 'read,ctx_read',
    };
    expect(classifyAugmentTool('ctx_grep', env)).toBe('grep');
    expect(classifyAugmentTool('ctx_read', env)).toBe('read');
  });

  it('supports pi-lean-ctx preset', () => {
    const env: NodeJS.ProcessEnv = { GITNEXUS_AUGMENT_PRESET: 'pi-lean-ctx' };
    expect(classifyAugmentTool('ctx_read', env)).toBe('read');
    expect(classifyAugmentTool('ctx_grep', env)).toBe('grep');
    expect(classifyAugmentTool('ctx_find', env)).toBe('find');
    expect(classifyAugmentTool('ctx_shell', env)).toBe('bash');
  });

  it('lets explicit env override preset per kind', () => {
    const env: NodeJS.ProcessEnv = {
      GITNEXUS_AUGMENT_PRESET: 'pi-lean-ctx',
      GITNEXUS_AUGMENT_GREP_TOOLS: 'grep,my_grep',
    };
    expect(classifyAugmentTool('my_grep', env)).toBe('grep');
    expect(classifyAugmentTool('ctx_grep', env)).toBeNull();
    expect(classifyAugmentTool('ctx_read', env)).toBe('read');
  });
});

describe('extractPattern — grep', () => {
  it('extracts literal from simple pattern', () => {
    expect(extractPattern('grep', { pattern: 'validateUser' })).toBe('validateUser');
  });

  it('extracts literal from regex pattern', () => {
    expect(extractPattern('grep', { pattern: '(Foo|Bar)' })).toBe('Foo');
    expect(extractPattern('grep', { pattern: 'foo\\.bar' })).toBe('foo');
  });

  it('returns null for pure metacharacter patterns', () => {
    expect(extractPattern('grep', { pattern: '.*' })).toBeNull();
  });
});

describe('extractPattern — bash with quotes and pipes', () => {
  it('extracts pattern from quoted grep args', () => {
    expect(extractPattern('bash', { command: 'grep "validateUser" src/' })).toBe('validateUser');
    expect(extractPattern('bash', { command: "grep 'authenticate' src/" })).toBe('authenticate');
  });

  it('handles piped commands — only parses the grep segment', () => {
    expect(extractPattern('bash', { command: 'grep validateUser src/ | head -5' })).toBe('validateUser');
    expect(extractPattern('bash', { command: 'cat file.txt | grep validateUser' })).toBe('validateUser');
  });

  it('handles && chained commands', () => {
    expect(extractPattern('bash', { command: 'cd src && grep validateUser *.ts' })).toBe('validateUser');
  });

  it('extracts file basename from cat with quoted path', () => {
    expect(extractPattern('bash', { command: 'cat "src/validator.ts"' })).toBe('validator');
  });
});

describe('extractPattern — read', () => {
  it('extracts basename from code files', () => {
    expect(extractPattern('read', { path: '/repo/src/validator.ts' })).toBe('validator');
    expect(extractPattern('read', { path: '/repo/src/authenticate.py' })).toBe('authenticate');
    expect(extractPattern('read', { path: '/repo/README.md' })).toBe('README');
    expect(extractPattern('read', { path: '/repo/src/index.ts' })).toBe('index');
  });

  it('skips non-code files', () => {
    expect(extractPattern('read', { path: '/repo/data.json' })).toBeNull();
    expect(extractPattern('read', { path: '/repo/image.png' })).toBeNull();
  });

  it('skips basenames shorter than 3 chars', () => {
    expect(extractPattern('read', { path: '/repo/src/ab.ts' })).toBeNull();
  });
});
