import { ChildProcess, spawn } from 'child_process';
import { gitnexusCmd, MAX_OUTPUT_CHARS, spawnEnv } from './gitnexus';

const MCP_IDLE_TIMEOUT_MS = 60_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpContent {
  type: string;
  text?: string;
  isError?: boolean;
}

interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Thin stdio JSON-RPC 2.0 client for `gitnexus mcp`.
 *
 * Communication is exclusively over the spawned process's stdin/stdout pipe —
 * no network socket, no port. Only our process can write to the pipe.
 *
 * The MCP process is started lazily on the first callTool() invocation and
 * is automatically stopped after 60 seconds of inactivity. stop() terminates it;
 * the next callTool() re-spawns with the new cwd.
 */
class GitNexusMcpClient {
  private proc: ChildProcess | null = null;
  private startingProc: ChildProcess | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private buffer = '';
  private pending = new Map<number, { resolve: (raw: string) => void; reject: (e: Error) => void }>();
  private nextId = 2; // id 1 is reserved for the initialize handshake
  private startPromise: Promise<void> | null = null;

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.stop();
    }, MCP_IDLE_TIMEOUT_MS);
  }

  /**
   * Lazily spawn `gitnexus mcp` and complete the MCP initialize handshake.
   * Idempotent — concurrent calls await the same promise; only one process spawns.
   */
  private ensureStarted(cwd: string): Promise<void> {
    if (this.proc) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<void>((resolve_, reject) => {
      const [bin, ...baseArgs] = gitnexusCmd;
      const proc = spawn(bin, [...baseArgs, 'mcp'], {
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: spawnEnv,
      });
      this.startingProc = proc;

      proc.on('error', (err) => {
        if (this.startingProc === proc) this.startingProc = null;
        if (this.proc === proc) this.proc = null;
        this.clearIdleTimer();
        this.buffer = '';
        this.nextId = 2;
        this.startPromise = null;
        reject(err);
      });

      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (msg.id !== undefined) {
              const p = this.pending.get(msg.id);
              if (p) { this.pending.delete(msg.id); p.resolve(line); }
            }
          } catch { /* ignore malformed lines */ }
        }
      });

      proc.on('close', () => {
        if (this.startingProc === proc) this.startingProc = null;
        if (this.proc === proc) this.proc = null;
        this.clearIdleTimer();
        this.startPromise = null;
        this.buffer = '';
        this.nextId = 2;
        for (const p of this.pending.values()) {
          p.reject(new Error('gitnexus mcp process exited'));
        }
        this.pending.clear();
      });

      // MCP initialize handshake
      const initMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pi-gitnexus', version: '0.1.0' },
        },
      });

      this.pending.set(1, {
        resolve: () => {
          proc.stdin!.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
          );
          this.startingProc = null;
          this.proc = proc;
          this.scheduleIdleStop();
          resolve_();
        },
        reject: (err) => {
          this.startPromise = null;
          reject(err);
        },
      });

      proc.stdin!.write(initMsg + '\n');
    });

    return this.startPromise;
  }

  /**
   * Call a gitnexus MCP tool and return its formatted text response.
   * Starts the MCP process lazily if not already running.
   * Throws on transport/MCP failures so pi marks the tool call as an error.
   */
  async callTool(name: string, args: Record<string, unknown>, cwd: string): Promise<string> {
    this.clearIdleTimer();

    try {
      await this.ensureStarted(cwd);
    } catch (error) {
      throw this.createError(error, 'Failed to start gitnexus mcp');
    }

    if (!this.proc) throw new Error('GitNexus MCP is not running.');

    const id = this.nextId++;
    return new Promise<string>((resolve_, reject_) => {
      this.pending.set(id, {
        resolve: (raw: string) => {
          try {
            const msg = JSON.parse(raw) as JsonRpcResponse;
            if (msg.error) {
              this.scheduleIdleStop();
              reject_(this.createError(msg.error.message));
              return;
            }
            const result = msg.result as McpToolResult | undefined;
            if (!result?.content) {
              this.scheduleIdleStop();
              reject_(this.createError('No response content returned from GitNexus MCP.'));
              return;
            }
            const text = result.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text!)
              .join('\n');
            if (result.isError) {
              this.scheduleIdleStop();
              reject_(this.createError(text || 'GitNexus MCP reported an error with no text payload.'));
              return;
            }
            if (!text) {
              this.scheduleIdleStop();
              reject_(this.createError('GitNexus MCP returned an empty response.'));
              return;
            }
            this.scheduleIdleStop();
            resolve_('[GitNexus]\n' + text.slice(0, MAX_OUTPUT_CHARS));
          } catch (error) {
            this.scheduleIdleStop();
            reject_(this.createError(error, 'Malformed response from GitNexus MCP.'));
          }
        },
        reject: (error) => {
          this.scheduleIdleStop();
          reject_(this.createError(error, 'GitNexus MCP request failed.'));
        },
      });

      const msg = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });

      try {
        this.proc!.stdin!.write(msg + '\n');
      } catch (error) {
        this.pending.delete(id);
        this.scheduleIdleStop();
        reject_(this.createError(error, 'Failed to write request to GitNexus MCP.'));
      }
    });
  }

  private createError(error: unknown, fallback = 'GitNexus MCP request failed.'): Error {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
    return new Error(`[GitNexus] ${message || fallback}`);
  }

  /** Terminate the MCP process. Called on idle timeout, session shutdown, or before reindexing. */
  stop(): void {
    const proc = this.proc;
    const startingProc = this.startingProc;
    this.proc = null;
    this.startingProc = null;
    this.clearIdleTimer();
    this.startPromise = null;
    this.buffer = '';
    this.nextId = 2;

    if (proc) {
      proc.kill('SIGTERM');
    }
    if (startingProc && startingProc !== proc) {
      startingProc.kill('SIGTERM');
    }

    for (const p of this.pending.values()) {
      p.reject(new Error('MCP client stopped'));
    }
    this.pending.clear();
  }
}

export const mcpClient = new GitNexusMcpClient();
