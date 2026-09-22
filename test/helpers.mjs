import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const mockChild = path.join(repoRoot, "test", "mock-acp-child.mjs");
export const cliPath = path.join(repoRoot, "dist", "cli.js");

export async function tempDir(prefix = "dsh-acp-broker-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function readJournal(journalPath) {
  try {
    return readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function countMethod(journal, method) {
  return journal.filter((entry) => entry.method === method).length;
}
