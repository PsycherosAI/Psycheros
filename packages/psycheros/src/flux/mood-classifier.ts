/**
 * Mood classifier — the Mood Organ's in-process specialist (v2).
 *
 * Wraps the vad-bert regression model (RobroKools/vad-bert — BERT-base
 * fine-tuned on EmoBank for valence/arousal/dominance) through the same
 * transformers.js lane the embedder uses: no server, no ChatFn,
 * deterministic, ~10ms per text. The v1 GoEmotions + mood-table pair
 * reads single-utterance register, not situation — "they're getting
 * closer" scores 91% neutral during a narrated emergency — while
 * vad-bert reads the same corpus with well-distributed valence
 * (story negatives −0.3…−0.9, controls +1.0 / +0.25 / −1.0). The
 * connection axis is temporarily dropped — no dataset annotates it,
 * and re-sourcing it behaviorally is pinned for a future arc.
 *
 * Model home: BUNDLED — `packages/psycheros/lib/models/vad-bert/`,
 * resolved module-relative like the vec0 extension (no HuggingFace
 * hosting, no remote-fetch cache; a fresh clone is a provisioned
 * install). The file is INT8 dynamic-quantized (110MB vs 438MB fp32,
 * 2-2.6x faster on CPU, drift ~0.02 organ-delta — an order of
 * magnitude under the calibration's own error bars). fp16 is NOT
 * viable: onnxruntime's CPU executor rejects converted graphs
 * (mixed float16/float bindings in attention ops). The runtime always
 * loads `onnx/model.onnx` regardless of quantized flags — the
 * quantized artifact is named accordingly.
 *
 * Output scale: the model emits EmoBank-ish 1–5 floats per axis,
 * calibrated by REGRESSION against the NRC-VAD lexicon (67-word
 * battery spanning each axis, fitted nrc = slope·model + icept,
 * then mapped NRC 0–1 → ±0.4 the old table's documented transform —
 * gain = 0.8·slope, mid = (0.4 − 0.8·icept)/gain). Fits: valence
 * 0.473/−0.906 (r=0.89), arousal 0.484/−0.980 (r=0.63), dominance
 * 0.578/−1.267 (r=0.55). The arousal/dominance axes are structurally
 * compressed in the model (usable band ~1.2 vs valence's ~2.3) — the
 * fitted gains stretch them (+29% / +54% vs the hand-measured 0.3).
 * Honest caveat: dominance correlates weakly with human norms (r=0.55,
 * EmoBank's noisiest axis) — stretched signal is still weak signal; a
 * better-trained regressor is the long-term fix.
 *
 * Failure is null (the runner falls back to the worker-LLM PoC), never
 * a throw — a missing model directory degrades to the LLM read.
 */

import { dirname, fromFileUrl, join } from "@std/path";

/** The provisioning variant (settings-shaped; int8 is the default). */
export type MoodModelVariant = "int8" | "fp32";
import type { ClassifyMoodFn } from "../../../entity-flux/src/mod.ts";

/** Per-axis mids and gains from the NRC-VAD regression (see header):
 * [valence, arousal, dominance]. */
const AXIS_MID = [2.97, 3.06, 3.06] as const;
const AXIS_GAIN = [0.378, 0.387, 0.462] as const;

/** Per-read delta cap (v1 parity). */
const DELTA_CAP = 0.4;

/** Loaded model state — populated lazily, once per process. */
let loaded: {
  tokenize: (
    text: string,
    options?: { truncation?: boolean; max_length?: number },
  ) => Promise<
    { input_ids: unknown; attention_mask: unknown; token_type_ids?: unknown }
  >;
  run: (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;
} | null = null;

/** True once a load attempt failed — don't retry per classification. */
let loadFailed = false;

async function loadModel(
  dataRoot: string,
  variant: MoodModelVariant = "int8",
) {
  if (loaded) return loaded;
  if (loadFailed) return null;
  // deno-lint-ignore no-explicit-any
  const transformers = await import("@xenova/transformers") as any;
  const { AutoTokenizer, AutoModel, env } = transformers;
  // Disk-only, never remote: the vec0 discipline applied to a model.
  env.allowRemoteModels = false;
  env.useBrowserCache = false;

  // Resolution order: the DOWNLOADED
  // per-variant directory in the data root first (the provisioning
  // path, users pick the quant), then the source-tree lib/models
  // bundle if present (dev trees; fresh clones have neither), then
  // the worker-LLM fallback.
  const candidates: Array<{ root: string; id: string; label: string }> = [
    {
      root: join(dataRoot, ".psycheros", "model-cache"),
      id: `vad-bert-${variant}`,
      label: `model-cache vad-bert-${variant}`,
    },
    {
      root: join(
        dirname(fromFileUrl(import.meta.url)),
        "..",
        "..",
        "lib",
        "models",
      ),
      id: "vad-bert",
      label: "bundled lib/models/vad-bert",
    },
  ];
  for (const c of candidates) {
    try {
      env.localModelPath = c.root;
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(c.id),
        AutoModel.from_pretrained(c.id),
      ]);
      loaded = {
        // deno-lint-ignore no-explicit-any
        tokenize: async (text: string) => await tokenizer(text) as any,
        // deno-lint-ignore no-explicit-any
        run: async (inputs: unknown) => await model(inputs) as any,
      };
      console.log(
        `[Flux] Mood classifier loaded (vad-bert, ${c.label})`,
      );
      return loaded;
    } catch {
      // This candidate is absent — try the next.
    }
  }
  loadFailed = true;
  console.warn(
    `[Flux] Mood classifier unavailable (no model on disk; ${variant} not downloaded and no bundle) — mood classification falls back to the worker LLM`,
  );
  return null;
}

/** Reset the load cache — called when the variant setting changes, so
 * the next classification loads the newly chosen quant. */
export function resetMoodClassifierCache(): void {
  loaded = null;
  loadFailed = false;
}

/**
 * Build the ClassifyMoodFn for the flux host config. Returns null
 * deltas on empty text or unloadable model — the runner treats null as
 * "skip the modifier" or falls back to the LLM PoC.
 */
export function makeMoodClassifier(
  dataRoot: string,
  variant: MoodModelVariant = "int8",
): ClassifyMoodFn {
  return async (text: string) => {
    if (!text.trim()) return null;
    const model = await loadModel(dataRoot, variant);
    if (!model) return null;

    // Truncation guard: BERT's window is 512 positions. Long entity
    // replies exceed it; transformers.js does NOT truncate by default.
    const inputs = await model.tokenize(text, {
      truncation: true,
      max_length: 512,
    });
    const output = await model.run(inputs);
    const [v, a, d] = Array.from(output.logits.data as ArrayLike<number>);
    const cal = (x: number, i: number) =>
      Math.max(
        -DELTA_CAP,
        Math.min(DELTA_CAP, (x - AXIS_MID[i]) * AXIS_GAIN[i]),
      );
    return {
      valence: cal(v, 0),
      arousal: cal(a, 1),
      dominance: cal(d, 2),
    };
  };
}
