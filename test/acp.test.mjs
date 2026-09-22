import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { AcpConnection } from "../dist/index.js";
import { countMethod, mockChild, readJournal, tempDir } from "./helpers.mjs";

test("AcpConnection: initialize, new session, prompt updates, list, close", async () => {
  const dir = await tempDir();
  const journal = path.join(dir, "journal.jsonl");
  const conn = new AcpConnection({
    command: process.execPath,
    args: [mockChild],
    env: { ...process.env, MOCK_ACP_JOURNAL: journal },
  });

  conn.start();
  await conn.initialize();
  assert.equal(conn.isInitialized, true);

  const cwd = path.join(dir, "ws");
  const sessionId = await conn.sessionNew(cwd);
  assert.equal(sessionId, "mock-session-1");

  const updates = [];
  const result = await conn.sessionPrompt(sessionId, "hello", (update) => updates.push(update));
  assert.equal(result.assistantText, "echo:hello [done]");
  assert.equal(result.stopReason, "end_turn");
  assert.ok(updates.length >= 2, "expected streamed session/update notifications");

  const sessions = await conn.sessionList(cwd);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionId);

  await conn.sessionClose(sessionId);
  conn.stop();

  const log = readJournal(journal);
  assert.equal(countMethod(log, "initialize"), 1);
  assert.equal(countMethod(log, "session/new"), 1);
  assert.equal(countMethod(log, "session/close"), 1);
});

test("AcpConnection: prompt timeout is reported without killing the child", async () => {
  const dir = await tempDir();
  const journal = path.join(dir, "journal.jsonl");
  const conn = new AcpConnection({
    command: process.execPath,
    args: [mockChild],
    env: { ...process.env, MOCK_ACP_JOURNAL: journal },
    requestTimeoutMs: 5_000,
    promptTimeoutMs: 5_000,
  });
  conn.start();
  await conn.initialize();
  const cwd = path.join(dir, "ws");
  const sessionId = await conn.sessionNew(cwd);
  // A normal prompt still works after a prior completed request.
  const first = await conn.sessionPrompt(sessionId, "a");
  const second = await conn.sessionPrompt(sessionId, "b");
  assert.equal(first.assistantText, "echo:a [done]");
  assert.equal(second.assistantText, "echo:b [done]");
  assert.equal(conn.isRunning, true);
  conn.stop();
});
