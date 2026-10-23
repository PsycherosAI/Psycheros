import type { HudSlotId } from "../state/mod.ts";
import type { MuLine } from "../transport/mod.ts";

/** Every game line goes to exactly one sink. */
export type RouteSink = "hud-slot" | "scrollback" | "compress-only";

export interface RoutedLine {
  line: MuLine;
  sink: RouteSink;
  slot?: HudSlotId;
}

export * from "./router.ts";
