import { promises as fs } from "node:fs";
import * as path from "node:path";

import { AcpConnection, type AcpSessionSummary } from "./acp.js";
import { TicketStore } from "./tickets.js";
import type { PromptData, StatusData, TicketMeta } from "./types.js";

export interface BrokerOptions {
  ticketsDir: string;
  socketPath: string;
  dshBin: string;
  dshArgs: string[];
  env?: NodeJS.ProcessEnv;
  spawnCwd?: string;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
}

interface LiveSession {
  sessionId: string;
  cwd: string;
}

/**
 * Core broker: one long-lived ACP connection plus a named ticket map.
 *
 * Sessions are created or resumed on demand and then stay loaded. Prompts never
 * close a session; only an explicit `close(ticket)` sends `session/close`.
 */
export class Broker {
  readonly connection: AcpConnection;
  readonly tickets: TicketStore;
  private readonly live = new Map<string, LiveSession>();
  private readonly startedAt = Date.now();

  constructor(private readonly options: BrokerOptions) {
    this.tickets = new TicketStore(options.ticketsDir);
    this.connection = new AcpConnection({
      command: options.dshBin,
      args: options.dshArgs,
      cwd: options.spawnCwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
      promptTimeoutMs: options.promptTimeoutMs,
    });
  }

  async start(): Promise<void> {
    await this.tickets.init();
    this.connection.start();
    await this.connection.initialize();
  }

  async status(): Promise<StatusData> {
    return {
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt,
      dshPid: this.connection.pid,
      dshCommand: this.options.dshBin,
      dshArgs: this.options.dshArgs,
      ticketsDir: this.options.ticketsDir,
      socketPath: this.options.socketPath,
      liveTickets: [...this.live.keys()].sort(),
      tickets: await this.tickets.list(),
    };
  }

  /** Route one prompt to a ticket, creating or resuming its session as needed. */
  async prompt(input: {
    ticket: string;
    text: string;
    cwd?: string;
    keepOpen?: boolean;
    labels?: Record<string, string>;
  }): Promise<PromptData> {
    const name = requireName(input.ticket);
    const meta = await this.tickets.get(name);
    const cwd = this.resolveCwd(name, input.cwd, meta);
    const sessionId = await this.ensureSession(name, cwd, meta);

    const result = await this.connection.sessionPrompt(sessionId, input.text);

    const now = new Date().toISOString();
    const next: TicketMeta = {
      name,
      sessionId,
      cwd,
      createdAt: meta?.createdAt ?? now,
      updatedAt: now,
      promptCount: (meta?.promptCount ?? 0) + 1,
      lastPromptAt: now,
      ...(meta?.mcpServers ? { mcpServers: meta.mcpServers } : {}),
      ...(input.labels ?? meta?.labels ? { labels: { ...meta?.labels, ...input.labels } } : {}),
    };
    await this.tickets.put(next);
    this.live.set(name, { sessionId, cwd });

    return {
      ticket: name,
      sessionId,
      cwd,
      // The default prompt path never closes; `keepOpen` is accepted for
      // explicitness and is always true today.
      keepOpen: input.keepOpen ?? true,
      stopReason: result.stopReason,
      assistantText: result.assistantText,
    };
  }

  /** Load (create or resume) a ticket's session without prompting it. */
  async resume(input: { ticket: string; cwd?: string }): Promise<{ ticket: string; sessionId: string; cwd: string }> {
    const name = requireName(input.ticket);
    const meta = await this.tickets.get(name);
    const cwd = this.resolveCwd(name, input.cwd, meta);
    const sessionId = await this.ensureSession(name, cwd, meta);
    if (!meta || meta.cwd !== cwd) {
      const now = new Date().toISOString();
      await this.tickets.put({
        name,
        sessionId,
        cwd,
        createdAt: meta?.createdAt ?? now,
        updatedAt: now,
        promptCount: meta?.promptCount ?? 0,
        ...(meta?.mcpServers ? { mcpServers: meta.mcpServers } : {}),
        ...(meta?.labels ? { labels: meta.labels } : {}),
      });
    }
    return { ticket: name, sessionId, cwd };
  }

  /** `session/list` from ACP plus the persisted ticket map. */
  async list(cwd?: string): Promise<{ sessions: AcpSessionSummary[]; tickets: TicketMeta[] }> {
    const sessions = await this.connection.sessionList(cwd);
    return { sessions, tickets: await this.tickets.list() };
  }

  /** Explicitly close a ticket's session and forget its ticket file. */
  async close(ticket: string): Promise<{ ticket: string; sessionId: string | null; closed: boolean }> {
    const name = requireName(ticket);
    const meta = await this.tickets.get(name);
    const live = this.live.get(name);
    const sessionId = live?.sessionId ?? meta?.sessionId ?? null;
    let closed = false;
    if (sessionId) {
      await this.connection.sessionClose(sessionId);
      closed = true;
    }
    this.live.delete(name);
    await this.tickets.delete(name);
    return { ticket: name, sessionId, closed };
  }

  async stop(): Promise<void> {
    this.connection.stop();
    this.live.clear();
  }

  // ---- internals -----------------------------------------------------------

  private resolveCwd(name: string, requested: string | undefined, meta: TicketMeta | null): string {
    const live = this.live.get(name);
    const candidate = requested ?? live?.cwd ?? meta?.cwd;
    if (!candidate) {
      throw new Error(
        `ticket "${name}" has no cwd yet: pass --cwd <abs> the first time you use it`,
      );
    }
    if (!path.isAbsolute(candidate)) {
      throw new Error(`cwd must be an absolute path: ${candidate}`);
    }
    const abs = path.resolve(candidate);
    const bound = live?.cwd ?? meta?.cwd;
    if (bound && path.resolve(bound) !== abs) {
      throw new Error(
        `ticket "${name}" is bound to cwd ${bound}; refusing ${abs}. Close the ticket or use another name.`,
      );
    }
    return abs;
  }

  private async ensureSession(
    name: string,
    cwd: string,
    meta: TicketMeta | null,
  ): Promise<string> {
    const live = this.live.get(name);
    if (live) return live.sessionId;

    // `dsh --profile acp` validates the absolute workspace exists; create it
    // like the one-shot helper does so first use of a ticket is frictionless.
    await fs.mkdir(cwd, { recursive: true });

    let sessionId: string;
    if (meta?.sessionId) {
      await this.connection.sessionResume(meta.sessionId, cwd, meta.mcpServers ?? []);
      sessionId = meta.sessionId;
    } else {
      sessionId = await this.connection.sessionNew(cwd);
    }
    this.live.set(name, { sessionId, cwd });
    return sessionId;
  }
}

function requireName(ticket: string): string {
  const name = (ticket ?? "").trim();
  if (!name) throw new Error("ticket name is required");
  return name;
}
