#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { controlRequest } from "./control.js";
import { startDaemon, stopDaemon, tryStatus } from "./daemon.js";
import { brokerPaths } from "./paths.js";
import { serveDaemon } from "./serve.js";
import type { ControlRequest, ControlResponse, PromptData, StatusData, TicketMeta } from "./types.js";

const VERSION = "0.1.0";

const USAGE = `dsh-acp-broker ${VERSION} — long-lived ACP multi-session broker

Usage:
  dsh-acp-broker start   [--dir DIR]
  dsh-acp-broker status  [--dir DIR] [--json]
  dsh-acp-broker stop    [--dir DIR]
  dsh-acp-broker prompt  --ticket NAME [--cwd ABS] [--keep-open] [--dir DIR] TEXT...
  dsh-acp-broker resume  --ticket NAME [--cwd ABS] [--dir DIR]
  dsh-acp-broker list    [--cwd ABS] [--dir DIR] [--json]
  dsh-acp-broker close   --ticket NAME [--dir DIR]

Notes:
  - \`prompt\` never closes a session (--keep-open is the default and only
    behavior); use \`close --ticket NAME\` for an explicit session/close.
  - Tickets persist under <DIR>/tickets (default ./.dsh-broker/tickets).
  - The broker talks ACP stdio to \`dsh --profile acp\`; it needs no dsh web.

Env:
  DSH_BROKER_DIR           override the broker state directory
  DSH_ACP_BROKER_DSH_BIN   dsh binary to spawn (default: dsh, or $DSH_BIN)
  DSH_ACP_BROKER_DSH_ARGS  ACP child args (default: --profile acp)
  DSH_HOME                 forwarded to the ACP child
`;

interface ParsedArgs {
  values: Record<string, string>;
  bools: Set<string>;
  positionals: string[];
}

const BOOL_FLAGS = new Set(["keep-open", "json", "help", "version"]);

function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        const key = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        if (BOOL_FLAGS.has(key)) bools.add(key);
        else values[key] = value;
        continue;
      }
      const key = arg.slice(2);
      if (BOOL_FLAGS.has(key)) {
        bools.add(key);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${key} needs a value`);
      }
      values[key] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      throw new UsageError(`unknown flag: ${arg}`);
    }
    positionals.push(arg);
  }
  return { values, bools, positionals };
}

class UsageError extends Error {}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function requireTicket(values: Record<string, string>): string {
  const ticket = values.ticket?.trim();
  if (!ticket) throw new UsageError("--ticket NAME is required");
  return ticket;
}

async function call(socketPath: string, request: ControlRequest, timeoutMs?: number): Promise<ControlResponse> {
  const response = await controlRequest(socketPath, request, timeoutMs);
  if (!response.ok) throw new Error(response.error ?? "broker returned an error");
  return response;
}

function formatStatus(status: StatusData): string {
  const lines = [
    "broker running",
    `  pid:      ${status.pid}`,
    `  uptime:   ${Math.round(status.uptimeMs / 1000)}s`,
    `  dsh pid:  ${status.dshPid ?? "-"}`,
    `  command:  ${status.dshCommand} ${status.dshArgs.join(" ")}`,
    `  tickets:  ${status.ticketsDir}`,
    `  socket:   ${status.socketPath}`,
    `  live:     ${status.liveTickets.length ? status.liveTickets.join(", ") : "(none)"}`,
  ];
  if (status.tickets.length) {
    lines.push("  ticket map:");
    for (const ticket of status.tickets) {
      lines.push(
        `    - ${ticket.name}  session=${ticket.sessionId}  cwd=${ticket.cwd}  prompts=${ticket.promptCount}`,
      );
    }
  } else {
    lines.push("  ticket map: (empty)");
  }
  return lines.join("\n");
}

function formatTicket(ticket: TicketMeta): string {
  return `${ticket.name}\tsession=${ticket.sessionId}\tcwd=${ticket.cwd}\tprompts=${ticket.promptCount}\tupdated=${ticket.updatedAt}`;
}

async function main(argv: string[]): Promise<number> {
  const { values, bools, positionals } = parseArgs(argv);
  const command = positionals.shift() ?? (bools.has("help") ? "help" : "");

  if (bools.has("version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command || command === "help" || bools.has("help")) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }

  const paths = brokerPaths(values.dir);

  switch (command) {
    case "__serve": {
      await serveDaemon({ dir: values.dir });
      return 0;
    }

    case "start": {
      const result = await startDaemon({ dir: values.dir });
      if (result.started) {
        process.stdout.write(
          `broker started pid=${result.pid} socket=${paths.socketPath} tickets=${paths.ticketsDir}\n`,
        );
      } else {
        process.stdout.write(`broker already running pid=${result.pid}\n`);
      }
      return 0;
    }

    case "status": {
      const status = await tryStatus(paths);
      if (!status) {
        process.stderr.write(`broker not running (dir ${paths.dir})\n`);
        return 1;
      }
      process.stdout.write(
        bools.has("json") ? `${JSON.stringify(status, null, 2)}\n` : `${formatStatus(status)}\n`,
      );
      return 0;
    }

    case "stop": {
      const { stopped } = await stopDaemon({ dir: values.dir });
      process.stdout.write(stopped ? "broker stopped\n" : "broker not running\n");
      return stopped ? 0 : 1;
    }

    case "prompt": {
      const ticket = requireTicket(values);
      let text = values.text ?? positionals.join(" ").trim();
      if (!text) text = (await readStdin()).trim();
      if (!text) throw new UsageError("prompt text is required (positional, --text, or stdin)");
      const response = await call(
        paths.socketPath,
        {
          cmd: "prompt",
          ticket,
          text,
          cwd: values.cwd,
          keepOpen: true,
        },
        // Prompts can run for minutes; the broker's own ACP prompt timeout is
        // DSH_ACP_PROMPT_TIMEOUT (default 900s), so leave generous margin.
        Math.max(1, Number(process.env.DSH_ACP_BROKER_CLIENT_TIMEOUT ?? 1_800)) * 1_000,
      );
      const data = response.data as PromptData;
      if (bools.has("json")) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      } else {
        process.stderr.write(
          `ticket=${data.ticket} session=${data.sessionId} keepOpen=${data.keepOpen} stopReason=${data.stopReason ?? "-"}\n`,
        );
        process.stdout.write(data.assistantText ? `${data.assistantText}\n` : "");
      }
      return 0;
    }

    case "resume": {
      const ticket = requireTicket(values);
      const response = await call(paths.socketPath, { cmd: "resume", ticket, cwd: values.cwd });
      const data = response.data as { ticket: string; sessionId: string; cwd: string };
      process.stdout.write(
        bools.has("json")
          ? `${JSON.stringify(data, null, 2)}\n`
          : `resumed ticket=${data.ticket} session=${data.sessionId} cwd=${data.cwd}\n`,
      );
      return 0;
    }

    case "list": {
      const response = await call(paths.socketPath, { cmd: "list", cwd: values.cwd });
      const data = response.data as { sessions: Array<{ sessionId: string; cwd?: string }>; tickets: TicketMeta[] };
      if (bools.has("json")) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      } else {
        process.stdout.write(`tickets (${data.tickets.length}):\n`);
        for (const ticket of data.tickets) process.stdout.write(`  ${formatTicket(ticket)}\n`);
        process.stdout.write(`acp sessions (${data.sessions.length}):\n`);
        for (const session of data.sessions) {
          process.stdout.write(`  ${session.sessionId}\t${session.cwd ?? "-"}\n`);
        }
      }
      return 0;
    }

    case "close": {
      const ticket = requireTicket(values);
      const response = await call(paths.socketPath, { cmd: "close", ticket });
      const data = response.data as { ticket: string; sessionId: string | null; closed: boolean };
      process.stdout.write(
        bools.has("json")
          ? `${JSON.stringify(data, null, 2)}\n`
          : `closed ticket=${data.ticket} session=${data.sessionId ?? "-"}\n`,
      );
      return 0;
    }

    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

/**
 * Robust ESM "is main module" check.
 *
 * `process.argv[1]` keeps whatever path the user typed, so when the CLI is
 * reached through an `npm link` symlink (e.g. ~/.local/bin/dsh-acp-broker ->
 * dist/cli.js) a lexical `path.resolve(argv[1])` comparison against
 * `import.meta.url` fails even though the same file is running. Resolving both
 * sides with `fs.realpathSync` makes symlinked and direct invocations match.
 */
function isInvokedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(modulePath);
  } catch {
    // realpath can fail on exotic paths; fall back to a lexical comparison.
    return path.resolve(argv1) === path.resolve(modulePath);
  }
}

const invokedDirectly = isInvokedDirectly();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      if (err instanceof UsageError) process.stderr.write(`\n${USAGE}`);
      process.exitCode = err instanceof UsageError ? 2 : 1;
    });
}

export { main };
