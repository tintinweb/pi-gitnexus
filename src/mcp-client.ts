import { spawn, ChildProcess } from 'child_process';
import { MAX_OUTPUT_CHARS, spawnEnv, gitnexusCmd } from './gitnexus';

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
 * kept alive for the session lifetime. stop() terminates it; the next callTool()
 * re-spawns with the new cwd.
 */
class GitNexusMcpClient {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<number, { resolve: (raw: string) => void; reject: (e: Error) => void }>();
  private nextId = 2; // id 1 is reserved for the initialize handshake
  private startPromise: Promise<void> | null = null;

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

      proc.on('error', (err) => {
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
        this.proc = null;
        this.startPromise = null;
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
          this.proc = proc;
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
   * Returns "" on any error (graceful failure, same as the augment hook).
   */
  async callTool(name: string, args: Record<string, unknown>, cwd: string): Promise<string> {
    try {
      await this.ensureStarted(cwd);
    } catch {
      return '';
    }

    if (!this.proc) return '';

    const id = this.nextId++;
    return new Promise<string>((resolve_) => {
      this.pending.set(id, {
        resolve: (raw: string) => {
          try {
            const msg = JSON.parse(raw) as JsonRpcResponse;
            if (msg.error) { resolve_(''); return; }
            const result = msg.result as McpToolResult | undefined;
            if (!result?.content || result.isError) { resolve_(''); return; }
            const text = result.content
              .filter((c) => c.type === 'text' && !c.isError && c.text)
              .map((c) => c.text!)
              .join('\n');
            resolve_('[GitNexus]\n' + text.slice(0, MAX_OUTPUT_CHARS));
          } catch {
            resolve_('');
          }
        },
        reject: () => resolve_(''),
      });

      const msg = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });

      try {
        this.proc!.stdin!.write(msg + '\n');
      } catch {
        this.pending.delete(id);
        resolve_('');
      }
    });
  }

  /** Terminate the MCP process. Called on session_switch so the next session gets a fresh process. */
  stop(): void {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.startPromise = null;
    for (const p of this.pending.values()) {
      p.reject(new Error('MCP client stopped'));
    }
    this.pending.clear();
  }
}

export const mcpClient = new GitNexusMcpClient();
