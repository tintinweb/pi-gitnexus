import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const callToolMock = vi.fn();
const sendUserMessageMock = vi.fn();
const notifyMock = vi.fn();
const registerCommandMock = vi.fn();
const registerToolMock = vi.fn();
const registerFlagMock = vi.fn();
const onMock = vi.fn();
const getFlagMock = vi.fn(() => '');

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../src/mcp-client', () => ({
  mcpClient: {
    callTool: callToolMock,
    stop: vi.fn(),
  },
}));

vi.mock('../src/tools', () => ({
  registerTools: vi.fn(),
}));

vi.mock('../src/gitnexus', async () => {
  const actual = await vi.importActual<typeof import('../src/gitnexus')>('../src/gitnexus');
  return {
    ...actual,
    findGitNexusRoot: vi.fn(() => '/repo-root'),
    findGitNexusIndex: vi.fn(() => true),
    loadSavedConfig: vi.fn(() => ({})),
    runAugment: vi.fn(async () => null),
    resolveGitNexusCmd: vi.fn(() => ['gitnexus']),
    updateSpawnEnv: vi.fn(),
    setGitnexusCmd: vi.fn(),
    clearIndexCache: vi.fn(),
  };
});

function makeProc(options?: { stdio?: unknown }) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout?: EventEmitter;
    kill?: (signal?: string) => boolean;
  };
  if (Array.isArray(options?.stdio) && options.stdio[1] === 'pipe') {
    proc.stdout = new EventEmitter();
  }
  proc.kill = vi.fn(() => true);
  queueMicrotask(() => {
    proc.stdout?.emit('data', process.env.PATH ?? '');
    proc.emit('close', 0);
  });
  return proc;
}

describe('/gitnexus command error handling', () => {
  beforeEach(() => {
    callToolMock.mockReset();
    sendUserMessageMock.mockReset();
    notifyMock.mockReset();
    registerCommandMock.mockReset();
    onMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockImplementation((_bin?: string, _args?: string[], options?: { stdio?: unknown }) => makeProc(options));
    vi.resetModules();
  });

  it('catches MCP errors in slash commands and notifies the user', async () => {
    callToolMock.mockRejectedValue(new Error('[GitNexus] repo selection failed'));

    const { default: register } = await import('../src/index');
    register({
      registerTool: registerToolMock,
      registerCommand: registerCommandMock,
      registerFlag: registerFlagMock,
      on: onMock,
      getFlag: getFlagMock,
      sendUserMessage: sendUserMessageMock,
    } as any);

    const command = registerCommandMock.mock.calls[0][1];
    await command.handler('query auth', { cwd: '/outside/repo', ui: { notify: notifyMock } });

    expect(notifyMock).toHaveBeenCalledWith('[GitNexus] repo selection failed', 'error');
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });

  it('runs analyze through the centralized helper path', async () => {
    const { default: register } = await import('../src/index');
    register({
      registerTool: registerToolMock,
      registerCommand: registerCommandMock,
      registerFlag: registerFlagMock,
      on: onMock,
      getFlag: getFlagMock,
      sendUserMessage: sendUserMessageMock,
    } as any);

    const sessionStartHandler = onMock.mock.calls.find(([event]) => event === 'session_start')?.[1];
    expect(sessionStartHandler).toBeTypeOf('function');
    sessionStartHandler({}, { cwd: '/repo', ui: { notify: notifyMock } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const command = registerCommandMock.mock.calls[0][1];
    await command.handler('analyze', { cwd: '/repo', ui: { notify: notifyMock } });

    expect(
      spawnMock.mock.calls.some(
        ([bin, args, options]) =>
          bin === 'gitnexus' &&
          Array.isArray(args) &&
          args[0] === 'analyze' &&
          options?.cwd === '/repo' &&
          options?.stdio === 'ignore',
      ),
    ).toBe(true);
    expect(notifyMock).toHaveBeenCalledWith('GitNexus: analysis complete. Knowledge graph ready.', 'info');
  });
});
