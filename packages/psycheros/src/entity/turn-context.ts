/**
 * The baseline turn builder — the source of truth for how a Psycheros
 * turn's context is assembled. Every turn type composes this kit unless
 * explicitly specified otherwise; no parallel assembly gets built.
 * The canonical order, the placement
 * rubric for new blocks, and the cache-friendly/regular toggle live in
 * `docs/context-assembly.md` — this module is the code, that doc is the
 * constitution.
 *
 * The assembly has two stability classes:
 *
 * - **Stable core** — base instructions, identity files, capability
 *   anchors. Byte-identical across turns; it is the prompt-cache anchor,
 *   so nothing volatile may live here.
 * - **Dynamic block** — everything that changes per turn/generation,
 *   ordered by escalating recency: the RAG layer (all retrieved
 *   knowledge) → Live State (environmental fact) → the active working
 *   set (held skills + plugin hooks) → the mode block (behavioral
 *   framing, last — closest to generation). Facts get less provisional
 *   and instructions more binding as you descend.
 *
 * Regular placement renders both as one leading system message;
 * cache-friendly placement emits the dynamic block as a trailing system
 * message after the history (per-profile toggle — see the doc).
 */

import { formatWearableData } from "./sa-formatters.ts";
import { getWearableDataCache } from "../wearable/cache.ts";

// =============================================================================
// Timestamp formatting (moved here from loop.ts — it is context
// formatting; loop.ts re-exports it for existing importers)
// =============================================================================

/**
 * Format a timestamp for message content.
 * Uses PSYCHEROS_DISPLAY_TZ for user-facing timezone, falls back to TZ, defaults to UTC.
 * Format: <t>YYYY-MM-DD HH:MM</t>
 *
 * XML tags are used so the LLM treats timestamps as structural
 * metadata rather than content to reproduce.
 */
export function formatMessageTimestamp(date: Date): string {
  // PSYCHEROS_DISPLAY_TZ is set from Main Settings; TZ comes from the
  // process environment. If neither is set ("System Default" in Main
  // Settings with no TZ env), omit the timeZone option entirely so
  // toLocale* uses the system's actual timezone — NOT UTC. This was a
  // bug where "System Default" silently meant UTC and the entity
  // thought it was the middle of the night when it wasn't.
  const timeZone = Deno.env.get("PSYCHEROS_DISPLAY_TZ") ||
    Deno.env.get("TZ");
  const opts = timeZone ? { timeZone } : {};
  const weekday = date.toLocaleDateString("en-US", {
    ...opts,
    weekday: "short",
  });
  const year = date.toLocaleDateString("en-US", { ...opts, year: "numeric" });
  const month = date.toLocaleDateString("en-US", {
    ...opts,
    month: "2-digit",
  });
  const day = date.toLocaleDateString("en-US", { ...opts, day: "2-digit" });
  const time = date.toLocaleTimeString("en-US", {
    ...opts,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `<t>${weekday} ${year}-${month}-${day} ${time}</t>`;
}

// =============================================================================
// Stable core
// =============================================================================

/** Inputs for the stable core — identity and capability, nothing volatile. */
export interface StableCoreInputs {
  baseInstructions: string;
  selfContent: string;
  userContent: string;
  relationshipContent: string;
  customContent?: string;
  /** Available image generators + anchors — capability list; changes
   * rarely, so it rides the stable core (flagged for owner review in
   * the plan; move to the dynamic tail if generator lists churn). */
  imageGenContent?: string;
}

/** Compose the stable core — the byte-stable cache anchor. */
export function buildStableCore(inputs: StableCoreInputs): string {
  const sections: string[] = [];
  if (inputs.baseInstructions.trim()) {
    sections.push(inputs.baseInstructions);
  }
  if (inputs.selfContent.trim()) {
    sections.push(`---

My self files (from identity/self/ directory):

${inputs.selfContent}`);
  }
  if (inputs.userContent.trim()) {
    sections.push(`---

User files (from identity/user/ directory):

${inputs.userContent}`);
  }
  if (inputs.relationshipContent.trim()) {
    sections.push(`---

Relationship files (from identity/relationship/ directory):

${inputs.relationshipContent}`);
  }
  if (inputs.customContent?.trim()) {
    sections.push(`---

Custom files (from identity/custom/ directory):

${inputs.customContent}`);
  }
  if (inputs.imageGenContent?.trim()) {
    sections.push(`---

My available image generators:

${inputs.imageGenContent}`);
  }
  return sections.join("\n");
}

// =============================================================================
// Dynamic block
// =============================================================================

/**
 * Inputs for the dynamic block. Ordering is canonical; callers pass
 * whatever they have and the block renders what exists.
 */
export interface DynamicBlockInputs {
  // -- The RAG layer: all retrieved knowledge, query-triggered --------
  /** Lorebook-triggered entries (self-formatted by the lorebook manager). */
  lorebookContent?: string;
  /** Vault document retrieval (self-formatted by formatVaultContext). */
  vaultContent?: string;
  /** Memory RAG results — the BARE rendered list; the block frames it. */
  memoriesList?: string;
  /** Cross-conversation chat retrieval (self-formatted). */
  chatHistoryContent?: string;
  /** Knowledge-graph context (self-formatted). */
  graphContent?: string;

  // -- Live State: environmental fact ----------------------------------
  /** The situational-awareness block (buildSituationalAwareness). */
  situationalAwarenessContent?: string;

  // -- The active working set -------------------------------------------
  /** Held-skills block (the entity's live procedures). */
  heldSkillsContent?: string;
  /** Image-generation kit — enabled generators + anchor IDs. Classic
   * rides it in the stable core; the Flux session passes it here for
   * classic parity (built by buildImageGenContent). */
  imageGenContent?: string;
  /** Plugin prompt-hook content (budget-capped upstream). */
  pluginContent?: string;

  // -- The mode block: behavioral framing, LAST -------------------------
  /** Caller-supplied mode framing — Discord channel context, the Flux
   * presence block, the self-initiated/Pulse directive, per-turn state
   * the entity reads as itself. Composed by the caller; rendered last. */
  modeContent?: string;
}

/** Compose the dynamic block in canonical order. */
export function buildDynamicBlock(inputs: DynamicBlockInputs): string {
  // XML-wrapped sections throughout (situational-awareness style:
  // every region is a tagged block, no
  // bare --- separators with ad-hoc headers). Self-wrapped producers
  // (<situational_awareness>, <held_skills>) pass through untouched.
  const sections: string[] = [];

  // RAG layer — lorebook, vault, memories, chat, graph
  if (inputs.lorebookContent?.trim()) {
    sections.push(`<lorebook>
${inputs.lorebookContent}
</lorebook>`);
  }
  if (inputs.vaultContent?.trim()) {
    sections.push(`<vault>
${inputs.vaultContent}
</vault>`);
  }
  if (inputs.memoriesList?.trim()) {
    sections.push(`<memory_RAG>
${inputs.memoriesList}
</memory_RAG>`);
  }
  if (inputs.chatHistoryContent?.trim()) {
    sections.push(`<chat_RAG>
${inputs.chatHistoryContent}
</chat_RAG>`);
  }
  if (inputs.graphContent?.trim()) {
    sections.push(`<knowledge_graph>
${inputs.graphContent}
</knowledge_graph>`);
  }

  // Live State — self-wrapped (<situational_awareness>), pass through
  if (inputs.situationalAwarenessContent?.trim()) {
    sections.push(inputs.situationalAwarenessContent);
  }

  // Active working set — held skills self-wrap (<held_skills>);
  // plugin hooks get their tag here.
  if (inputs.heldSkillsContent?.trim()) {
    sections.push(inputs.heldSkillsContent);
  }
  // Image-generation kit — enabled generators + anchor IDs, the
  // generate_image capability block. Classic rides the same block in
  // its stable core; the Flux session passes it here (classic parity —
  // without it the session Ego has no IDs to call with).
  if (inputs.imageGenContent?.trim()) {
    sections.push(`<image_generation>
${inputs.imageGenContent}
</image_generation>`);
  }
  if (inputs.pluginContent?.trim()) {
    sections.push(`<plugin_context>
${inputs.pluginContent}
</plugin_context>`);
  }

  // Mode block — LAST, closest to generation (callers carry their own
  // tags: <flux_state>, <flux_mode>, Discord channel context, etc.)
  if (inputs.modeContent?.trim()) {
    sections.push(inputs.modeContent);
  }

  return sections.join("\n\n");
}

// =============================================================================
// Live State — the situational-awareness block
// =============================================================================

/** XML-escape a string for SA markup. */
function escapeXml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Format connected devices for the SA block. */
function formatConnectedDevices(
  snapshot: import("../server/device-cache.ts").DeviceCacheSnapshot,
  lovenseSettings?: import("../llm/lovense-settings.ts").LovenseSettings,
  buttplugSettings?: import("../llm/buttplug-settings.ts").ButtplugSettings,
): string | undefined {
  const parts: string[] = [];

  // Intimacy devices (Lovense + Intiface)
  const intimacyParts: string[] = [];

  if (snapshot.lovense.connected && snapshot.lovense.toys.length > 0) {
    const devices = snapshot.lovense.toys
      .map((t) => {
        const label = t.nickname || t.name;
        const functions = t.functions?.length
          ? ` functions="${escapeXml(t.functions.join(", "))}"`
          : "";
        return `      <device name="${
          escapeXml(label)
        }" battery="${t.battery}"${functions} />`;
      })
      .join("\n");
    intimacyParts.push(`    <lovense count="${snapshot.lovense.toys.length}">`);
    intimacyParts.push(devices);
    intimacyParts.push("    </lovense>");
  }

  if (snapshot.intiface.connected && snapshot.intiface.devices.length > 0) {
    const devices = snapshot.intiface.devices
      .map((d) => `      <device name="${escapeXml(d.name)}" />`)
      .join("\n");
    intimacyParts.push(
      `    <intiface count="${snapshot.intiface.devices.length}">`,
    );
    intimacyParts.push(devices);
    intimacyParts.push("    </intiface>");
  }

  if (intimacyParts.length > 0) {
    parts.push("  <intimacy>");
    parts.push(intimacyParts.join("\n"));
    parts.push("  </intimacy>");
  }

  // Home devices
  if (snapshot.homeDevices.length > 0) {
    const devices = snapshot.homeDevices
      .map((d) =>
        `    <device name="${escapeXml(d.name)}" type="${escapeXml(d.type)}" />`
      )
      .join("\n");
    parts.push("  <home>");
    parts.push(devices);
    parts.push("  </home>");
  }

  if (parts.length === 0) return undefined;

  let result = `  <connected_devices>\n${
    parts.join("\n")
  }\n  </connected_devices>`;

  // Inject custom instructions only when matching devices are connected
  if (
    snapshot.lovense.connected && snapshot.lovense.toys.length > 0 &&
    lovenseSettings?.customInstructions?.trim()
  ) {
    result += `\n  <lovense_preferences>${
      escapeXml(lovenseSettings.customInstructions.trim())
    }</lovense_preferences>`;
  }
  if (
    snapshot.intiface.connected && snapshot.intiface.devices.length > 0 &&
    buttplugSettings?.customInstructions?.trim()
  ) {
    result += `\n  <toy_preferences>${
      escapeXml(buttplugSettings.customInstructions.trim())
    }</toy_preferences>`;
  }

  return result;
}

/** Deps for the SA block — environmental fact only (the SA-minus-flux
 * rule: Flux state reaches its entity through briefings, never SA). */
export interface SituationalAwarenessDeps {
  /** Latest user interaction across conversations (may be null). */
  lastInteraction?: {
    /** String (DB row) or Date. */
    createdAt: string | Date;
    conversationId: string;
    title?: string | null;
  } | null;
  /** The current conversation (id + title). */
  conversation?: { id: string; title?: string } | null;
  /** Client device type for this turn (e.g. "mobile"). */
  deviceType?: string;
  /** Connected-device snapshot cache. */
  deviceStatusCache?: {
    getSnapshot(): import("../server/device-cache.ts").DeviceCacheSnapshot;
  };
  lovenseSettings?: import("../llm/lovense-settings.ts").LovenseSettings;
  buttplugSettings?: import("../llm/buttplug-settings.ts").ButtplugSettings;
  bleSettings?: Parameters<typeof formatWearableData>[1];
}

/** Build the situational-awareness block (Live State). Undefined when
 *  there is nothing to say. */
export function buildSituationalAwareness(
  deps: SituationalAwarenessDeps,
): string | undefined {
  const snapshot = deps.deviceStatusCache?.getSnapshot();
  const deviceSection = snapshot
    ? formatConnectedDevices(
      snapshot,
      deps.lovenseSettings,
      deps.buttplugSettings,
    )
    : undefined;

  if (
    deps.lastInteraction || deps.deviceType || deps.conversation ||
    deviceSection
  ) {
    const parts: string[] = ["<situational_awareness>"];
    parts.push(
      `  <current_time>${formatMessageTimestamp(new Date())}</current_time>`,
    );
    if (deps.conversation) {
      const title = deps.conversation.title
        ? escapeXml(deps.conversation.title)
        : "Untitled";
      parts.push(
        `  <current_conversation id="${deps.conversation.id}" title="${title}" />`,
      );
    }
    if (deps.lastInteraction) {
      const date = new Date(deps.lastInteraction.createdAt);
      const formatted = formatMessageTimestamp(date);
      const title = deps.lastInteraction.title
        ? escapeXml(deps.lastInteraction.title)
        : "Untitled";
      parts.push("  <last_user_message>");
      parts.push(`    <timestamp>${formatted}</timestamp>`);
      parts.push(
        `    <conversation id="${deps.lastInteraction.conversationId}" title="${title}" />`,
      );
      parts.push("  </last_user_message>");
    }
    if (deps.deviceType) {
      parts.push(`  <user_device>${deps.deviceType}</user_device>`);
    }
    if (deviceSection) {
      parts.push(deviceSection);
    }
    // Wearable data (sensor streams from connected devices)
    if (snapshot) {
      const wearableSection = formatWearableData(
        snapshot,
        deps.bleSettings,
        getWearableDataCache(),
      );
      if (wearableSection) {
        parts.push(wearableSection);
      }
    }
    parts.push("</situational_awareness>");
    return parts.join("\n");
  }
  return undefined;
}
