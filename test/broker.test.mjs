import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { Broker, TicketStore } from "../dist/index.js";
import { countMethod, mockChild, readJournal, tempDir } from "./helpers.mjs";

function makeBroker(dir, journal) {
  return new Broker({
    ticketsDir: path.join(dir, "tickets"),
    socketPath: path.join(dir, "broker.sock"),
    dshBin: process.execPath,
    dshArgs: [mockChild],
    env: { ...process.env, MOCK_ACP_JOURNAL: journal },
  });
}

test("TicketStore: sanitizes names and round-trips metadata", async () => {
  const dir = await tempDir();
  const store = new TicketStore(path.join(dir, "tickets"));
  await store.init();

  assert.equal(TicketStore.safeName("team/room alpha"), "team_room_alpha");
  assert.equal(TicketStore.safeName(".."), "_");

  const meta = {
    name: "team/room alpha",
    sessionId: "s-1",
    cwd: "/tmp/ws",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    promptCount: 0,
  };
  await store.put(meta);
  const loaded = await store.get(meta.name);
  assert.deepEqual(loaded, meta);
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.delete(meta.name), true);
  assert.equal(await store.get(meta.name), null);
});

test("prompt creates a ticket and keeps the ACP session open", async () => {
  const dir = await tempDir();
  const journal = path.join(dir, "journal.jsonl");
  const broker = makeBroker(dir, journal);
  await broker.start();

  const cwd = path.join(dir, "ws");
  const first = await broker.prompt({ ticket: "alpha", cwd, text: "one" });
  assert.equal(first.sessionId, "mock-session-1");
  assert.equal(first.keepOpen, true);
  assert.equal(first.assistantText, "echo:one [done]");

  const meta = await broker.tickets.get("alpha");
  assert.equal(meta.sessionId, "mock-session-1");
  assert.equal(meta.cwd, cwd);
  assert.equal(meta.promptCount, 1);

  // A second prompt must reuse the same live session: no resume, no close.
  const second = await broker.prompt({ ticket: "alpha", cwd, text: "two" });
  assert.equal(second.sessionId, "mock-session-1");
  assert.equal((await broker.tickets.get("alpha")).promptCount, 2);

  const log = readJournal(journal);
  assert.equal(countMethod(log, "session/new"), 1);
  assert.equal(countMethod(log, "session/resume"), 0);
  assert.equal(countMethod(log, "session/close"), 0, "default prompt path must not close");

  await broker.stop();
});

test("two tickets stay co-resident in one ACP connection", async () => {
  const dir = await tempDir();
  const journal = path.join(dir, "journal.jsonl");
  const broker = makeBroker(dir, journal);
  await broker.start();

  const cwdA = path.join(dir, "ws-a");
  const cwdB = path.join(dir, "ws-b");
  const a = await broker.prompt({ ticket: "alpha", cwd: cwdA, text: "to-a" });
  const b = await broker.prompt({ ticket: "beta", cwd: cwdB, text: "to-b" });

  assert.notEqual(a.sessionId, b.sessionId);
  const status = await broker.status();
  assert.deepEqual(status.liveTickets, ["alpha", "beta"]);

  const log = readJournal(journal);
  assert.equal(countMethod(log, "session/new"), 2);
  const prompts = log.filter((entry) => entry.method === "session/prompt");
  assert.equal(prompts.length, 2);
  assert.deepEqual(
    prompts.map((entry) => entry.params.sessionId),
    [a.sessionId, b.sessionId],
  );

  await broker.stop();
});

test("close is explicit: sends session/close and clears the ticket", async () => {
  const dir = await tempDir();
  const journal = path.join(dir, "journal.jsonl");
  const broker = makeBroker(dir, journal);
  await broker.start();

  const cwd = path.join(dir, "ws");
  await broker.prompt({ ticket: "alpha", cwd, text: "one" });
  const closed = await broker.close("alpha");

  assert.equal(closed.closed, true);
  assert.equal(closed.sessionId, "mock-session-1");
  assert.equal(await broker.tickets.get("alpha"), null);
  assert.deepEqual((await broker.status()).liveTickets, []);

  const log = readJournal(journal);
  assert.equal(countMethod(log, "session/close"), 1);

  await broker.stop();
});

test("resume reuses a persisted sessionId across broker restarts", async () => {
  const dir = await tempDir();
  const cwd = path.join(dir, "ws");

  const first = makeBroker(dir, path.join(dir, "j1.jsonl"));
  await first.start();
  const created = await first.prompt({ ticket: "alpha", cwd, text: "one" });
  await first.stop();

  const journal2 = path.join(dir, "j2.jsonl");
  const second = makeBroker(dir, journal2);
  await second.start();
  const resumed = await second.resume({ ticket: "alpha" });
  assert.equal(resumed.sessionId, created.sessionId);

  const after = await second.prompt({ ticket: "alpha", text: "two" });
  assert.equal(after.sessionId, created.sessionId);

  const log = readJournal(journal2);
  assert.equal(countMethod(log, "session/resume"), 1);
  assert.equal(countMethod(log, "session/new"), 0);

  await second.stop();
});

test("refuses to rebind an existing ticket to a different cwd", async () => {
  const dir = await tempDir();
  const broker = makeBroker(dir, path.join(dir, "journal.jsonl"));
  await broker.start();

  const cwd = path.join(dir, "ws");
  await broker.prompt({ ticket: "alpha", cwd, text: "one" });
  await assert.rejects(
    () => broker.prompt({ ticket: "alpha", cwd: path.join(dir, "other"), text: "two" }),
    /bound to cwd/,
  );

  await broker.stop();
  await fs.rm(dir, { recursive: true, force: true });
});
