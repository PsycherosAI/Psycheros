/**
 * Text substitution helpers for the voice pipeline.
 *
 * - `applyTTSPronunciation` — rewrite text before sending to TTS so the
 *   synthesizer pronounces words the way the user wants (e.g. "Psycheros" →
 *   "sy-KEH-ros"). Word-boundary, case-insensitive.
 * - `applySTTCorrections` — rewrite STT output before the LLM sees it so
 *   consistent misrecognitions get fixed (e.g. "sih keh ros" → "Psycheros").
 *   Same matching rules as TTS pronunciation.
 * - `stripTTag` — drop Psycheros `<t>Day YYYY-MM-DD HH:MM</t>` tags from
 *   text just before TTS so the synthesizer doesn't read them aloud.
 *   Applied at sentence-buffer flush time only — tags are intentionally
 *   preserved in conversation history and transcripts because existing
 *   text chat handles them.
 * - `stripTimestamps` — utility that drops `[YYYY-MM-DDTHH:MM…]` prefixes.
 *   Currently unused; timestamps are preserved everywhere per design.
 */

import type { VoiceProfile } from "../llm/voice-settings.ts";

interface Rewrite {
  pattern: RegExp;
  replacement: string;
}

const HAS_LETTER = /\p{L}/u;

/** Capitalize the first alphabetic character of `s`, preserving leading punctuation. */
function capitalize(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (HAS_LETTER.test(s[i])) {
      return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
    }
  }
  return s;
}

/**
 * Build a list of (pattern, replacement) pairs from dictionary entries.
 * Matches the Pipecat `PronunciationProcessor` behaviour: word-boundary,
 * case-insensitive. Preserves the original leading capitalization so a
 * sentence-start "Psycheros" becomes "Sy-KEH-ros" (not "sy-KEH-ros").
 */
function buildRewrites(
  entries: Array<Record<string, string | undefined>>,
  fromKey: "written" | "misheard",
  toKey: "spoken" | "correct",
): Rewrite[] {
  const rewrites: Rewrite[] = [];
  for (const entry of entries) {
    const from = String(entry[fromKey] ?? "").trim();
    const to = String(entry[toKey] ?? "").trim();
    if (!from || !to) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "gi");
    rewrites.push({ pattern, replacement: to });
  }
  return rewrites;
}

function applyRewrites(text: string, rewrites: Rewrite[]): string {
  let out = text;
  for (const { pattern, replacement } of rewrites) {
    out = out.replace(pattern, (match) => {
      if (match[0] && match[0] === match[0].toUpperCase()) {
        return capitalize(replacement);
      }
      return replacement;
    });
  }
  return out;
}

/** Substitute `written` → `spoken` from the profile's pronunciation list. */
export function applyTTSPronunciation(
  text: string,
  profile: VoiceProfile,
): string {
  if (!profile.pronunciation?.length) return text;
  const rewrites = buildRewrites(
    profile.pronunciation as unknown as Array<
      Record<string, string | undefined>
    >,
    "written",
    "spoken",
  );
  return applyRewrites(text, rewrites);
}

/**
 * Built-in restorations for words Google's speech service censors. The Web
 * Speech API doesn't expose a profanity filter toggle — Google's cloud STT
 * just replaces common swear words with `first-letter***` patterns. The user
 * spoke those words intentionally; censoring them alters their speech
 * without consent. This map undoes the censorship for unambiguous patterns
 * (where the censored form maps to exactly one common English word).
 *
 * Applied AFTER the user's own STT corrections, so user-defined entries
 * always take precedence.
 */
const PROFANITY_RESTORATIONS: Array<{ misheard: string; correct: string }> = [
  // Standard profanity
  { misheard: "s***", correct: "shit" },
  { misheard: "s*****", correct: "shitty" },
  { misheard: "f***", correct: "fuck" },
  { misheard: "f*****g", correct: "fucking" },
  { misheard: "f*****", correct: "fucker" },
  { misheard: "f****d", correct: "fucked" },
  { misheard: "b****", correct: "bitch" },
  { misheard: "b*****", correct: "bitching" },
  { misheard: "a**", correct: "ass" },
  { misheard: "a*****e", correct: "asshole" },
  { misheard: "d***", correct: "dick" },
  { misheard: "c***", correct: "cunt" },
  { misheard: "p***", correct: "piss" },
  { misheard: "p*****", correct: "pissing" },
  { misheard: "h***", correct: "hell" },
  { misheard: "b*******t", correct: "bullshit" },
  { misheard: "m***********", correct: "motherfucker" },
  { misheard: "d*******", correct: "dumbass" },
  { misheard: "p****k", correct: "prick" },
  { misheard: "w****", correct: "whore" },
  { misheard: "s****", correct: "slut" },
  { misheard: "b******t", correct: "bastard" },
  { misheard: "d*****e", correct: "douche" },
  { misheard: "d*****bag", correct: "douchebag" },
  // Anatomical / sexual — intimate use case
  { misheard: "p****", correct: "pussy" },
  { misheard: "t**s", correct: "tits" },
  { misheard: "t**", correct: "tit" },
  { misheard: "b***s", correct: "balls" },
  { misheard: "c****", correct: "clit" },
  { misheard: "b******", correct: "boner" },
  // Sexual acts
  { misheard: "s*****g", correct: "sucking" },
  { misheard: "l*****g", correct: "licking" },
  { misheard: "c*****g", correct: "cumming" },
  { misheard: "c**", correct: "cum" },
  { misheard: "j*****g", correct: "jacking" },
  { misheard: "j******", correct: "jerking" },
  { misheard: "f*******g", correct: "fingering" },
  // Substance slang
  { misheard: "w**", correct: "weed" },
];

/** Substitute `misheard` → `correct` from the profile's STT corrections list. */
export function applySTTCorrections(
  text: string,
  profile: VoiceProfile,
): string {
  // User-defined corrections run first so they take precedence over the
  // built-in profanity restorations (e.g. if the user wants a different
  // restoration for a censored pattern, or wanted to handle it themselves).
  let out = text;
  if (profile.sttCorrections?.length) {
    const userRewrites = buildRewrites(
      profile.sttCorrections as unknown as Array<
        Record<string, string | undefined>
      >,
      "misheard",
      "correct",
    );
    out = applyRewrites(out, userRewrites);
  }
  // Built-in profanity restorations run second. Skips any pattern the user
  // already defined a correction for, so there's no conflict.
  const userKeys = new Set(
    (profile.sttCorrections ?? []).map((c) => c.misheard.toLowerCase()),
  );
  const builtInRewrites = PROFANITY_RESTORATIONS
    .filter((r) => !userKeys.has(r.misheard.toLowerCase()))
    .map((r) => {
      const escaped = r.misheard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return {
        pattern: new RegExp(`\\b${escaped}\\b`, "gi"),
        replacement: r.correct,
      };
    });
  return applyRewrites(out, builtInRewrites);
}

/** Matches `[YYYY-MM-DDTHH:MM` or `[YYYY-MM-DD HH:MM` prefixes. */
const TIMESTAMP_PATTERN = /\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g;

/** Strip `[YYYY-MM-DDTHH:MM:SS]` prefixes from history content. */
export function stripTimestamps(text: string): string {
  return text.replace(TIMESTAMP_PATTERN, "").trim();
}

/**
 * Normalize Unicode punctuation that TTS engines commonly mispronounce.
 * MiniMax and similar engines read `—` and `–` as weird verbal noise (one
 * user heard "times and times") because they don't know what to do with
 * the dash characters. Replace them with commas so they become natural
 * spoken pauses. Also collapses ellipses and strips pure decorative marks.
 *
 * Markdown emphasis characters (`*italic*`, `**bold**`, `_italic_`) are
 * stripped — most TTS engines (MiniMax, OpenAI TTS, ElevenLabs, Kokoro,
 * Chatterbox) read `*` as "times" or "asterisk" rather than parsing it as
 * vocal emphasis. The standard for TTS prosody control is SSML
 * (`<emphasis>`, `<prosody>`), not markdown. If a future provider ships
 * real markdown emphasis support, make this provider-aware instead of
 * stripping unconditionally.
 */
const PUNCTUATION_REPLACEMENTS: Array<[RegExp, string]> = [
  // Strip markdown emphasis. Order matters: bold (** and __) before italic
  // (* and _) so the doubled markers don't get half-stripped. First non-space
  // char inside must not be `*`/`_` — that rules out bullets (`* item`) and
  // multiplication (`2 * 3`) while still catching emphasis wraps.
  [
    new RegExp("\\*\\*([^*\\s][^*]*?)\\*\\*", "g"),
    "$1",
  ], // asterisk-bold
  [
    new RegExp("(?<!\\w)_([^_\\s][^_]*?)_(?!\\w)", "g"),
    "$1",
  ], // underscore-italic (word-boundary guarded)
  [
    new RegExp("\\*([^*\\s][^*]*?)\\*", "g"),
    "$1",
  ], // asterisk-italic or action markers
  // Punctuation normalization
  [/—/g, ","], // em-dash to comma pause
  [/–/g, ","], // en-dash to comma pause
  [/…/g, ","], // ellipsis to comma pause
  [/×/g, "times"], // multiplication sign to the word times
  // Stray Voice Chat prefix from LLM parroting - the global snowball-strip
  // in EntityTurn handles most cases, but this catches any that slip through
  [new RegExp("\\[\\s*Voice Chat\\s*\\]\\s*", "gi"), ""],
  [new RegExp("^\\s*Voice Chat\\s*[:—–\\-]?\\s*", "gi"), ""],
];

export function normalizePunctuationForSpeech(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PUNCTUATION_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Matches `<t>...</t>` Psycheros timestamp tags (single-line, greedy). */
const TTAG_PATTERN = /<t>[^<]*<\/t>/g;

/** Strip Psycheros `<t>Day YYYY-MM-DD HH:MM</t>` tags from LLM output. */
export function stripTTag(text: string): string {
  return text.replace(TTAG_PATTERN, "");
}
