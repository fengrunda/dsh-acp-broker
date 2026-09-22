import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

/**
 * Minimal ACP v1 stdio client for DeepSeek Harness.
 *
 * Wire shape (target: dsh 0.1.5-rc.2, `--profile acp`):
 *   - newline-delimited JSON-RPC 2.0 over the child's stdin/stdout
 *   - client -> server: initialize, session/new|list|resume|close|prompt
 *   - server -> client: session/update notifications, optional
 *     session/request_permission requests
 *
 * One connection can run several sessions at once; this class multiplexes them
 * and keeps the child alive until `stop()` is called. It never closes a session
 * on its own — session/close is only sent by an explicit broker `close`.
 */

export interface AcpConnectionOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Per control request timeout (initialize/new/resume/list/close). */
  requestTimeoutMs?: number;
  /** session/prompt settlement timeout. */
  promptTimeoutMs?: number;
}

export interface AcpPromptResult {
  stopReason?: string;
  assistantText: string;
}

export interface AcpSessionSummary {
  sessionId: string;
  cwd?: string;
  [key: string]: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type UpdateListener = (update: Record<string, unknown>) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 900_000;
const STDERR_RING = 50;

export class AcpConnection extends EventEmitter {
  private readonly options: Required<Pick<AcpConnectionOptions, "command" | "args">> &
    AcpConnectionOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: Interface | null = null;
  private stderrReader: Interface | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly updateListeners = new Map<string, Set<UpdateListener>>();
  private readonly stderrLines: string[] = [];
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(options: AcpConnectionOptions) {
    super();
    this.options = options;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isRunning(): boolean {
    return this.child !== null && this.exitInfo === null && !this.closed;
  }

  get stderrTail(): string[] {
    return [...this.stderrLines];
  }

  /** Spawn the ACP child. Idempotent while running. */
  start(): void {
    if (this.child) return;
    this.closed = false;
    this.exitInfo = null;

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => this.handleLine(line));

    this.stderrReader = createInterface({ input: child.stderr });
    this.stderrReader.on("line", (line) => {
      this.stderrLines.push(line);
      if (this.stderrLines.length > STDERR_RING) this.stderrLines.shift();
    });

    child.on("error", (err) => {
      // No bare "error" event here: an EventEmitter with no "error" listener
      // throws. `failAllPending` emits "fatal", which the daemon listens for.
      this.failAllPending(new Error(`ACP child failed to start: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      this.failAllPending(
        new Error(`ACP child exited (${detail})${this.stderrTail.length ? `; stderr: ${this.stderrTail.slice(-3).join(" | ")}` : ""}`),
      );
      this.emit("exit", code, signal);
    });
  }

  async initialize(clientName = "dsh-acp-broker", clientVersion = "0.1.0"): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
    void result;
    this.notify("notifications/initialized");
    this.initialized = true;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async sessionNew(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = (await this.request("session/new", {
      cwd,
      mcpServers,
    })) as { sessionId?: string };
    const sessionId = result?.sessionId;
    if (!sessionId) throw new Error("ACP session/new returned no sessionId");
    return sessionId;
  }

  async sessionList(cwd?: string): Promise<AcpSessionSummary[]> {
    const params: Record<string, unknown> = {};
    if (cwd) params.cwd = cwd;
    const result = (await this.request("session/list", params)) as {
      sessions?: AcpSessionSummary[];
    };
    return result?.sessions ?? [];
  }

  async sessionResume(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<void> {
    await this.request("session/resume", { sessionId, cwd, mcpServers });
  }

  async sessionPrompt(
    sessionId: string,
    text: string,
    onUpdate?: UpdateListener,
  ): Promise<AcpPromptResult> {
    const chunks: string[] = [];
    const listener: UpdateListener = (update) => {
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content && content.type === "text" && typeof content.text === "string") {
          chunks.push(content.text);
        }
      }
      onUpdate?.(update);
    };
    this.addUpdateListener(sessionId, listener);
    try {
      const result = (await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }, this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS)) as {
        stopReason?: string;
      };
      return { stopReason: result?.stopReason, assistantText: chunks.join("").trim() };
    } finally {
      this.removeUpdateListener(sessionId, listener);
    }
  }

  async sessionClose(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId }, 30_000);
  }

  /** Terminate the child and reject outstanding requests. */
  stop(): void {
    this.closed = true;
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = null;
    this.stderrReader = null;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.child = null;
  }

  // ---- internals -----------------------------------------------------------

  private addUpdateListener(sessionId: string, listener: UpdateListener): void {
    let set = this.updateListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.updateListeners.set(sessionId, set);
    }
    set.add(listener);
  }

  private removeUpdateListener(sessionId: string, listener: UpdateListener): void {
    this.updateListeners.get(sessionId)?.delete(listener);
  }

  private sendRaw(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.exitInfo) {
      throw new Error("ACP connection is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params) message.params = params;
    this.sendRaw(message);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.sendRaw({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // non-protocol stdout noise is ignored
    }

    // Response to one of our requests.
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        const error = msg.error as { message?: string; code?: number };
        pending.reject(new Error(`ACP ${pending.method} error: ${error?.message ?? JSON.stringify(error)}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Request from the server (has id + method): answer or reject.
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      this.handleServerRequest(msg.id, msg.method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }

    // Notification from the server.
    if (typeof msg.method === "string") {
      if (msg.method === "session/update") {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const sessionId = params.sessionId;
        const update = (params.update ?? {}) as Record<string, unknown>;
        if (typeof sessionId === "string") {
          for (const listener of this.updateListeners.get(sessionId) ?? []) {
            try {
              listener(update);
            } catch {
              /* listener errors must not kill the connection */
            }
          }
        }
      }
      this.emit("notification", msg);
    }
  }

  private handleServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "session/request_permission") {
      const options = (params.options ?? []) as Array<{ optionId?: string; kind?: string }>;
      const allow =
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind === "allow_always") ??
        options[0];
      const optionId = allow?.optionId;
      this.sendRaw({
        jsonrpc: "2.0",
        id,
        result: optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    this.sendRaw({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not supported by dsh-acp-broker: ${method}` },
    });
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    this.emit("fatal", err);
  }
}
