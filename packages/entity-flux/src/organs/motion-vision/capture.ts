/**
 * Motion-Vision organ — Perception layer.
 *
 * Two entry points:
 *
 * - `FrameStream` — a persistent ffmpeg process that continuously captures and
 *   streams MJPEG frames to stdout. **This is the production path.** One spawn
 *   for the Sensory Organ's whole lifetime; the per-frame webcam-handshake cost (the
 *   ~1.6s we measured on spawn-per-frame) is paid once instead of N times.
 *   The capture loop reads JPEG frames as they arrive.
 *
 * - `captureFrame` — a one-shot single-frame capture for `tick()` and tests.
 *   Spawns ffmpeg, grabs one JPEG, exits. Simpler but slow per call; not for
 *   the hot loop.
 *
 * Both paths return JPEG bytes only — the grayscale thumbnail for the motion
 * gate is derived in `motion-gate.ts` by decoding the JPEG, so capture no
 * longer needs ffmpeg's dual-output filter.
 *
 * Frames are transient: temp file (one-shot path) → bytes → `Deno.remove`.
 * Never persisted (privacy: capture, process, discard).
 */

import { decode as jpegDecode, encode as jpegEncode } from "jpeg-js";

/** Default capture dimensions — plenty for the VLM (which downsamples internally) and small enough for cheap decode. */
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;

// =============================================================================
// One-shot capture (tick / tests)
// =============================================================================

/**
 * Capture one JPEG frame from the webcam. Spawns ffmpeg, grabs a single frame
 * to a temp file, reads it, deletes the temp file. Throws on any failure
 * (missing ffmpeg, device gone, timeout).
 *
 * Use this for one-offs (`tick()`); use `FrameStream` for the continuous
 * capture loop — re-spawning ffmpeg per frame is wasteful (webcam handshake
 * dominates the cost).
 */
export async function captureFrame(
  device: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  const path = await Deno.makeTempFile({ prefix: "mv-jpeg-", suffix: ".jpg" });
  try {
    await runFfmpeg(
      [
        "-y",
        "-f",
        "video4linux2",
        "-i",
        device,
        "-vf",
        `scale=${DEFAULT_WIDTH}:${DEFAULT_HEIGHT}`,
        "-frames:v",
        "1",
        "-update",
        "1",
        "-q:v",
        "2",
        path,
      ],
      timeoutMs,
    );
    return await Deno.readFile(path);
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

// =============================================================================
// Persistent FrameStream — production capture path
// =============================================================================

/**
 * A persistent ffmpeg process that streams MJPEG frames to stdout. Spawn once
 * in `start()`, read frames via `nextFrame()` for the lifetime of the Sensory Organ,
 * kill in `stop()`. Avoids the per-frame spawn cost that bounded the
 * spawn-per-frame approach to ~0.6 fps; this delivers the configured rate
 * (default 3 fps) limited only by the webcam.
 *
 * MJPEG over stdout is a concatenated byte stream of JPEG images, each framed
 * by the SOI marker `FF D8` and EOI marker `FF D9`. `nextFrame()` accumulates
 * chunks until it has a complete JPEG, then returns it — robust to frames
 * split across reads and to multiple frames arriving in one read.
 */
/**
 * A source of JPEG frames for the capture loop — browser
 * eyes included: the server-camera FrameStream (ffmpeg on a local device) or
 * the browser frame source (JPEGs pushed over the host seam from a
 * connected app's camera). Pixels are pixels; everything downstream is
 * source-agnostic.
 */
export interface FrameSource {
  start(): void;
  stop(): void;
  /** Next JPEG, or null on timeout. Server sources treat null as
   * stream-death (respawn); browser sources treat it as "no fresh
   * frame yet" (the app may be backgrounded). */
  nextFrame(timeoutMs: number): Promise<Uint8Array | null>;
}

/**
 * Browser-sourced frames: the host pushes JPEGs as the app's camera
 * produces them; the capture loop awaits the next UNCONSUMED frame.
 * Only the latest pushed frame is kept — a slow consumer skips frames,
 * which is correct for presence/motion (freshness beats completeness).
 */
export class BrowserFrameSource implements FrameSource {
  private latest: Uint8Array | null = null;
  private consumedAt = 0;
  private pushedAt = 0;
  private waiters: Array<() => void> = [];
  private started = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
    this.latest = null;
    this.wake();
  }

  /** Host seam: one JPEG from the app's camera. */
  push(jpeg: Uint8Array): void {
    if (!this.started) return;
    this.latest = jpeg;
    this.pushedAt = Date.now();
    this.wake();
  }

  async nextFrame(timeoutMs: number): Promise<Uint8Array | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.latest && this.pushedAt > this.consumedAt) {
        const frame = this.latest;
        this.consumedAt = this.pushedAt;
        return frame;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !this.started) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== wake);
          resolve();
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(wake);
      });
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

export class FrameStream implements FrameSource {
  private child: Deno.ChildProcess | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** Bytes carried between reads (a JPEG may span chunk boundaries). */
  private carry: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly device: string,
    private readonly fps: number,
    private readonly width = DEFAULT_WIDTH,
    private readonly height = DEFAULT_HEIGHT,
  ) {}

  /** Spawn ffmpeg and begin streaming. Throws on spawn failure. */
  start(): void {
    if (this.child) return;
    const cmd = new Deno.Command("ffmpeg", {
      args: [
        "-y",
        "-f",
        "video4linux2",
        "-i",
        this.device,
        "-vf",
        `scale=${this.width}:${this.height},fps=${this.fps}`,
        "-f",
        "mjpeg",
        "-", // stream to stdout
      ],
      stdout: "piped",
      stderr: "null", // discard diagnostics; we don't need them in the hot loop
    });
    this.child = cmd.spawn();
    this.reader = this.child.stdout.getReader();
  }

  /**
   * Read the next complete JPEG frame from the stream.
   * @returns The JPEG bytes, or null on EOF (ffmpeg exited) or timeout.
   */
  async nextFrame(timeoutMs: number): Promise<Uint8Array | null> {
    if (!this.reader) return null;
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        // Try to extract a complete JPEG from bytes already in the carry.
        const extracted = extractNextJpeg(this.carry);
        if (extracted.frame) {
          this.carry = extracted.remaining;
          return extracted.frame;
        }
        // Need more bytes. Race the read against the timeout so a dead
        // stream doesn't hang the capture loop forever.
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return null;
        const result = await Promise.race([
          this.reader.read(),
          new Promise<{ done: true }>((resolve) =>
            setTimeout(() => resolve({ done: true }), remainingMs)
          ),
        ]);
        if ("done" in result && result.done) return null; // EOF or timeout
        const { done, value } = result as { done: boolean; value?: Uint8Array };
        if (done) return null;
        if (value && value.length) {
          this.carry = concat(this.carry, value);
        }
      }
    } catch (error) {
      console.error(
        `[motion-vision] FrameStream read failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Kill ffmpeg and release the reader. Safe to call multiple times. */
  stop(): void {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // already gone
    }
    this.child = null;
    this.reader = null;
    this.carry = new Uint8Array(0);
  }
}

// =============================================================================
// MJPEG parsing helpers
// =============================================================================

const SOI = 0xFFD8; // Start Of Image
const EOI = 0xFFD9; // End Of Image

/** Read a big-endian u16 from a Uint8Array at offset (or -1 if out of range). */
function readU16(buf: Uint8Array, i: number): number {
  if (i + 1 >= buf.length) return -1;
  return (buf[i] << 8) | buf[i + 1];
}

/**
 * Extract the first complete JPEG (FFD8…FFD9) from `buf`. Returns the frame
 * bytes plus the remaining bytes (everything after the EOI). If no complete
 * frame is present, `{ frame: null, remaining: buf }` — caller should feed
 * more bytes and retry.
 */
function extractNextJpeg(
  buf: Uint8Array,
): { frame: Uint8Array | null; remaining: Uint8Array } {
  // Find SOI.
  let start = -1;
  for (let i = 0; i < buf.length - 1; i++) {
    if (readU16(buf, i) === SOI) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    // No SOI at all — discard everything (it's not JPEG data).
    return { frame: null, remaining: new Uint8Array(0) };
  }
  // Find EOI after the SOI.
  for (let i = start + 2; i < buf.length - 1; i++) {
    if (readU16(buf, i) === EOI) {
      const end = i + 2; // include EOI bytes
      const frame = buf.slice(start, end);
      const remaining = buf.slice(end);
      return { frame, remaining };
    }
  }
  // SOI found but EOI not yet — need more bytes. Keep from the SOI onward.
  return { frame: null, remaining: buf.slice(start) };
}

/** Concatenate two Uint8Arrays. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// =============================================================================
// ffmpeg runner (one-shot path)
// =============================================================================

/**
 * Run ffmpeg with a hard timeout. Mirrors the AbortController pattern from
 * `packages/psycheros/src/tools/shell.ts:79-99`. Throws on non-zero exit,
 * timeout, or spawn failure (with stderr in the message when available).
 */
async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  const cmd = new Deno.Command("ffmpeg", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const child = cmd.spawn();
    const result = await Promise.race([
      child.output(),
      new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () => {
          child.kill("SIGTERM");
          reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
        });
      }),
    ]);

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr).trim();
      throw new Error(stderr || `ffmpeg exited with code ${result.code}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// AudioStream — persistent mic tap, rolling window (audio captioning)
// =============================================================================

/** PCM chunk with the timestamp of when it was captured (ms since epoch). */
interface AudioChunk {
  at: number;
  bytes: Uint8Array;
}

/**
 * A persistent ffmpeg process that streams raw PCM audio from a capture
 * device to stdout, kept as a rolling window for caption bursts. The same
 * lifetime pattern as FrameStream: spawn once in `start()`, snapshot
 * windows via `snapshotWav()`, kill in `stop()`.
 *
 * The snapshot wraps the windowed PCM in a WAV header so it can ride into
 * the captioner as an `input_audio` block (base64 wav) — the model hears
 * the same moments the frames show. Rolling buffer, never persisted.
 */
export class AudioStream {
  private child: Deno.ChildProcess | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** Rolling PCM window (oldest first), trimmed to `windowMs`. */
  private window: AudioChunk[] = [];

  constructor(
    /** ALSA device (e.g. "default", "hw:2,0") — settings-provided. */
    private readonly device: string,
    /** How much audio to keep, matching the frame burst window. */
    private readonly windowMs: number,
    private readonly sampleRate = 16_000,
  ) {}

  /** Spawn ffmpeg (ALSA → 16kHz mono s16le PCM on stdout). Throws on spawn
   * failure; the Sensory Organ treats audio as optional and continues without. */
  start(): void {
    if (this.child) return;
    const cmd = new Deno.Command("ffmpeg", {
      args: [
        "-y",
        "-f",
        "alsa",
        "-i",
        this.device,
        "-ar",
        String(this.sampleRate),
        "-ac",
        "1",
        "-f",
        "s16le",
        "-loglevel",
        "quiet",
        "-",
      ],
      stdout: "piped",
      stderr: "null",
    });
    this.child = cmd.spawn();
    this.reader = this.child.stdout.getReader();
    void this.drain();
  }

  /** Background drain: read PCM chunks into the rolling window forever.
   * Failures end the drain quietly — snapshots simply stop updating; the
   * organ's audio degrades to stale/empty rather than crashing capture. */
  private async drain(): Promise<void> {
    if (!this.reader) return;
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done || !value || value.length === 0) break;
        this.window.push({ at: Date.now(), bytes: value });
        this.trim();
      }
    } catch {
      // stream ended or process killed — nothing to do; stop() owns cleanup
    }
  }

  /** Drop chunks older than the window (keeping at least the newest). */
  private trim(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.window.length > 1 && this.window[0].at < cutoff) {
      this.window.shift();
    }
  }

  /**
   * Snapshot the current window as WAV bytes (header + PCM), or null when
   * no audio has arrived (mic absent/silent start) — the caller captions
   * frames-only in that case, same as audio-off.
   */
  snapshotWav(): Uint8Array | null {
    if (this.window.length === 0) return null;
    const total = this.window.reduce((n, c) => n + c.bytes.length, 0);
    if (total === 0) return null;
    const pcm = new Uint8Array(total);
    let off = 0;
    for (const c of this.window) {
      pcm.set(c.bytes, off);
      off += c.bytes.length;
    }
    return wavFromPcm(pcm, this.sampleRate);
  }

  stop(): void {
    this.child?.kill("SIGINT");
    this.child = null;
    this.reader = null;
    this.window = [];
  }
}

/**
 * Wrap raw s16le mono PCM in a WAV header (44 bytes, RIFF little-endian).
 * Standalone so tests can verify the format without an audio device.
 */
export function wavFromPcm(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataLen = pcm.length;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true); // PCM chunk size
  dv.setUint16(20, 1, true); // PCM format
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate (s16 mono)
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  dv.setUint32(40, dataLen, true);
  buf.set(pcm, 44);
  return buf;
}

// =============================================================================
// In-process downscale — the adaptive-burst lever
// =============================================================================

/**
 * Downscale a JPEG in-process (decode → box-average resize → encode, via
 * jpeg-js both ways). The adaptive-burst mechanism: frames are ALWAYS
 * captured at the fat resolution (the buffer never changes), and a LEAN
 * caption pass downscales the burst before packaging — image tokens ∝
 * pixels, so a lean burst costs proportionally less while every frame
 * stays in the payload (frame COUNT is never reduced; size only).
 *
 * Box averaging (not nearest) because VLM input tolerates soft edges far
 * better than aliasing artifacts. ~50ms per frame at 640×480 → 480×360;
 * only lean passes pay it.
 */
export function downscaleJpeg(
  jpeg: Uint8Array,
  targetW: number,
  targetH: number,
): Uint8Array {
  let src: ReturnType<typeof jpegDecode>;
  try {
    src = jpegDecode(jpeg);
  } catch {
    // An undecodable frame passes through untouched — downscaling is an
    // optimization, never a reason to drop or corrupt a frame.
    return jpeg;
  }
  const sw = src.width;
  const sh = src.height;
  if (sw === targetW && sh === targetH) return jpeg; // nothing to do

  const out = new Uint8Array(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    const sy0 = Math.floor((y * sh) / targetH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * sh) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx0 = Math.floor((x * sw) / targetW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * sw) / targetW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < sh; sy++) {
        for (let sx = sx0; sx < sx1 && sx < sw; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          n++;
        }
      }
      const o = (y * targetW + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  const encoded = jpegEncode(
    { data: out, width: targetW, height: targetH },
    80, // quality — VLM input, not archival
  );
  return encoded.data;
}
