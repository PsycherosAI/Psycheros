/**
 * Motion-Vision organ — Processing, fast path.
 *
 * The cheap local detector that decides whether the expensive specialist (VLM)
 * needs to run at all. I compare two consecutive grayscale thumbnails and
 * return a [0..1] motion score: the fraction of pixels whose intensity
 * changed by more than a noise threshold. This is the reflex arc — most
 * captured frames produce a low score here and never reach the VLM, which is
 * where the resource savings live.
 *
 * The grayscale thumbnail is derived from the captured JPEG by
 * `jpegToGrayscale` (decode + subsample) — single-representation capture keeps
 * the stream path simple (MJPEG in, JPEGs out), and the decode cost (~30–45ms
 * for 640×480) is well inside the per-frame budget at 3 fps.
 *
 * Score semantics (what the thresholds in the Sensory Organ config mean):
 * - ~0.02 (2% of pixels changed): something small moved — normal VLM pass fires.
 * - ~0.5  (half the frame changed): dramatic, sudden change — immediate
 *   high-amplitude escalation, bypassing the processing cadence.
 *
 * Mean-absolute-difference was considered as the metric, but it doesn't map
 * cleanly onto "fraction of the frame that moved" — a few bright pixels
 * flipping would inflate the mean disproportionately. Fraction-of-changed-pixels
 * maps directly to the escalation thresholds and ignores sensor noise.
 */

import { decode } from "jpeg-js";

/** Grayscale thumbnail dimensions — what `jpegToGrayscale` produces by default. */
export const GRAY_W = 32;
export const GRAY_H = 24;

/** A pixel counts as "changed" if its intensity differs by more than this. */
const PIXEL_CHANGE_THRESHOLD = 25; // out of 255 — ignores sensor noise

/**
 * Compute the motion score between two grayscale thumbnails.
 *
 * @param curr The current frame's grayscale thumbnail.
 * @param prev The previous frame's grayscale thumbnail.
 * @returns Fraction of pixels that changed (0 if lengths mismatch or empty) —
 *          the caller treats 0 as "no motion signal."
 */
export function computeMotionScore(
  curr: Uint8Array,
  prev: Uint8Array,
): number {
  const len = curr.length;
  if (len === 0 || prev.length !== len) return 0;

  let changed = 0;
  for (let i = 0; i < len; i++) {
    const diff = curr[i] - prev[i];
    // Absolute value without branching — cheap on hot loops.
    const abs = diff < 0 ? -diff : diff;
    if (abs > PIXEL_CHANGE_THRESHOLD) changed++;
  }

  return changed / len;
}

/**
 * Derive a small grayscale thumbnail from a JPEG by decoding it and subsampling.
 * One center pixel per target cell, converted to luma (ITU-R BT.601). This is
 * fast (768 pixel reads for 32×24) and good enough for gross-motion detection —
 * aliasing from subsampling doesn't matter at this granularity.
 *
 * @param jpeg The JPEG bytes (from `captureFrame` or `FrameStream.nextFrame`).
 * @param w Target thumbnail width (default 32).
 * @param h Target thumbnail height (default 24).
 */
export function jpegToGrayscale(
  jpeg: Uint8Array,
  w = GRAY_W,
  h = GRAY_H,
): Uint8Array {
  const out = new Uint8Array(w * h);
  let decoded;
  try {
    decoded = decode(jpeg);
  } catch {
    // An undecodable frame is no signal, not a crash — read as flat gray
    // (zero motion against any previous frame; the gate stays quiet).
    out.fill(128);
    return out;
  }
  const { width: iw, height: ih, data } = decoded;
  let oi = 0;
  for (let oy = 0; oy < h; oy++) {
    const y = Math.floor((oy + 0.5) * ih / h);
    for (let ox = 0; ox < w; ox++) {
      const x = Math.floor((ox + 0.5) * iw / w);
      const i = (y * iw + x) * 4; // RGBA stride
      // Luma: 0.299R + 0.587G + 0.114B (ignore alpha).
      out[oi++] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return out;
}
