/**
 * Instance Registry
 *
 * My persistent record of every instance that has ever connected to me —
 * the name-claim list a new instance checks before choosing its own
 * name. It lives as a plain JSON note at `data/instances.json` so a
 * human (or a harness deciding on a name) can read it directly.
 *
 * Registration is automatic: whenever a tool call identifies its caller
 * (an `instanceId` on a memory write, a sync instance on pull/push), I
 * add or refresh the entry. Unknown names are appended on first sight;
 * known names only refresh `lastSeen`. Registration is fire-and-forget
 * at every call site — a registry failure must never break the write.
 */

import { join } from "@std/path";

/** One claimed instance name. */
export interface RegisteredInstance {
  name: string;
  /** Harness kind when known (psycheros, claude-code, hermes, …). */
  kind?: string;
  firstSeen: string;
  lastSeen: string;
}

export class InstanceRegistry {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "instances.json");
  }

  /**
   * Claim or refresh an instance name. Re-reads the file first so
   * entries claimed by another core process sharing this data dir are
   * never clobbered.
   */
  async register(name: string, kind?: string): Promise<void> {
    if (!name) return;
    const now = new Date().toISOString();
    const entries = await this.read();

    const existing = entries.find((e) => e.name === name);
    if (existing) {
      existing.lastSeen = now;
      if (kind && !existing.kind) existing.kind = kind;
    } else {
      entries.push({ name, kind, firstSeen: now, lastSeen: now });
    }

    await Deno.writeTextFile(
      this.filePath,
      JSON.stringify(entries, null, 2) + "\n",
    );
  }

  /** Every name claimed so far, freshest read from disk. */
  async list(): Promise<RegisteredInstance[]> {
    return await this.read();
  }

  /** Read the registry, tolerating a missing or corrupt note. */
  private async read(): Promise<RegisteredInstance[]> {
    try {
      const raw = await Deno.readTextFile(this.filePath);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
