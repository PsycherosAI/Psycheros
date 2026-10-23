/**
 * Compaction — the Subconscious's shared working-memory maintenance.
 *
 * A component IN the Subconscious (the readiness pattern): not any one
 * module's, serving ALL processes. Texture summaries are the rolling
 * context each process carries — noticing's "what the last while felt
 * like," reverie's "what the interior's been circling" — and the
 * mechanism that maintains them is one thing, not four near-identical
 * manager methods.
 *
 * A chain is identified by name ("noticing" | "reverie" | future
 * processes). Each chain holds a short-horizon texture (the 15-min
 * close-up) and a longform texture (the hour-scale arc), anchored by
 * the current mood so the summaries stay honest to the classical
 * state. Compaction prompts are per-process (the compact() `system`
 * selector) but the windowing, mood anchoring, storage, and logging
 * live here.
 */

import type { Tier1Store } from "./tier1-store.ts";
import type { SmallLLMRunner } from "./small-llm-runner.ts";

/** The compaction chains — one per Subconscious process. */
export type CompactionChain = "noticing" | "reverie";

/** Which tier-1 population a chain compacts. */
const CHAIN_SOURCE: Record<
  CompactionChain,
  { excludeSource?: string; onlySource?: string }
> = {
  noticing: { excludeSource: "reverie" },
  reverie: { onlySource: "reverie" },
};

export interface CompactionDeps {
  tier1: Tier1Store;
  smallLLM: SmallLLMRunner;
  getMoodRender: () => string;
  /** Called when a chain's texture updates (ambient briefing hook). */
  onTexture?: (
    chain: CompactionChain,
    kind: "short" | "long",
    summary: string,
  ) => void;
}

export interface CompactionTimings {
  /** Short-horizon window (the 15-min texture). */
  cadenceMs: number;
  /** Longform window (the hour texture). */
  longformCadenceMs: number;
}

/** One chain's current textures (null before the first compaction). */
export interface ChainTextures {
  short: string | null;
  long: string | null;
  /** When each texture was written (ms epoch) — the expiry input,
   * internal only; no clock ever reaches the entity. Missing (legacy
   * snapshots) reads as expired. */
  shortWrittenAt?: number;
  longWrittenAt?: number;
}

/** True when a texture is absent or past the window it describes. A
 * missing stamp (a snapshot from before expiry existed) counts as
 * expired — legacy stale notes vanish rather than lying about their
 * window. */
function expired(
  text: string | null,
  writtenAt: number | undefined,
  windowMs: number,
  now: number,
): boolean {
  if (text === null) return true;
  return writtenAt === undefined || now - writtenAt > windowMs;
}

export class Compaction {
  private textures = new Map<CompactionChain, ChainTextures>();

  constructor(
    private deps: CompactionDeps,
    private timings: CompactionTimings,
  ) {
    for (const chain of Object.keys(CHAIN_SOURCE) as CompactionChain[]) {
      this.textures.set(chain, { short: null, long: null });
    }
  }

  /** Seed a chain's textures (manager hands over existing summaries). */
  seed(chain: CompactionChain, textures: Partial<ChainTextures>): void {
    const t = this.live(chain);
    if (textures.short !== undefined) {
      t.short = textures.short;
      t.shortWrittenAt = textures.shortWrittenAt;
    }
    if (textures.long !== undefined) {
      t.long = textures.long;
      t.longWrittenAt = textures.longWrittenAt;
    }
  }

  /** The chain's live record — internal writes only. Consumers read
   * through get() so expiry applies everywhere at once. */
  private live(chain: CompactionChain): ChainTextures {
    let t = this.textures.get(chain);
    if (!t) {
      t = { short: null, long: null };
      this.textures.set(chain, t);
    }
    return t;
  }

  /** A chain's current textures, expiry applied: a texture dies when
   * the window it describes has fully passed — its own cadence IS the
   * appropriate expiry, no slack. A window with
   * too little material to rewrite reads as honest silence, not a
   * carried-over summary. Every consumer — the prompt headers,
   * mindfulness, reverie's seed query — reads through here. */
  get(chain: CompactionChain, now: number = Date.now()): ChainTextures {
    const t = this.textures.get(chain) ?? { short: null, long: null };
    return {
      short: expired(t.short, t.shortWrittenAt, this.timings.cadenceMs, now)
        ? null
        : t.short,
      long: expired(
          t.long,
          t.longWrittenAt,
          this.timings.longformCadenceMs,
          now,
        )
        ? null
        : t.long,
    };
  }

  /** All current textures for the volatile snapshot. */
  exportSnapshot(): Record<string, ChainTextures> {
    return Object.fromEntries(this.textures.entries());
  }

  /** Restore textures from a snapshot. */
  restoreSnapshot(snap: Record<string, ChainTextures>): void {
    for (const [chain, textures] of Object.entries(snap)) {
      this.textures.set(
        chain as CompactionChain,
        { ...textures },
      );
    }
  }

  /**
   * Run one short-horizon pass for a chain: compress the last window's
   * observations into an updated texture (continuity — carry forward
   * what still matters, fold in what's new). Returns true when the
   * texture updated.
   */
  async runShortPass(chain: CompactionChain): Promise<boolean> {
    const windowStart = new Date(
      Date.now() - this.timings.cadenceMs,
    ).toISOString();
    const observations = this.deps.tier1.queryTopSalient(
      15,
      windowStart,
      CHAIN_SOURCE[chain],
    );
    if (observations.length < 3) return false;

    const t = this.live(chain);
    try {
      // Window-faithful by construction:
      // the previous texture is NOT an input — a thing stays in the
      // texture only while it keeps being observed. A carry input would
      // let content hop summary-to-summary indefinitely (the days-old
      // lore inside "the last 15 minutes"); the longform pass is
      // window-only too, so both chains stay honest the same way.
      const summary = await this.deps.smallLLM.compact(
        observations,
        this.deps.getMoodRender(),
        chain === "reverie" ? "reverie" : "noticing",
      );
      if (summary) {
        t.short = summary;
        t.shortWrittenAt = Date.now();
        this.deps.onTexture?.(chain, "short", summary);
        console.log(
          `[Flux] Compaction (${chain}) — ${observations.length} observations → texture (${summary.length} chars)`,
        );
        return true;
      }
    } catch (error) {
      console.error(
        `[Flux] Compaction (${chain}) failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return false;
  }

  /**
   * Run one longform pass for a chain: the hour-scale arc alongside the
   * close-up. Returns true when the texture updated.
   */
  async runLongPass(chain: CompactionChain): Promise<boolean> {
    const windowStart = new Date(
      Date.now() - this.timings.longformCadenceMs,
    ).toISOString();
    const observations = this.deps.tier1.queryTopSalient(
      30,
      windowStart,
      CHAIN_SOURCE[chain],
    );
    if (observations.length < 5) return false;

    const t = this.live(chain);
    try {
      const summary = await this.deps.smallLLM.compactLongform(
        observations,
        this.deps.getMoodRender(),
        chain === "reverie" ? "reverie" : "noticing",
      );
      if (summary) {
        t.long = summary;
        t.longWrittenAt = Date.now();
        this.deps.onTexture?.(chain, "long", summary);
        console.log(
          `[Flux] Compaction (${chain}, longform) — ${observations.length} observations → hour texture (${summary.length} chars)`,
        );
        return true;
      }
    } catch (error) {
      console.error(
        `[Flux] Compaction (${chain}, longform) failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return false;
  }
}
