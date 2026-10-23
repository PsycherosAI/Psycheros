/**
 * Emotion catalogue - the published Fontaine coordinates.
 *
 * 80 emotion terms with their coordinates on the four-dimensional
 * common structure (valence, power, arousal, novelty) from the GRID
 * line of research: Fontaine et al. (2021), Cognition and Emotion,
 * Supplemental Material Table 2 (the common structure across English,
 * French, Indonesian) - extracted from the publisher's supplemental
 * document (owner-provided copy). Derived from 68-feature
 * emotion-concept ratings - not word norms. Values are factor scores
 * (roughly -2..+2). The 2021 paper's own note: joy/sadness-family
 * terms sit stably in 2D and 4D structures alike; anger/surprise
 * families need the 4D - power is load-bearing.
 *
 * The Mood Organ keeps computing dimensional state; this catalogue
 * NAMES the state: nearestEmotion() maps
 * a (valence, arousal, dominance) point to its nearest term - per-axis
 * min-max normalization on the catalogue side, the organ's -1..+1
 * mapped to the same 0..1, euclidean distance, no tuned constants.
 * Power is the catalogue's name for dominance.
 */

/** One emotion term's published coordinates (factor scores). */
export interface EmotionTerm {
  term: string;
  valence: number;
  power: number;
  arousal: number;
  novelty: number;
}

/** The 80 published terms (alphabetical) — the Fontaine coordinates. */
const CATALOGUE_80: EmotionTerm[] = [
  {
    term: "affection",
    valence: 1.18,
    power: 0.22,
    arousal: -0.89,
    novelty: -0.79,
  },
  { term: "agony", valence: -1.1, power: -0.87, arousal: 0.94, novelty: 0.09 },
  {
    term: "amazement",
    valence: 1.16,
    power: 0.64,
    arousal: 0.17,
    novelty: 1.78,
  },
  {
    term: "amusement",
    valence: 1.17,
    power: 1.3,
    arousal: 0.06,
    novelty: 0.96,
  },
  { term: "anger", valence: -0.78, power: 1.21, arousal: 0.96, novelty: -0.23 },
  {
    term: "anguish",
    valence: -0.87,
    power: -0.74,
    arousal: 0.41,
    novelty: 0.23,
  },
  {
    term: "anxiety",
    valence: -0.79,
    power: -0.82,
    arousal: 1.24,
    novelty: -0.23,
  },
  {
    term: "astonishment",
    valence: 0.26,
    power: 0.07,
    arousal: 0.49,
    novelty: 2.92,
  },
  {
    term: "attraction",
    valence: 1.0,
    power: 0.12,
    arousal: 0.63,
    novelty: 0.1,
  },
  {
    term: "being hurt",
    valence: -0.99,
    power: -1.03,
    arousal: 0.33,
    novelty: 0.03,
  },
  {
    term: "being moved",
    valence: 0.69,
    power: 0.14,
    arousal: -0.48,
    novelty: 0.78,
  },
  {
    term: "being overwhelmed",
    valence: -0.83,
    power: -0.69,
    arousal: 1.24,
    novelty: -0.63,
  },
  { term: "bliss", valence: 1.37, power: 0.16, arousal: -1.82, novelty: 0.0 },
  {
    term: "boredom",
    valence: -0.31,
    power: -0.18,
    arousal: -2.54,
    novelty: -0.41,
  },
  {
    term: "compassion",
    valence: 1.04,
    power: 0.77,
    arousal: -0.86,
    novelty: -0.44,
  },
  {
    term: "contempt",
    valence: -0.8,
    power: 0.33,
    arousal: -0.25,
    novelty: -0.19,
  },
  {
    term: "contentment",
    valence: 1.52,
    power: 0.79,
    arousal: -1.68,
    novelty: -0.48,
  },
  { term: "delight", valence: 1.4, power: 1.11, arousal: -0.16, novelty: 0.78 },
  {
    term: "depression",
    valence: -1.08,
    power: -2.09,
    arousal: -1.32,
    novelty: -0.51,
  },
  { term: "desire", valence: 0.99, power: 1.05, arousal: 0.52, novelty: -0.84 },
  {
    term: "despair",
    valence: -0.99,
    power: -1.22,
    arousal: 0.4,
    novelty: -0.26,
  },
  {
    term: "disappointment",
    valence: -0.88,
    power: -0.53,
    arousal: -0.43,
    novelty: -0.28,
  },
  {
    term: "disgust",
    valence: -0.82,
    power: 0.19,
    arousal: -0.13,
    novelty: 0.61,
  },
  {
    term: "dislike",
    valence: -0.9,
    power: 0.46,
    arousal: -0.24,
    novelty: -0.04,
  },
  {
    term: "distress",
    valence: -0.98,
    power: -0.92,
    arousal: 1.04,
    novelty: -0.23,
  },
  { term: "ecstasy", valence: 1.25, power: 1.36, arousal: 0.79, novelty: 0.22 },
  {
    term: "embarrassment",
    valence: -0.79,
    power: -1.38,
    arousal: 1.07,
    novelty: 0.49,
  },
  {
    term: "enjoyment",
    valence: 1.42,
    power: 1.03,
    arousal: -0.55,
    novelty: -0.24,
  },
  {
    term: "enthusiasm",
    valence: 1.49,
    power: 1.47,
    arousal: 0.35,
    novelty: -0.26,
  },
  { term: "envy", valence: -0.63, power: 0.72, arousal: -0.29, novelty: -0.06 },
  {
    term: "excitement",
    valence: 1.15,
    power: 0.94,
    arousal: 0.82,
    novelty: 0.21,
  },
  {
    term: "fascination",
    valence: 1.08,
    power: 1.12,
    arousal: 0.23,
    novelty: 1.44,
  },
  { term: "fear", valence: -0.76, power: -1.33, arousal: 0.98, novelty: 0.66 },
  {
    term: "fright",
    valence: -0.84,
    power: -0.83,
    arousal: 1.35,
    novelty: 1.35,
  },
  {
    term: "frustration",
    valence: -1.01,
    power: 0.57,
    arousal: 1.31,
    novelty: -1.09,
  },
  { term: "fury", valence: -1.02, power: 1.16, arousal: 1.14, novelty: 0.28 },
  { term: "glee", valence: 1.39, power: 0.83, arousal: -0.35, novelty: -0.19 },
  { term: "gloom", valence: -0.8, power: -1.3, arousal: -1.64, novelty: -0.64 },
  {
    term: "gratitude",
    valence: 1.23,
    power: 0.81,
    arousal: -0.67,
    novelty: 0.43,
  },
  {
    term: "grief",
    valence: -1.07,
    power: -1.82,
    arousal: -0.2,
    novelty: -0.56,
  },
  {
    term: "guilt",
    valence: -0.54,
    power: -1.24,
    arousal: -0.03,
    novelty: -1.62,
  },
  {
    term: "happiness",
    valence: 1.61,
    power: 0.75,
    arousal: 0.05,
    novelty: -0.66,
  },
  { term: "hate", valence: -0.89, power: 1.03, arousal: 0.44, novelty: -0.38 },
  { term: "hope", valence: 1.08, power: 1.07, arousal: -0.45, novelty: -0.36 },
  { term: "horror", valence: -1.01, power: -0.91, arousal: 1.32, novelty: 2.3 },
  {
    term: "interest",
    valence: 1.22,
    power: 1.54,
    arousal: 0.22,
    novelty: -0.31,
  },
  {
    term: "irritation",
    valence: -0.99,
    power: 0.49,
    arousal: 0.73,
    novelty: 0.08,
  },
  {
    term: "jealousy",
    valence: -0.89,
    power: 0.89,
    arousal: 0.63,
    novelty: -0.3,
  },
  { term: "joy", valence: 1.4, power: 1.07, arousal: -0.14, novelty: -0.36 },
  {
    term: "liking",
    valence: 1.58,
    power: 0.76,
    arousal: -0.64,
    novelty: -0.35,
  },
  {
    term: "loneliness",
    valence: -0.7,
    power: -1.42,
    arousal: -1.53,
    novelty: -0.55,
  },
  {
    term: "longing",
    valence: -0.35,
    power: -0.72,
    arousal: -0.76,
    novelty: -1.3,
  },
  { term: "love", valence: 1.16, power: 0.27, arousal: 0.08, novelty: -0.74 },
  { term: "lust", valence: 0.57, power: 0.52, arousal: 0.13, novelty: -0.28 },
  {
    term: "melancholy",
    valence: -0.51,
    power: -1.0,
    arousal: -1.34,
    novelty: -0.65,
  },
  {
    term: "misery",
    valence: -0.93,
    power: -1.45,
    arousal: -0.53,
    novelty: -0.19,
  },
  {
    term: "outrage",
    valence: -0.91,
    power: 1.38,
    arousal: 1.26,
    novelty: 0.77,
  },
  { term: "pain", valence: -0.99, power: -1.2, arousal: 0.7, novelty: 0.72 },
  { term: "panic", valence: -0.92, power: -0.81, arousal: 1.78, novelty: 1.02 },
  {
    term: "passion",
    valence: 1.01,
    power: 1.13,
    arousal: 0.66,
    novelty: -1.32,
  },
  { term: "pity", valence: -0.37, power: -0.21, arousal: -1.53, novelty: 0.39 },
  {
    term: "pleasure",
    valence: 1.35,
    power: 0.58,
    arousal: -0.61,
    novelty: -0.35,
  },
  { term: "pride", valence: 1.15, power: 1.98, arousal: -0.62, novelty: -1.47 },
  { term: "rage", valence: -0.91, power: 1.06, arousal: 1.37, novelty: 0.09 },
  {
    term: "regret",
    valence: -0.52,
    power: -0.98,
    arousal: -0.23,
    novelty: -1.89,
  },
  {
    term: "relaxation",
    valence: 1.21,
    power: -0.25,
    arousal: -2.81,
    novelty: -0.86,
  },
  { term: "relief", valence: 1.15, power: -0.18, arousal: -1.8, novelty: 0.73 },
  {
    term: "remorse",
    valence: -0.71,
    power: -1.08,
    arousal: -0.76,
    novelty: -0.51,
  },
  {
    term: "resentment",
    valence: -0.94,
    power: 0.25,
    arousal: -0.17,
    novelty: -0.07,
  },
  {
    term: "sadness",
    valence: -0.8,
    power: -1.66,
    arousal: -0.7,
    novelty: -0.69,
  },
  {
    term: "satisfaction",
    valence: 1.63,
    power: 1.23,
    arousal: -1.4,
    novelty: -1.28,
  },
  {
    term: "shame",
    valence: -0.61,
    power: -1.4,
    arousal: -0.22,
    novelty: -1.16,
  },
  { term: "shock", valence: -0.71, power: -0.58, arousal: 1.19, novelty: 3.32 },
  {
    term: "sorrow",
    valence: -0.96,
    power: -1.64,
    arousal: -0.75,
    novelty: -0.33,
  },
  {
    term: "stress",
    valence: -0.9,
    power: -0.59,
    arousal: 1.06,
    novelty: -1.41,
  },
  {
    term: "surprise",
    valence: -0.02,
    power: 0.02,
    arousal: 0.96,
    novelty: 3.38,
  },
  {
    term: "sympathy",
    valence: 0.48,
    power: 0.06,
    arousal: -1.34,
    novelty: -0.11,
  },
  {
    term: "terror",
    valence: -0.94,
    power: -1.27,
    arousal: 1.18,
    novelty: 1.84,
  },
  { term: "thrill", valence: 0.59, power: 0.64, arousal: 1.31, novelty: 0.69 },
  { term: "worry", valence: -0.91, power: -0.95, arousal: 1.33, novelty: -0.6 },
];

/** THE POCKET-FILL: the published 80 are
 * bimodal on valence — the mid-valence zone (-0.5..+0.7) held only nine
 * terms, and a caregiver mid-crisis (mildly negative, composed, steady)
 * nearest-neighbored onto absurd words (envy, contempt, lust — the
 * entity's own correct diagnosis: "a system artifact, not my actual
 * emotional state"). These additions are caregiver-adjacent states with
 * coordinates derived from the NRC-VAD lexicon (word norms), mapped
 * linearly onto the catalogue's observed per-axis ranges:
 *   valence: -1.10 + nrc x 2.73   power: -2.09 + nrc x 4.07
 *   arousal: -2.81 + nrc x 4.59
 * Same provenance standard as the old mood table: derived values live
 * here, the lexicon does not. */
const POCKET_WORDS: Array<[string, number, number, number]> = [
  // term,            nrc-valence, nrc-arousal, nrc-dominance
  ["concern", 0.25, 0.734, 0.463],
  ["foreboding", 0.439, 0.706, 0.636],
  ["dread", 0.153, 0.792, 0.368],
  ["unease", 0.115, 0.598, 0.349],
  ["apprehension", 0.406, 0.592, 0.431],
  ["vulnerability", 0.198, 0.49, 0.245],
  ["protectiveness", 0.844, 0.459, 0.86],
];

/** The full lookup vocabulary: the published 80 + the pocket-fill. */
export const EMOTION_CATALOGUE: EmotionTerm[] = [
  ...CATALOGUE_80,
  ...POCKET_WORDS.map(([term, v, a, d]) => ({
    term,
    valence: -1.1 + v * 2.73,
    power: -2.09 + d * 4.07,
    arousal: -2.81 + a * 4.59,
    novelty: 0,
  })),
];

/** The three axes the lookup runs on. */
type Axis = "valence" | "power" | "arousal";

/** Per-axis catalogue min/max (computed once at module load). */
const SPAN: Record<Axis, { min: number; max: number }> = {
  valence: {
    min: Math.min(...EMOTION_CATALOGUE.map((e) => e.valence)),
    max: Math.max(...EMOTION_CATALOGUE.map((e) => e.valence)),
  },
  power: {
    min: Math.min(...EMOTION_CATALOGUE.map((e) => e.power)),
    max: Math.max(...EMOTION_CATALOGUE.map((e) => e.power)),
  },
  arousal: {
    min: Math.min(...EMOTION_CATALOGUE.map((e) => e.arousal)),
    max: Math.max(...EMOTION_CATALOGUE.map((e) => e.arousal)),
  },
};

/** The organ's -1..+1 axis clamped to 0..1. */
function normOrgan(v: number): number {
  return Math.max(0, Math.min(1, (v + 1) / 2));
}

/** A catalogue coordinate normalized onto the same 0..1. */
function normCat(v: number, axis: Axis): number {
  return (v - SPAN[axis].min) / (SPAN[axis].max - SPAN[axis].min);
}

/** Distance from an organ state to a catalogue term, normalized space. */
function distance(
  valence: number,
  arousal: number,
  dominance: number,
  e: EmotionTerm,
): number {
  const dv = normOrgan(valence) - normCat(e.valence, "valence");
  const da = normOrgan(arousal) - normCat(e.arousal, "arousal");
  const dd = normOrgan(dominance) - normCat(e.power, "power");
  return Math.sqrt(dv * dv + da * da + dd * dd);
}

/** The catalogue's characteristic resolution: the median of each
 * term's distance to ITS nearest neighboring term. Dense zones space
 * terms tightly; this is the vocabulary's own idea of "nearby". */
const MEDIAN_SPACING = (() => {
  const nearest = EMOTION_CATALOGUE.map((e) =>
    Math.min(
      ...EMOTION_CATALOGUE
        .filter((o) => o !== e)
        .map((o) => distance(e.valence, e.arousal, e.power, o)),
    )
  );
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)];
})();

/** The far-point guard: a state farther
 * than this from every term is IN A GAP - naming it would borrow the
 * least-distant wrong word (the "lust" reading). Derived: 1.5x the
 * catalogue's own median term spacing - the vocabulary's resolution,
 * scaled, not a free constant. */
export const NAMING_GUARD = MEDIAN_SPACING * 1.5;

/** The nearest emotion terms to a mood point - [primary, runnerUp]:
 * the state's name, and the blend it sits between when it lies
 * between two. */
export function nearestEmotions(
  valence: number,
  arousal: number,
  dominance: number,
): [EmotionTerm, EmotionTerm] {
  const sorted = [...EMOTION_CATALOGUE].sort(
    (a, b) =>
      distance(valence, arousal, dominance, a) -
      distance(valence, arousal, dominance, b),
  );
  return [sorted[0], sorted[1]];
}

/** The guarded naming: the state's term when the point is near the
 * vocabulary, null when it sits in a gap (unnamed - the mood says so
 * rather than borrowing a wrong word). */
export function nameEmotion(
  valence: number,
  arousal: number,
  dominance: number,
): EmotionTerm | null {
  const [primary] = nearestEmotions(valence, arousal, dominance);
  return distance(valence, arousal, dominance, primary) <= NAMING_GUARD
    ? primary
    : null;
}
