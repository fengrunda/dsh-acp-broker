import * as os from "node:os";
import * as path from "node:path";

/**
 * Filesystem layout for one broker instance.
 *
 * Default root is `./.dsh-broker` relative to the directory the CLI runs in.
 * Override with `--dir <path>` or `DSH_BROKER_DIR`.
 *
 *   <dir>/tickets/<name>.json   persisted ticket -> sessionId + cwd + meta
 *   <dir>/broker.sock           Unix-domain control socket
 *   <dir>/broker.pid            daemon pid file
 *   <dir>/broker.log            detached daemon stdout/stderr
 */
export interface BrokerPaths {
  dir: string;
  ticketsDir: string;
  socketPath: string;
  pidFile: string;
  logFile: string;
}

export const DEFAULT_BROKER_DIRNAME = ".dsh-broker";

export function resolveBrokerDir(explicit?: string): string {
  const chosen =
    explicit ??
    process.env.DSH_BROKER_DIR ??
    path.join(process.cwd(), DEFAULT_BROKER_DIRNAME);
  return path.resolve(chosen);
}

export function brokerPaths(explicit?: string): BrokerPaths {
  const dir = resolveBrokerDir(explicit);
  return {
    dir,
    ticketsDir: path.join(dir, "tickets"),
    socketPath: path.join(dir, "broker.sock"),
    pidFile: path.join(dir, "broker.pid"),
    logFile: path.join(dir, "broker.log"),
  };
}

/** Directory used for the ACP child's DSH_HOME when none is provided. */
export function defaultDshHome(): string {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

/** The `dsh` binary the broker spawns. Tests point this at a mock child. */
export function resolveDshBin(): string {
  return (
    process.env.DSH_ACP_BROKER_DSH_BIN ??
    process.env.DSH_BIN ??
    "dsh"
  );
}

/**
 * Arguments for the long-lived ACP server. Overridable so tests can run a mock
 * child with the same stdio contract.
 */
export function resolveDshArgs(): string[] {
  const raw = process.env.DSH_ACP_BROKER_DSH_ARGS;
  if (raw && raw.trim()) return splitArgs(raw);
  return ["--profile", "acp"];
}

/** Minimal shell-like splitter for the DSH_ACP_BROKER_DSH_ARGS override. */
export function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
