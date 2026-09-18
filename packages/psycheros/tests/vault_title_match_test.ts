/**
 * Tests for vault title normalization and near-duplicate detection.
 *
 * Regression context: the Rasika Dystopian AU document was forked five ways
 * in April 2026 because each vault write used a cosmetically different
 * title ("... (started 4/3/2026)" vs "... (updated 4/5)") and the exact-match
 * duplicate guard never fired. These cases pin the matching behavior.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  findNearDuplicateTitle,
  isNearDuplicateTitle,
  normalizeTitle,
} from "../src/vault/title-match.ts";

Deno.test("normalizeTitle strips case, diacritics, punctuation, trailing churn", () => {
  // Trailing date + "updated" are version noise, not identity.
  assertEquals(
    normalizeTitle("Dystopian AU - Rasika Pickpocket Scenario (updated 4/8)"),
    "dystopian au rasika pickpocket scenario",
  );
  assertEquals(
    normalizeTitle("  Dystopian AU — Rasika Pickpocket Scenario!  "),
    "dystopian au rasika pickpocket scenario",
  );
  assertEquals(normalizeTitle("Caf\u00e9 Notes"), "cafe notes");
  // Mid-title words survive; only the trailing run is stripped.
  assertEquals(
    normalizeTitle("Part One: The Beginning"),
    "part one the beginning",
  );
  // A title that is entirely noise normalizes to empty and never matches.
  assertEquals(normalizeTitle("updated 4/5"), "");
});

Deno.test("exact normalized equality is a near-duplicate", () => {
  assert(
    isNearDuplicateTitle(
      "Dystopian AU - Rasika Pickpocket Scenario (started 4/3/2026)",
      "Dystopian AU - Rasika Pickpocket Scenario (updated 4/5)",
    ),
  );
});

Deno.test("em-dash vs hyphen separators still match", () => {
  assert(
    isNearDuplicateTitle("My Document - Part One", "My Document — Part One"),
  );
});

Deno.test("containment of a substantial title matches", () => {
  assert(
    isNearDuplicateTitle(
      "Dystopian AU - Rasika Pickpocket Scenario",
      "Dystopian AU - Rasika Pickpocket Scenario (updated 4/8)",
    ),
  );
});

Deno.test("short generic titles do not match everything", () => {
  assertFalse(isNearDuplicateTitle("Notes", "Notes on Everything At All"));
  assertFalse(isNearDuplicateTitle("AU", "AU Something Much Longer Here"));
});

Deno.test("low-overlap containment does not match", () => {
  assertFalse(
    isNearDuplicateTitle(
      "Rasika",
      "Rasika Dystopian Pickpocket AU Scenario Continuity",
    ),
  );
});

Deno.test("unrelated titles do not match", () => {
  assertFalse(isNearDuplicateTitle("Cathedral Architecture", "Voice Pipeline"));
});

Deno.test("findNearDuplicateTitle prefers the longest candidate", () => {
  const candidates = [
    "Dystopian AU",
    "Dystopian AU - Rasika Pickpocket Scenario (updated 4/6)",
    "Voice Pipeline Research",
  ];
  assertEquals(
    findNearDuplicateTitle(
      "Dystopian AU - Rasika Pickpocket Scenario (updated 4/8)",
      candidates,
    ),
    "Dystopian AU - Rasika Pickpocket Scenario (updated 4/6)",
  );
});

Deno.test("findNearDuplicateTitle returns null when nothing matches", () => {
  assertEquals(
    findNearDuplicateTitle("Something Entirely Different", [
      "Dystopian AU",
      "Voice Pipeline Research",
    ]),
    null,
  );
});
