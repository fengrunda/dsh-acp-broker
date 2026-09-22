import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { cliPath, countMethod, mockChild, readJournal, repoRoot, tempDir } from "./helpers.mjs";

const run = promisify(execFile);

test("CLI: start, open two tickets, list, explicit close, stop", async (t) => {
  const dir = await tempDir();
  const journal = path.join(dir, "journal.jsonl");
  const env = {
    ...process.env,
    DSH_BROKER_DIR: dir,
    DSH_ACP_BROKER_DSH_BIN: process.execPath,
    DSH_ACP_BROKER_DSH_ARGS: mockChild,
    MOCK_ACP_JOURNAL: journal,
  };
  const cli = (args) =>
    run(process.execPath, [cliPath, ...args], { env, cwd: repoRoot });

  t.after(async () => {
    await cli(["stop", "--dir", dir]).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  const started = await cli(["start", "--dir", dir]);
  assert.match(started.stdout, /broker started/);

  const wsA = path.join(dir, "ws-a");
  const wsB = path.join(dir, "ws-b");

  const first = await cli([
    "prompt", "--ticket", "alpha", "--cwd", wsA, "--dir", dir, "hello", "alpha",
  ]);
  assert.match(first.stdout, /echo:hello alpha/);

  await cli(["prompt", "--ticket", "beta", "--cwd", wsB, "--dir", dir, "hello", "beta"]);
  await cli(["prompt", "--ticket", "alpha", "--dir", dir, "--keep-open", "again"]);

  const status = JSON.parse((await cli(["status", "--dir", dir, "--json"])).stdout);
  assert.equal(status.liveTickets.length, 2);

  const list = JSON.parse((await cli(["list", "--dir", dir, "--json"])).stdout);
  assert.equal(list.tickets.length, 2);
  assert.equal(list.sessions.length, 2);

  const closed = await cli(["close", "--ticket", "alpha", "--dir", dir]);
  assert.match(closed.stdout, /closed ticket=alpha/);

  const afterClose = JSON.parse((await cli(["status", "--dir", dir, "--json"])).stdout);
  assert.deepEqual(afterClose.liveTickets, ["beta"]);

  const stopped = await cli(["stop", "--dir", dir]);
  assert.match(stopped.stdout, /broker stopped/);

  const log = readJournal(journal);
  assert.equal(countMethod(log, "session/new"), 2, "one session per ticket");
  assert.equal(countMethod(log, "session/close"), 1, "only the explicit close");
});

test("CLI: status exits non-zero when no broker is running", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => run(process.execPath, [cliPath, "status", "--dir", dir], { cwd: repoRoot }),
      (err) => err.code === 1 && /not running/.test(err.stderr),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI: main runs when invoked through a symlink (npm link regression)", async () => {
  const dir = await tempDir();
  const link = path.join(dir, "dsh-acp-broker");
  const stateDir = path.join(dir, "state");
  try {
    // npm link installs a symlink whose argv[1] is the link path while
    // import.meta.url resolves to the real dist/cli.js; the is-main guard must
    // still fire instead of silently exiting 0.
    await fs.symlink(cliPath, link);

    const help = await run(process.execPath, [link, "--help"], { cwd: repoRoot });
    assert.match(help.stdout, /Usage:/);
    assert.match(help.stdout, /dsh-acp-broker start/);

    await assert.rejects(
      () => run(process.execPath, [link, "status", "--dir", stateDir], { cwd: repoRoot }),
      (err) => err.code === 1 && /not running/.test(err.stderr),
      "symlinked status must run and report the missing broker",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
