/**
 * Volatile-state snapshot — restart containment
 * (vision.md → "Restart containment").
 *
 * ONE JSON row in the shared DB carrying every piece of volatile state
 * that a daemon restart used to silently reset. Saved on every mutation
 * (best-effort, non-blocking), restored ONCE at boot BEFORE anything
 * starts — await-ordered, because fire-and-forget restores lose races
 * with the first tick.
 *
 * The shape is the typed `VolatileState` interface: when a new piece of
 * volatile state appears, it gets a field HERE so the compiler nags
 * about restore support. The earlier ad-hoc tables (flux_readiness_state,
 * flux_driver_state) fold into this row and drop.
 */

import type { Database } from "@db/sqlite";

// =============================================================================
// The typed shape
// =============================================================================

/** The complete volatile state of the flux subsystem. */
export interface VolatileState {
  /** When this snapshot was written (ms epoch). */
  savedAt: number;
  /** The Mood Organ: current axes, baseline, and the embedding accumulator.
   * `connection` fields are legacy — old
   * snapshots may carry them; they restore as inert cruft. */
  mood: {
    state: {
      valence: number;
      arousal: number;
      dominance: number;
      /** Legacy keys (pre-rename snapshots may carry `pleasure`,
       * `connection`); they restore as inert cruft. */
      pleasure?: number;
      connection?: number;
      asOf: number;
    };
    baseline: {
      valence: number;
      arousal: number;
      dominance: number;
      pleasure?: number;
      connection?: number;
      asOf: number;
    };
    lastUpdate: number;
    moodEmbedding: number[] | null;
  };
  /** Compaction: current texture per chain (stamps feed expiry —
   * missing stamps restore as expired). */
  compaction: Record<
    string,
    {
      short: string | null;
      long: string | null;
      shortWrittenAt?: number;
      longWrittenAt?: number;
    }
  >;
  /** The Thalamus: per-organ hold-state (dedup baselines + held counts). */
  thalamus: Record<
    string,
    { description: string; heldCount: number; lastPassAt: number }
  >;
  /** Sensory Organ health heartbeat timestamps (probe states self-heal). */
  organHealth: Record<string, number>;
  /** Familiarity: the recent-expression pool (habituation + satiation). */
  familiarity: {
    entries: {
      embedding: number[];
      at: number;
      kind: "wake-trigger" | "ego-speech";
      text: string;
    }[];
  };
  /** The manager's focus caches. */
  focus: {
    override: { text: string; expiresAt: number } | null;
    embedding: number[] | null;
    cachedAt: number;
  };
  /** Readiness: satisfied/ran timestamps (migrated from its own table). */
  readiness: {
    musingSatisfiedAt: number;
    musingRanAt: number;
    musingSatisfactionFactor: number;
    reverieSatisfiedAt: number;
    reverieRanAt: number;
  };
  /** Driver cadence timestamps (migrated from its own table). */
  driver: {
    lastCompaction: number;
    lastLongformCompaction: number;
    lastPromotion: number;
  };
  /** The posture (THE SPLIT): a chosen sleep survives a
   * daemon restart — the entity's decision, not the process's. */
  posture?: {
    posture: "awake" | "sleep";
    sleepCycles: number;
    passesInCycle: number;
  };
}

// =============================================================================
// Store
// =============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flux_volatile_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL
);
`;

/**
 * Persistence for the volatile snapshot: load at boot (await it), save on
 * every mutation (fire-and-forget write, cheap — single row).
 */
export class VolatileStateStore {
  constructor(private db: Database) {
    db.exec(SCHEMA);
  }

  /** Restore the snapshot. Returns null when none exists (first boot). */
  load(): VolatileState | null {
    try {
      const row = this.db.prepare(
        "SELECT state_json FROM flux_volatile_state WHERE id = 1",
      ).get<{ state_json: string }>();
      return row ? JSON.parse(row.state_json) as VolatileState : null;
    } catch {
      return null;
    }
  }

  /** Persist the snapshot (synchronous single-row write — sub-ms). */
  save(state: VolatileState): void {
    try {
      this.db.prepare(
        "INSERT OR REPLACE INTO flux_volatile_state (id, state_json) VALUES (1, ?)",
      ).run(JSON.stringify(state));
    } catch (error) {
      // Best-effort: a failed snapshot save must never take the system down.
      console.error(
        "[Flux] Volatile-state save failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Drop the two legacy ad-hoc tables (their data lives in the blob now). */
  dropLegacyTables(): void {
    try {
      this.db.exec("DROP TABLE IF EXISTS flux_readiness_state");
      this.db.exec("DROP TABLE IF EXISTS flux_driver_state");
    } catch {
      // Non-fatal.
    }
  }
}
