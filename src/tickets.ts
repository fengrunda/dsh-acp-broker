import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { TicketMeta } from "./types.js";

/**
 * Persisted ticket map: ticket name -> sessionId + cwd + meta.
 *
 * One JSON file per ticket under `<ticketsDir>/<safe-name>.json`. The filename
 * is sanitized but `meta.name` keeps the original logical name.
 */
export class TicketStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  get ticketsDir(): string {
    return this.dir;
  }

  /** Sanitize a ticket name into a safe single-segment filename. */
  static safeName(name: string): string {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
    return safe || "_";
  }

  filePath(name: string): string {
    return path.join(this.dir, `${TicketStore.safeName(name)}.json`);
  }

  async get(name: string): Promise<TicketMeta | null> {
    try {
      const raw = await fs.readFile(this.filePath(name), "utf8");
      return JSON.parse(raw) as TicketMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(meta: TicketMeta): Promise<void> {
    await this.init();
    const target = this.filePath(meta.name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, target);
  }

  async delete(name: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(name));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async list(): Promise<TicketMeta[]> {
    await this.init();
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    const out: TicketMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, entry), "utf8");
        out.push(JSON.parse(raw) as TicketMeta);
      } catch {
        /* skip corrupt ticket files rather than failing the whole listing */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
