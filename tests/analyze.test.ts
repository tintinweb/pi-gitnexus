import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
const stopMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../src/mcp-client', () => ({
  mcpClient: {
    stop: stopMock,
  },
}));

describe('runGitNexusAnalyze', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    stopMock.mockReset();
    vi.resetModules();
  });

  it('stops MCP before analyze and again after completion', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      kill: (signal?: string) => boolean;
    };
    proc.kill = vi.fn(() => true);
    spawnMock.mockReturnValue(proc);

    const { runGitNexusAnalyze } = await import('../src/analyze');
    const promise = runGitNexusAnalyze('/repo', ['gitnexus'], process.env);

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('gitnexus', ['analyze'], {
      cwd: '/repo',
      stdio: 'ignore',
      env: process.env,
    });

    proc.emit('close', 0);
    await expect(promise).resolves.toBe(0);
    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  it('kills an in-flight analyze process before starting a new one', async () => {
    const first = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
    first.kill = vi.fn(() => true);
    const second = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
    second.kill = vi.fn(() => true);
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const { runGitNexusAnalyze } = await import('../src/analyze');
    const firstRun = runGitNexusAnalyze('/repo', ['gitnexus'], process.env);
    const secondRun = runGitNexusAnalyze('/repo', ['gitnexus'], process.env);

    expect(first.kill).toHaveBeenCalledWith('SIGTERM');

    first.emit('close', null);
    second.emit('close', 0);

    await expect(firstRun).resolves.toBeNull();
    await expect(secondRun).resolves.toBe(0);
  });
});
