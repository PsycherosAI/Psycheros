/**
 * Consolidation pass — tier 3 (flux → entity-core).
 *
 * Runs at 5am (scheduled by the host). Reads the previous day's
 * promoted observations and Flux Space durable entries, formats them
 * into a first-person narrative, and writes a daily memory to
 * entity-core via the injected memory writer. The host registers this
 * as a scheduler handler (`flux.consolidate`).
 *
 * Entity-core stays canonical — flux produces canonical memory items,
 * it does not hold a rival memory store. If the memory writer is
 * unavailable (MCP disabled), the pass logs and defers; tier-2 data
 * persists and re-consolidates next pass, mirroring how psycheros's own
 * daily summarization handles MCP failures.
 */

import type { Database } from "@db/sqlite";
import type { FluxMemoryWriter } from "./host.ts";
import {
  getDurableEntriesBetween,
  getPromotedObservationsBetween,
  markPromotedConsolidated,
} from "./tier2-store.ts";

// =============================================================================
// Consolidation
// =============================================================================

/**
 * Run the consolidation pass for a target date.
 *
 * @param sharedDb - the shared psycheros.db handle (tier-2 tables).
 * @param memoryWriter - injected entity-core writer, or null to defer.
 * @param fluxSpaceId - the Flux Space conversation ID (recorded in chatIds).
 * @param targetDateISO - the date to consolidate (YYYY-MM-DD). Defaults to yesterday.
 * @returns true if the memory was written, false if deferred or empty.
 */
export async function runFluxConsolidation(
  sharedDb: Database,
  memoryWriter: FluxMemoryWriter | null,
  fluxSpaceId: string,
  targetDateISO?: string,
  // Storage alignment: dialogue's record is the messages
  // table; the host reads it (flux cannot) and passes rows here.
  dialogue?: Array<{ role: string; content: string }>,
): Promise<boolean> {
  if (!memoryWriter) {
    console.log(
      "[Flux] Consolidation skipped — no memory writer (MCP disabled)",
    );
    return false;
  }

  const target = targetDateISO ?? yesterdayISO();
  const startISO = `${target}T00:00:00.000Z`;
  const endISO = `${target}T23:59:59.999Z`;

  const promoted = getPromotedObservationsBetween(sharedDb, startISO, endISO);
  const entries = getDurableEntriesBetween(sharedDb, startISO, endISO);

  if (promoted.length === 0 && entries.length === 0) {
    console.log(`[Flux] Consolidation for ${target} — nothing to consolidate`);
    return true; // Successful no-op, not a failure.
  }

  const content = formatConsolidationNarrative(
    target,
    promoted,
    entries,
    dialogue,
  );
  const slug = `flux-daily-${target}`;

  try {
    const ok = await memoryWriter.createMemory(
      "daily",
      target,
      content,
      [fluxSpaceId],
      slug,
    );
    if (!ok) {
      console.error(
        `[Flux] Consolidation for ${target} — memory writer returned false`,
      );
      return false;
    }

    markPromotedConsolidated(sharedDb, startISO, endISO);
    console.log(
      `[Flux] Consolidation for ${target} complete — ${promoted.length} promoted, ${entries.length} entries → daily memory`,
    );
    return true;
  } catch (error) {
    console.error(
      `[Flux] Consolidation for ${target} failed:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

// =============================================================================
// Narrative formatting (template-based for PoC)
// =============================================================================

/**
 * Format the day's flux activity into a first-person narrative memory.
 * Template-based to avoid an extra LLM call in the PoC — once the
 * volume warrants it, this can route through the small model for a
 * richer summary.
 */
function formatConsolidationNarrative(
  date: string,
  promoted: Array<
    { content: string; salience: number; promotionReason: string }
  >,
  entries: Array<{ role: string; content: string; timestamp: string }>,
  dialogue?: Array<{ role: string; content: string }>,
): string {
  const lines: string[] = [];
  lines.push(`Flux activity on ${date}.`);
  lines.push("");

  if (promoted.length > 0) {
    lines.push(
      `Sensory observations that reached me (promoted, ${promoted.length}):`,
    );
    for (const p of promoted.slice(0, 20)) {
      lines.push(`- ${p.content} (salience ${p.salience.toFixed(2)})`);
    }
    if (promoted.length > 20) {
      lines.push(`... and ${promoted.length - 20} more.`);
    }
    lines.push("");
  }

  const dialogueRows = dialogue ??
    entries.filter((e) => e.role !== "ambient").map((e) => ({
      role: e.role,
      content: e.content,
    }));
  if (dialogueRows.length > 0) {
    lines.push(`Flux Space exchanges (${dialogueRows.length}):`);
    for (const e of dialogueRows.slice(0, 30)) {
      const speaker = e.role === "user" ? "User" : "Me";
      lines.push(`- ${speaker}: ${truncate(e.content, 200)}`);
    }
    if (dialogueRows.length > 30) {
      lines.push(`... and ${dialogueRows.length - 30} more.`);
    }
  }

  return lines.join("\n");
}

/** Truncate to `n` chars with an ellipsis. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Yesterday's date as YYYY-MM-DD (UTC). */
function yesterdayISO(): string {
  const d = new Date(Date.now() - 86_400_000);
  return d.toISOString().slice(0, 10);
}
