import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { controlRequest } from "./control.js";
import { brokerPaths, type BrokerPaths } from "./paths.js";
import type { StatusData } from "./types.js";

export interface StartResult {
  started: boolean;
  pid: number | null;
  status: StatusData | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask a running broker for status; null when nothing is listening. */
export async function tryStatus(
  paths: BrokerPaths,
  timeoutMs = 2_000,
): Promise<StatusData | null> {
  try {
    const response = await controlRequest(paths.socketPath, { cmd: "status" }, timeoutMs);
    if (!response.ok) return null;
    return response.data as StatusData;
  } catch {
    return null;
  }
}

/** Start the detached daemon if it is not already running. */
export async function startDaemon(options: { dir?: string; timeoutMs?: number } = {}): Promise<StartResult> {
  const paths = brokerPaths(options.dir);
  const already = await tryStatus(paths);
  if (already) return { started: false, pid: already.pid, status: already };

  await fs.mkdir(paths.dir, { recursive: true });
  const logHandle = await fs.open(paths.logFile, "a");
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

  const child = spawn(process.execPath, [cliPath, "__serve", "--dir", paths.dir], {
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();
  await logHandle.close();

  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await tryStatus(paths, 1_000);
    if (status) return { started: true, pid: status.pid, status };
    if (child.exitCode !== null) {
      throw new Error(
        `broker daemon exited early (code ${child.exitCode}); see ${paths.logFile}`,
      );
    }
    await sleep(150);
  }
  throw new Error(`broker daemon did not become ready within ${timeoutMs}ms; see ${paths.logFile}`);
}

/** Ask a running broker to stop and wait for it to disappear. */
export async function stopDaemon(options: { dir?: string; timeoutMs?: number } = {}): Promise<{ stopped: boolean }> {
  const paths = brokerPaths(options.dir);
  const status = await tryStatus(paths);
  if (!status) return { stopped: false };

  await controlRequest(paths.socketPath, { cmd: "stop" }, 5_000).catch(() => undefined);

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (!(await tryStatus(paths, 500))) return { stopped: true };
    await sleep(100);
  }
  return { stopped: false };
}
