import * as net from "node:net";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ControlRequest, ControlResponse } from "./types.js";

/**
 * Control plane: a Unix-domain socket carrying one newline-delimited JSON
 * request/response per connection.
 *
 * Why a Unix socket rather than loopback HTTP:
 *   - no TCP port to pick, bind, or firewall; no accidental LAN exposure
 *   - filesystem mode (0600) is the access boundary
 *   - stdio-only ACP constraint means the broker already avoids web/Host APIs
 *   - a thin CLI is a ~40-line client with no HTTP framework dependency
 */

export type ControlHandler = (req: ControlRequest) => Promise<ControlResponse>;

export async function startControlServer(
  socketPath: string,
  handler: ControlHandler,
): Promise<net.Server> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.rm(socketPath, { force: true });

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let busy = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      void drain();
    });

    const drain = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let request: ControlRequest;
          try {
            request = JSON.parse(line) as ControlRequest;
          } catch {
            socket.write(`${JSON.stringify({ ok: false, error: "invalid JSON request" })}\n`);
            continue;
          }
          let response: ControlResponse;
          try {
            response = await handler(request);
          } catch (err) {
            response = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          socket.write(`${JSON.stringify(response)}\n`);
        }
      } finally {
        busy = false;
      }
    };
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600).catch(() => {
    /* best-effort hardening; not fatal on filesystems without chmod */
  });
  return server;
}

export async function stopControlServer(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(socketPath, { force: true });
}

/** Send one control request; resolves with the broker's response. */
export function controlRequest(
  socketPath: string,
  request: ControlRequest,
  timeoutMs = 30_000,
): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`control request to ${socketPath} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      finish(() => {
        try {
          resolve(JSON.parse(line) as ControlResponse);
        } catch (err) {
          reject(new Error(`invalid response from broker: ${(err as Error).message}`));
        }
      });
    });
    socket.on("error", (err) => {
      finish(() => reject(new Error(`cannot reach broker at ${socketPath}: ${err.message}`)));
    });
  });
}
