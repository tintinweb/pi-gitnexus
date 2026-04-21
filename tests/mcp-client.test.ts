import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.useFakeTimers();

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../src/gitnexus', () => ({
  MAX_OUTPUT_CHARS: 8 * 1024,
  spawnEnv: process.env,
  gitnexusCmd: ['gitnexus'],
}));

class FakeStream extends EventEmitter {
  write = vi.fn();
  setEncoding = vi.fn();
}

describe('mcp-client error behavior', () => {
  beforeEach(async () => {
    spawnMock.mockReset();
    vi.resetModules();
  });

  it('throws when the MCP tool response is flagged as an error', async () => {
    const stdout = new FakeStream();
    const stdin = new FakeStream();
    const proc = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stdin: FakeStream;
      kill: (signal?: string) => boolean;
    };
    proc.stdout = stdout;
    proc.stdin = stdin;
    proc.kill = vi.fn(() => true);

    let callId: number | undefined;
    stdin.write.mockImplementation((payload: string) => {
      const msg = JSON.parse(payload.trim());
      if (msg.method === 'initialize') {
        queueMicrotask(() => stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n'));
      } else if (msg.method === 'tools/call') {
        callId = msg.id;
        queueMicrotask(() => stdout.emit('data', JSON.stringify({
          jsonrpc: '2.0',
          id: callId,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'repo selection failed' }],
          },
        }) + '\n'));
      }
      return true;
    });

    spawnMock.mockReturnValue(proc);

    const { mcpClient } = await import('../src/mcp-client');

    await expect(mcpClient.callTool('query', { query: 'auth' }, '/repo')).rejects.toThrow('[GitNexus] repo selection failed');
    mcpClient.stop();
  });

  it('kills a starting MCP process when stop() is called before initialize completes', async () => {
    const stdout = new FakeStream();
    const stdin = new FakeStream();
    const proc = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stdin: FakeStream;
      kill: (signal?: string) => boolean;
    };
    proc.stdout = stdout;
    proc.stdin = stdin;
    proc.kill = vi.fn(() => true);

    stdin.write.mockReturnValue(true);
    spawnMock.mockReturnValue(proc);

    const { mcpClient } = await import('../src/mcp-client');
    const pending = mcpClient.callTool('query', { query: 'auth' }, '/repo');

    mcpClient.stop();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(pending).rejects.toThrow('[GitNexus] MCP client stopped');
  });

  it('stops an idle MCP process one minute after the last tool call', async () => {
    const stdout = new FakeStream();
    const stdin = new FakeStream();
    const proc = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stdin: FakeStream;
      kill: (signal?: string) => boolean;
    };
    proc.stdout = stdout;
    proc.stdin = stdin;
    proc.kill = vi.fn(() => true);

    let callId: number | undefined;
    stdin.write.mockImplementation((payload: string) => {
      const msg = JSON.parse(payload.trim());
      if (msg.method === 'initialize') {
        queueMicrotask(() => stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n'));
      } else if (msg.method === 'tools/call') {
        callId = msg.id;
        queueMicrotask(() => stdout.emit('data', JSON.stringify({
          jsonrpc: '2.0',
          id: callId,
          result: {
            content: [{ type: 'text', text: 'ok' }],
          },
        }) + '\n'));
      }
      return true;
    });

    spawnMock.mockReturnValue(proc);

    const { mcpClient } = await import('../src/mcp-client');

    await expect(mcpClient.callTool('query', { query: 'auth' }, '/repo')).resolves.toContain('ok');
    expect(proc.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(proc.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
