import { promises as fs } from "node:fs";
import type * as net from "node:net";

import { Broker } from "./broker.js";
import { startControlServer, stopControlServer } from "./control.js";
import { brokerPaths, defaultDshHome, resolveDshArgs, resolveDshBin } from "./paths.js";
import type { ControlRequest, ControlResponse } from "./types.js";

export interface ServeOptions {
  dir?: string;
  dshBin?: string;
  dshArgs?: string[];
  log?: (message: string) => void;
}

/**
 * Daemon entry: one long-lived process holding the ACP child and the control
 * socket. Started detached by `dsh-acp-broker start`; not meant to be called
 * directly by users.
 */
export async function serveDaemon(options: ServeOptions = {}): Promise<void> {
  const paths = brokerPaths(options.dir);
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const dshBin = options.dshBin ?? resolveDshBin();
  const dshArgs = options.dshArgs ?? resolveDshArgs();

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.DSH_HOME ??= defaultDshHome();
  env.DSH_PERMISSION_MODE ??= "danger-full-access";

  // `DSH_ACP_PROMPT_TIMEOUT` is seconds, matching the one-shot helper's env.
  const promptTimeoutMs = Math.max(1, Number(env.DSH_ACP_PROMPT_TIMEOUT ?? 900)) * 1_000;

  const broker = new Broker({
    ticketsDir: paths.ticketsDir,
    socketPath: paths.socketPath,
    dshBin,
    dshArgs,
    env,
    promptTimeoutMs,
  });

  log(`[broker] starting dsh: ${dshBin} ${dshArgs.join(" ")} (DSH_HOME=${env.DSH_HOME})`);
  await broker.start();
  log(`[broker] ACP ready pid=${broker.connection.pid} tickets=${paths.ticketsDir}`);

  let shuttingDown = false;
  let server: net.Server | null = null;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("[broker] shutting down");
    if (server) {
      await stopControlServer(server, paths.socketPath).catch(() => undefined);
    }
    await broker.stop().catch(() => undefined);
    await fs.rm(paths.pidFile, { force: true }).catch(() => undefined);
    process.exit(code);
  };

  broker.connection.on("fatal", (err: Error) => {
    log(`[broker] ACP connection failed: ${err.message}`);
    setTimeout(() => void shutdown(1), 25);
  });

  server = await startControlServer(paths.socketPath, (req) => handle(req, broker, shutdown));
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  log(`[broker] listening on ${paths.socketPath} (pid ${process.pid})`);
}

async function handle(
  request: ControlRequest,
  broker: Broker,
  shutdown: (code?: number) => Promise<void>,
): Promise<ControlResponse> {
  switch (request.cmd) {
    case "status":
      return { ok: true, data: await broker.status() };
    case "prompt":
      return { ok: true, data: await broker.prompt(request) };
    case "resume":
      return { ok: true, data: await broker.resume(request) };
    case "list":
      return { ok: true, data: await broker.list(request.cwd) };
    case "close":
      return { ok: true, data: await broker.close(request.ticket) };
    case "stop":
      // Answer first, then tear down so the CLI sees a clean ack.
      setTimeout(() => void shutdown(0), 25);
      return { ok: true, data: { stopping: true } };
    default: {
      const unknown = request as { cmd?: string };
      return { ok: false, error: `unknown command: ${String(unknown.cmd)}` };
    }
  }
}
