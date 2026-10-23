/**
 * Settings tests — defaults, normalization (forward-compat), and
 * load/save round-trip against a temp directory.
 */

import { assertEquals } from "@std/assert";
import {
  getDefaultFluxSettings,
  loadFluxSettings,
  normalizeFluxSettings,
  saveFluxSettings,
} from "../src/settings.ts";

Deno.test("settings: defaults are disabled", () => {
  const s = getDefaultFluxSettings();
  assertEquals(s.enabled, false);
  assertEquals(s.retentionDays, 7);
  assertEquals(s.enabledOrgans, []);
});

Deno.test("settings: normalize fills missing promotion threshold fields", () => {
  // A partial save from an older version (no escalation field). Real
  // loads arrive via JSON.parse, which yields a loose shape — mirror
  // that here so the partial-threshold case type-checks.
  const partial = JSON.parse(
    '{"enabled": true, "promotionThresholds": {"salience": 0.6}}',
  );
  const normalized = normalizeFluxSettings(partial);
  assertEquals(normalized.enabled, true);
  assertEquals(normalized.promotionThresholds.salience, 0.6); // preserved
  assertEquals(normalized.promotionThresholds.escalation, 0.70); // defaulted
  assertEquals(normalized.promotionThresholds.corroborationWindowMs, 300_000);
});

Deno.test("settings: load returns defaults when file missing", async () => {
  const s = await loadFluxSettings("./nonexistent-dir-" + crypto.randomUUID());
  assertEquals(s.enabled, false);
  assertEquals(s, getDefaultFluxSettings());
});

Deno.test("settings: save then load round-trips", async () => {
  const dir = "./tmp-flux-test-" + crypto.randomUUID();
  const saved = getDefaultFluxSettings();
  saved.enabled = true;
  saved.retentionDays = 14;
  saved.promotionThresholds.combined = 0.6;

  const persisted = await saveFluxSettings(dir, saved);
  assertEquals(persisted.enabled, true);
  assertEquals(persisted.retentionDays, 14);

  const loaded = await loadFluxSettings(dir);
  assertEquals(loaded.enabled, true);
  assertEquals(loaded.retentionDays, 14);
  assertEquals(loaded.promotionThresholds.combined, 0.6);
  // Defaults still present for unmodified fields.
  assertEquals(loaded.promotionThresholds.escalation, 0.70);
  // No senses enabled by default — every Sensory Organ is opt-in.
  assertEquals(loaded.enabledOrgans.length, 0);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("settings: mood classifier provisioning fields normalize", async () => {
  const { normalizeFluxSettings } = await import("../src/settings.ts");
  // Defaults: int8, the project's verified repo (upgraded installs get
  // it via the absent-key fallback; "" is still a deliberate off).
  const d = normalizeFluxSettings({});
  assertEquals(d.moodClassifierVariant, "int8");
  assertEquals(d.moodClassifierRepoId, "Psycheros/vad-bert");
  // Saved values survive; junk variant falls back to int8.
  const s = normalizeFluxSettings({
    moodClassifierVariant: "fp32",
    moodClassifierRepoId: "owner/vad-bert",
  });
  assertEquals(s.moodClassifierVariant, "fp32");
  assertEquals(s.moodClassifierRepoId, "owner/vad-bert");
  const j = normalizeFluxSettings({
    moodClassifierVariant: "fp16" as never,
    moodClassifierRepoId: 42 as never,
  });
  assertEquals(j.moodClassifierVariant, "int8");
  // Non-string junk reads as absent -> the default.
  assertEquals(j.moodClassifierRepoId, "Psycheros/vad-bert");
});

Deno.test("settings: absent or empty repo id normalizes to the default", async () => {
  const { normalizeFluxSettings } = await import("../src/settings.ts");
  // Absent — an install upgrading past the field — gets the committed
  // default.
  const upgraded = normalizeFluxSettings({});
  assertEquals(upgraded.moodClassifierRepoId, "Psycheros/vad-bert");
  // Explicit empty (the bug-written value that persisted into files)
  // heals to the default too — empty is not a meaningful off.
  const healed = normalizeFluxSettings({ moodClassifierRepoId: "" });
  assertEquals(healed.moodClassifierRepoId, "Psycheros/vad-bert");
});
