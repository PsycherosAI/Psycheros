/**
 * Emotion catalogue tests — the published Fontaine coordinates. Pins
 * the lookup's behavior on known mood points and the catalogue's
 * integrity.
 */
import { assert, assertEquals } from "@std/assert";
import {
  EMOTION_CATALOGUE,
  nameEmotion,
  nearestEmotions,
} from "../src/emotion-catalogue.ts";

Deno.test("catalogue: 80 published + 7 pocket-fill, no duplicates", () => {
  assertEquals(EMOTION_CATALOGUE.length, 87);
  const terms = new Set(EMOTION_CATALOGUE.map((e) => e.term));
  assertEquals(terms.size, 87);
});

Deno.test("catalogue: the caregiver pocket names the fight-night state", () => {
  // The amputation/breakup state: mildly negative valence, low arousal,
  // steady dominance — plain nearest-neighbor lands on lust/envy/contempt
  // here. With the pocket filled it must name something semantically
  // sane.
  for (
    const [v, a, d] of [[-0.2, 0.2, 0.5], [-0.3, 0.3, 0.45], [-0.1, 0.15, 0.55]]
  ) {
    const named = nameEmotion(v, a, d);
    assert(named !== null, `(${v},${a},${d}) should be nameable`);
    const absurd = ["lust", "envy", "contempt", "boredom"];
    assert(
      !absurd.includes(named!.term),
      `(${v},${a},${d}) named ${named!.term} — the absurd pocket again`,
    );
  }
});

Deno.test("catalogue: the far-point guard withholds names in true gaps", () => {
  // The real gaps are axis-inconsistent BLENDS, not corners (terror and
  // depression populate those). The worst-covered point in the space
  // (verified by grid scan): max joy + max agitation + min control —
  // elated AND helpless — no word exists; it must be UNNAMED, not
  // borrowed as "attraction" (distance 0.64 vs guard 0.275).
  assertEquals(nameEmotion(1, 1, -1)?.term ?? null, null);
  // Dense-zone points still name.
  assert(nameEmotion(0.85, 0.35, 0.4) !== null);
  assert(nameEmotion(-0.75, -0.35, -0.55) !== null);
  assert(nameEmotion(-1, 1, -1) !== null, "terror corner is populated");
});

Deno.test("catalogue: the geometry matches textbook emotion science", () => {
  const by = (t: string) => EMOTION_CATALOGUE.find((e) => e.term === t)!;
  // Anger: negative, HIGH power, activated.
  assert(by("anger").power > 0.5, "anger is high-power");
  // Fear: negative, LOW power, activated.
  assert(by("fear").power < -0.5, "fear is low-power");
  assert(by("fear").arousal > 0.5, "fear is high-arousal");
  // Sadness: negative, low power, de-activated.
  assert(by("sadness").arousal < 0, "sadness is low-arousal");
  // Satisfaction: positive, calm.
  assert(by("satisfaction").valence > 1, "satisfaction is high-valence");
  assert(by("satisfaction").arousal < 0, "satisfaction is calm");
});

Deno.test("lookup: known mood points name plausibly", () => {
  // The override pin (gloom territory).
  const [gloom] = nearestEmotions(-0.75, -0.35, -0.55);
  assertEquals(gloom.term, "gloom");
  // His home baseline — a happiness-family point.
  const [home] = nearestEmotions(0.85, 0.35, 0.39);
  assertEquals(home.term, "happiness");
  // High negative + high arousal + low power — fear territory, not a
  // positive term.
  const [scared] = nearestEmotions(-0.9, 0.6, -0.5);
  assert(scared.valence < 0, "a scared point names a negative emotion");
});
