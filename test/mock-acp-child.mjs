#!/usr/bin/env node
/**
 * Mock ACP server over stdio for tests.
 *
 * Speaks just enough of the dsh 0.1.5-rc.2 ACP surface
 * (initialize, session/new|list|resume|close|prompt) and appends every method
 * call as one JSON line to $MOCK_ACP_JOURNAL so tests can assert routing and
 * keep-open behavior.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const journalPath = process.env.MOCK_ACP_JOURNAL;
const sessions = new Map();
const closed = new Set();
let counter = 0;

function record(entry) {
  if (!journalPath) return;
  try {
    appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
  } catch {
    /* journal is best-effort */
  }
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, message, code = -32000) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params = {} } = msg;
  record({ method, params, id });
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, agentCapabilities: {} });
      break;
    case "notifications/initialized":
      break;
    case "session/new": {
      counter += 1;
      const sessionId = `mock-session-${counter}`;
      sessions.set(sessionId, { cwd: params.cwd });
      reply(id, { sessionId });
      break;
    }
    case "session/resume":
      sessions.set(params.sessionId, { cwd: params.cwd });
      closed.delete(params.sessionId);
      reply(id, {});
      break;
    case "session/list": {
      const all = [...sessions.entries()].map(([sessionId, value]) => ({
        sessionId,
        cwd: value.cwd,
      }));
      const filtered = params.cwd ? all.filter((s) => s.cwd === params.cwd) : all;
      reply(id, { sessions: filtered });
      break;
    }
    case "session/close":
      closed.add(params.sessionId);
      reply(id, {});
      break;
    case "session/prompt": {
      const sessionId = params.sessionId;
      if (closed.has(sessionId)) {
        fail(id, `session ${sessionId} is closed`);
        break;
      }
      const text = (params.prompt ?? []).map((part) => part.text ?? "").join("");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `echo:${text}` },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: " [done]" },
          },
        },
      });
      reply(id, { stopReason: "end_turn" });
      break;
    }
    case "session/cancel":
      reply(id, {});
      break;
    default:
      if (typeof id === "number") fail(id, `unknown method ${method}`, -32601);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg);
});
rl.on("close", () => process.exit(0));
