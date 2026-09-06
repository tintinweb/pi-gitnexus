import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAugmentMock = vi.fn();
const findGitNexusIndexMock = vi.fn(() => true);
const findGitNexusRootMock = vi.fn(() => '/repo-root');
const registerToolMock = vi.fn();
const registerCommandMock = vi.fn();
const registerFlagMock = vi.fn();
const getFlagMock = vi.fn(() => '');
const sendUserMessageMock = vi.fn();

let toolResultHandlers: Array<(event: any, ctx: any) => Promise<any>>;
type BeforeAgentStartHandler = (
  event: { systemPrompt?: string | string[] },
  ctx: { cwd: string },
) => Promise<{ systemPrompt?: string } | undefined>;
let beforeAgentStartHandlers: BeforeAgentStartHandler[];
let onMock: ReturnType<typeof vi.fn>;

vi.mock('../src/mcp-client', () => ({
  mcpClient: { callTool: vi.fn(), stop: vi.fn() },
}));

vi.mock('../src/tools', () => ({
  registerTools: vi.fn(),
}));

vi.mock('../src/ui/main-menu', () => ({
  openMainMenu: vi.fn(),
}));

vi.mock('../src/gitnexus', async () => {
  const actual = await vi.importActual<typeof import('../src/gitnexus')>('../src/gitnexus');
  return {
    ...actual,
    findGitNexusRoot: findGitNexusRootMock,
    findGitNexusIndex: findGitNexusIndexMock,
    loadSavedConfig: vi.fn(() => ({})),
    runAugment: runAugmentMock,
    resolveGitNexusCmd: vi.fn(() => ['gitnexus']),
    updateSpawnEnv: vi.fn(),
    setGitnexusCmd: vi.fn(),
    setAugmentTimeout: vi.fn(),
    clearIndexCache: vi.fn(),
    spawnEnv: process.env,
    gitnexusCmd: ['gitnexus'],
  };
});

function createPi() {
  toolResultHandlers = [];
  beforeAgentStartHandlers = [];
  onMock = vi.fn((event: string, handler: any) => {
    if (event === 'tool_result') toolResultHandlers.push(handler);
    if (event === 'before_agent_start') beforeAgentStartHandlers.push(handler);
  });
  return {
    registerTool: registerToolMock,
    registerCommand: registerCommandMock,
    registerFlag: registerFlagMock,
    on: onMock,
    getFlag: getFlagMock,
    sendUserMessage: sendUserMessageMock,
  };
}

async function fireToolResult(event: any) {
  const ctx = { cwd: '/repo-root' };
  for (const handler of toolResultHandlers) {
    const result = await handler(event, ctx);
    if (result) return result;
  }
  return undefined;
}

async function fireBeforeAgentStart(systemPrompt: string | string[]): Promise<string | string[] | undefined> {
  const ctx = { cwd: '/repo-root' };
  for (const handler of beforeAgentStartHandlers) {
    const result = await handler({ systemPrompt }, ctx);
    if (result) return result.systemPrompt;
  }
  return undefined;
}

describe('auto-augment hook', () => {
  beforeEach(async () => {
    runAugmentMock.mockReset();
    findGitNexusIndexMock.mockReturnValue(true);
    vi.resetModules();
  });

  it('appends graph context to grep results', async () => {
    runAugmentMock.mockResolvedValue('Called by: login, signup');

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const result = await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'validateUser' },
      content: [{ type: 'text', text: 'src/auth.ts:42:function validateUser()' }],
    });

    expect(runAugmentMock).toHaveBeenCalledWith('validateUser', '/repo-root');
    expect(result).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain('[GitNexus');
    expect(result.content[1].text).toContain('Called by: login, signup');
    // Verify --- delimiters
    expect(result.content[1].text).toContain('---');
  });

  it('skips non-search tools', async () => {
    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const result = await fireToolResult({
      toolName: 'write',
      input: { path: '/foo.ts' },
      content: [{ type: 'text', text: 'ok' }],
    });

    expect(result).toBeUndefined();
    expect(runAugmentMock).not.toHaveBeenCalled();
  });

  it('skips when no index found', async () => {
    findGitNexusIndexMock.mockReturnValue(false);

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const result = await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'validateUser' },
      content: [{ type: 'text', text: 'match' }],
    });

    expect(result).toBeUndefined();
    expect(runAugmentMock).not.toHaveBeenCalled();
  });

  it('deduplicates patterns within a session (case-insensitive)', async () => {
    runAugmentMock.mockResolvedValue('context');

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    // First call — should augment (primary only, content has no secondary file patterns)
    await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'validateUser' },
      content: [{ type: 'text', text: 'found validateUser in codebase' }],
    });
    expect(runAugmentMock).toHaveBeenCalledTimes(1);

    // Second call same pattern different case — should skip
    const result = await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'ValidateUser' },
      content: [{ type: 'text', text: 'found ValidateUser in codebase' }],
    });
    expect(runAugmentMock).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('returns undefined when augment returns empty', async () => {
    runAugmentMock.mockResolvedValue('');

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const result = await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'somethingNew' },
      content: [{ type: 'text', text: 'src/auth.ts:1:match' }],
    });

    expect(result).toBeUndefined();
  });

  it('caches empty results and skips on second attempt', async () => {
    runAugmentMock.mockResolvedValue('');

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    // First call — augment returns empty, cached in emptyCache (no secondary patterns)
    await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'emptySymbol' },
      content: [{ type: 'text', text: 'found emptySymbol in codebase' }],
    });
    expect(runAugmentMock).toHaveBeenCalledTimes(1);

    // Second call — should skip (in emptyCache)
    await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'emptySymbol' },
      content: [{ type: 'text', text: 'found emptySymbol in codebase' }],
    });
    expect(runAugmentMock).toHaveBeenCalledTimes(1);
  });

  it('augments read tool with file basename', async () => {
    runAugmentMock.mockResolvedValue('callers: main');

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const result = await fireToolResult({
      toolName: 'read',
      input: { path: '/repo/src/validator.ts' },
      content: [{ type: 'text', text: 'file contents here' }],
    });

    expect(runAugmentMock).toHaveBeenCalledWith('validator', '/repo-root');
    expect(result).toBeDefined();
    expect(result.content[1].text).toContain('callers: main');
  });

  it('extracts secondary patterns from grep output', async () => {
    runAugmentMock.mockResolvedValue('context for symbol');

    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const result = await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'authenticate' },
      content: [{ type: 'text', text: 'src/auth/handler.ts:10:authenticate()\nsrc/utils/validator.ts:5:check()' }],
    });

    // Should have called augment for primary + secondary file patterns
    expect(runAugmentMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(result).toBeDefined();
  });

  it('skips enrichment when tool content is too short', async () => {
    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const result = await fireToolResult({
      toolName: 'grep',
      input: { pattern: 'validateUser' },
      content: [{ type: 'text', text: '' }],
    });

    expect(result).toBeUndefined();
    expect(runAugmentMock).not.toHaveBeenCalled();
  });

  it('appends note to pi string systemPrompt', async () => {
    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const out = await fireBeforeAgentStart('base prompt');
    expect(typeof out).toBe('string');
    expect(out as string).toContain('base prompt');
    expect(out as string).toContain('[GitNexus active]');
  });

  it('appends note to omp string[] systemPrompt without comma-mangling', async () => {
    const { default: register } = await import('../src/index');
    register(createPi() as any);

    const out = await fireBeforeAgentStart(['part one', 'part two']);
    expect(Array.isArray(out)).toBe(true);
    const arr = out as string[];
    expect(arr).toHaveLength(3);
    expect(arr[0]).toBe('part one');
    expect(arr[1]).toBe('part two');
    expect(arr[2]).toContain('[GitNexus active]');
    // The old string-concat bug would have produced "part one,part two" as a single element.
    expect(arr.join('')).not.toContain('part one,part two');
  });
});
