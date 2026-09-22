/**
 * Shared types for dsh-acp-broker.
 *
 * The broker holds one long-lived `dsh --profile acp` child and keeps named
 * tickets co-resident as live ACP sessions in that single process.
 */

/** A named ticket persisted on disk: ticket -> sessionId + cwd + meta. */
export interface TicketMeta {
  /** Ticket name (sanitized for the filename, but this is the logical name). */
  name: string;
  /** ACP `sessionId` returned by `session/new` or listed by `session/list`. */
  sessionId: string;
  /** Absolute workspace directory the session was created/resumed with. */
  cwd: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last update time. */
  updatedAt: string;
  /** How many prompts have been routed to this ticket. */
  promptCount: number;
  /** ISO-8601 time of the last routed prompt, if any. */
  lastPromptAt?: string;
  /** MCP servers the session was created with (opaque passthrough). */
  mcpServers?: unknown[];
  /** Free-form caller metadata. */
  labels?: Record<string, string>;
}

/** Commands accepted on the Unix-domain control socket. */
export type ControlRequest =
  | { cmd: "status" }
  | {
      cmd: "prompt";
      ticket: string;
      text: string;
      cwd?: string;
      keepOpen?: boolean;
      labels?: Record<string, string>;
    }
  | { cmd: "resume"; ticket: string; cwd?: string }
  | { cmd: "list"; cwd?: string }
  | { cmd: "close"; ticket: string }
  | { cmd: "stop" };

/** One response per control request; `data` is command-specific. */
export interface ControlResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface StatusData {
  pid: number;
  uptimeMs: number;
  dshPid: number | null;
  dshCommand: string;
  dshArgs: string[];
  ticketsDir: string;
  socketPath: string;
  /** Tickets with a session currently loaded in the long-lived ACP child. */
  liveTickets: string[];
  /** Every ticket persisted on disk. */
  tickets: TicketMeta[];
}

export interface PromptData {
  ticket: string;
  sessionId: string;
  cwd: string;
  /** Whether the session stayed loaded after the prompt (always true today). */
  keepOpen: boolean;
  stopReason?: string;
  assistantText: string;
}
