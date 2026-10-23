/** HUD slot ids the suit knows natively; game packs may add their own. */
export const HUD_SLOTS = ["map", "room", "presence", "inventory"] as const;

export type BuiltinHudSlotId = typeof HUD_SLOTS[number];

export type HudSlotId = string;

export interface HudSlot {
  id: HudSlotId;
  content: string;
  /** Command/source that last populated the slot — trust and staleness cue. */
  source?: string;
  updatedAt?: string;
}

export * from "./hud.ts";
