import { FluxManager } from "../src/flux-manager.ts";
import { assertEquals } from "@std/assert";

/**
 * GRADED DAMPING — a binary cliff kills near-novel bids; graded factors
 * let them through:
 *
 *   ratio 1.30 → factor 0.99 — wakes (the absurd case)
 *   ratio 1.32 → factor 0.95 — wakes
 *   presence twins → factor 0.00–0.60 — stays dead (correctly)
 */
Deno.test("graded damping: the 12:39:09 absurd case now wakes", () => {
  // Engagement bid at the 0.90 salience floor, factor 0.99, bar 0.75.
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.99, 0.75), true);
});

Deno.test("graded damping: near-novel cluster (factor ≥ 0.83) wakes", () => {
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.95, 0.75), true);
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.86, 0.75), true);
  // The exact bar-crossing factor for the 0.90 floor: 0.75 / 0.90.
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.8334, 0.75), true);
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.8333, 0.75), false);
});

Deno.test("graded damping: presence twins stay dead", () => {
  // The repeat-caption cluster: factors 0.00–0.60.
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.60, 0.75), false);
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.50, 0.75), false);
  assertEquals(FluxManager.dampedWakeClearsBar(0.90, 0.00, 0.75), false);
});

Deno.test("graded damping: categorical interior judgments still die", () => {
  // Musing proposals sit AT the bar (0.75 categorical) — any damping
  // takes them under it; murmur/propose semantics unchanged.
  assertEquals(FluxManager.dampedWakeClearsBar(0.75, 0.85, 0.75), false);
  assertEquals(FluxManager.dampedWakeClearsBar(0.75, 0.99, 0.75), false);
});

Deno.test("graded damping: strong promoted escalations survive mild damping", () => {
  // combined 0.80 with mild factor 0.95 → 0.76 clears the 0.75 bar;
  // combined 0.76 with 0.90 → 0.684 does not.
  assertEquals(FluxManager.dampedWakeClearsBar(0.80, 0.95, 0.75), true);
  assertEquals(FluxManager.dampedWakeClearsBar(0.76, 0.90, 0.75), false);
});

Deno.test("mood feedback: the thinking is scored, speech is the fallback", async () => {
  const { moodFeedbackText } = await import("../src/flux-manager.ts");
  // Interior present — the reasoning trace wins (the mood organ reads
  // the interior, not the performance).
  const withThinking = moodFeedbackText({
    content: "I've got you. Stay right there.",
    thinking: "She might lose the leg. I'm terrified for her.",
  });
  assertEquals(withThinking.source, "conscious-thinking");
  assertEquals(
    withThinking.text,
    "She might lose the leg. I'm terrified for her.",
  );
  // No reasoning (non-thinking profile, voice turns) — speech stands.
  const speechOnly = moodFeedbackText({
    content: "I'm here.",
    thinking: null,
  });
  assertEquals(speechOnly.source, "conscious-speech");
  assertEquals(speechOnly.text, "I'm here.");
  // Whitespace-only thinking is no thinking.
  const blank = moodFeedbackText({ content: "I'm here.", thinking: "   " });
  assertEquals(blank.source, "conscious-speech");
});
