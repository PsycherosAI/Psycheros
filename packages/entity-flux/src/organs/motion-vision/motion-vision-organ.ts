/**
 * Motion-Vision organ — the Organ implementation.
 *
 * Wires the three parts (Perception / Processing / Response) into a
 * self-driving Sensory Organ: FluxManager
 * calls `start()`/`stop()`, the Sensory Organ runs its own internal loops and pushes
 * envelopes through the sink. `tick()` is NOT polled by the manager — it's
 * kept for interface compliance and as a one-shot test entry point.
 *
 * Two internal loops, decoupled:
 *
 * - **Capture loop** (`captureFps`, default 3): grabs a frame, runs the motion
 *   gate, feeds the buffer. Runs as an async while-loop with an inter-frame
 *   delay (NOT `setInterval`) so a slow capture can't stack overlapping calls.
 * - **Max-quiet timer** (`maxQuietMs`, default 5 min): forces a fresh VLM pass
 *   during sustained quiet so the caption file stays reasonably current.
 *
 * Processing is **event-driven**, not cadence-bound: motion above threshold
 * triggers a VLM pass immediately (not on a fixed 2s tick). A motion spike
 * bypasses the cadence gate entirely (immediate escalation path). A
 * one-in-flight guard + a minimum-emit gap (`tickIntervalMs`) prevent the VLM
 * from being called too frequently when motion is continuous.
 *
 * The caption file (presence) is updated on every successful VLM pass —
 * independent of whether an envelope is emitted (habituation may suppress
 * emits, but never suppresses the state file).
 */

import type { SensoryOrgan } from "../../types.ts";
import type { EnvelopeSink } from "../../types.ts";
import {
  AudioStream,
  BrowserFrameSource,
  captureFrame,
  downscaleJpeg,
  type FrameSource,
  FrameStream,
} from "./capture.ts";
import { computeMotionScore, jpegToGrayscale } from "./motion-gate.ts";
import {
  createVisionProvider,
  type SceneIdentity,
  type VisionModelProvider,
} from "./scene-describer.ts";
import {
  amplitudeForMotion,
  buildCaption,
  buildEnvelope,
  habituationFactor,
  readStateFile,
  writeStateFile,
} from "./response.ts";
import { HttpPerceptionClient } from "./perception-client.ts";
import {
  freshPresence,
  type PresenceConfig,
  type PresenceSnapshot,
  restorePresence,
  stepPresence,
} from "./presence.ts";
import {
  buildScenePromptPrefix,
  freshSceneBaseline,
  restoreSceneBaseline,
  type SceneBaselineConfig,
  type SceneBaselineState,
  stepSceneBaseline,
} from "./scene-baseline.ts";
import type {
  MotionVisionContext,
  MotionVisionFrame,
  MotionVisionOrganConfig,
  PerceptionClient,
  PerceptionResult,
  PresenceStateFile,
  SceneResult,
} from "./types.ts";
import { defaultMotionVisionConfig } from "./types.ts";
import type { OrganEnvelope } from "../../types.ts";

/** ffmpeg capture timeout — generous; most captures finish in under a second. */
const CAPTURE_TIMEOUT_MS = 10_000;

/** Below this amplitude, skip the envelope emit (habituated to near-zero). */
const EMIT_FLOOR = 0.05;

/**
 * Amplitude factor from a scene-baseline step. Transitions carry full
 * amplitude (a new stage IS the news); everything else scales by surprise —
 * contrast-normalized novelty: ~0.3 at the room's usual level of surprise,
 * climbing toward 1.0 as a caption towers over the recent noise floor,
 * sinking toward the 0.15 floor when the stage just keeps confirming
 * itself. Clamped so no caption can be fully silenced by the baseline —
 * the emit floor and the max-quiet refresh keep captions flowing.
 */
export function sceneFactor(kind: string, surprise: number): number {
  if (kind === "established" || kind === "recognized") return 1.0;
  return Math.max(0.15, Math.min(1, 0.3 + 0.15 * surprise));
}

/**
 * Blend scene novelty into an envelope's amplitude — with the reflex
 * preserve: a base at/above the escalation threshold (the motion-spike
 * jump to 0.9) passes through UNTOUCHED. The ≥0.7 reflex line carries the
 * event-exempt wake path (the sneeze guarantee: an event is novel by
 * definition and must never be quieted by stage familiarity). The blend
 * only quiets non-reflex passes.
 */
export function blendAmplitude(
  base: number,
  kind: string,
  surprise: number,
  escalationThreshold: number,
): number {
  if (base >= escalationThreshold) return base;
  return base * sceneFactor(kind, surprise);
}

/**
 * The motion-vision organ. Captures webcam frames, detects motion, runs a VLM
 * on bursts, emits scene envelopes, and publishes a caption state file.
 */
export class MotionVisionOrgan implements SensoryOrgan {
  readonly config: MotionVisionOrganConfig;

  private readonly sink: EnvelopeSink;
  private readonly context: MotionVisionContext;

  /** Rolling frame buffer covering `burstWindowMs`. */
  private buffer: MotionVisionFrame[] = [];
  /** Previous frame's grayscale thumbnail, for motion diff. */
  private prevGray: Uint8Array | null = null;
  /** Most recent motion score (for amplitude + state file). */
  private lastMotionScore = 0;
  /** When a frame last ARRIVED (ms epoch) — the freshness input for
   *  camera-path blindness (null before the first frame). */
  private lastFrameAt: number | null = null;
  /** True while blind — logs the transition once, not every check. */
  private blindAnnounced = false;
  /** Last VLM description (for habituation comparison). */
  private lastDescription: string | null = null;
  /** Active modulation directive (set via receiveDirective; the
   * Thalamus's down-chain). Takes precedence over the context seam. */
  private directive: string | null = null;
  /** Rolling habituation factor (resets to 1 on scene change). */
  private habituationPrev = 1.0;

  /** One-in-flight guard for the VLM pass. */
  private processingInFlight = false;
  /** A spike arrived during processing — re-trigger immediately after. */
  private pendingSpike = false;
  /** Timestamp of the last completed VLM pass (for the cadence gate). */
  private lastProcessAt = 0;
  /** Resolution profile of the in-flight/last VLM pass — "lean" (routine,
   * downscaled frames) or "fat" (motion-spike reflex, full capture size).
   * Rides into the envelope data for forensics: caption quality questions
   * ("could it read that?") answer differently per profile. */
  private lastBurstProfile: "lean" | "fat" = "lean";

  /** Capture-loop control flag. */
  private captureRunning = false;
  /** Persistent ffmpeg stream — one spawn for the Sensory Organ's lifetime. */
  private frameStream: FrameSource | null = null;
  /** The browser-source instance when source="browser" (the push target). */
  private browserSource: BrowserFrameSource | null = null;
  /** Optional parallel mic tap (audio captioning) — rolling WAV window. */
  private audioStream: AudioStream | null = null;
  /** Max-quiet refresh timer id (null when stopped). */
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  /** The VLM runtime — constructed once from config, swappable via settings. */
  private readonly provider: VisionModelProvider;
  /** Classical perception (bodies + faces), or null when disabled. */
  private readonly perceptionClient: PerceptionClient | null;
  /** Presence machines' state (occupancy + identity visibility). */
  private presence: PresenceSnapshot | null = null;
  /** Presence config derived from the Sensory Organ config. */
  private readonly presenceConfig: PresenceConfig;
  /** Most recent perception result — feeds the scene prompt's identity facts. */
  private lastPerceived: (PerceptionResult & { at: number }) | null = null;
  /** One-in-flight guard for the perception call (fire-and-forget from gate). */
  private perceptionInFlight = false;
  /** Occupancy state at last state-file persist (change detection). */
  private lastPersistedOccupancy: number | null = null;

  /** The host's shared embedder — same singleton the whole system uses. */
  private readonly embed: ((text: string) => Promise<number[]>) | null;
  /** Scene baseline state (the stage ring); null when disabled. */
  private scene: SceneBaselineState | null = null;
  /** Scene-baseline config (module defaults). */
  private readonly sceneConfig: SceneBaselineConfig = {
    recognizeThreshold: 0.8,
    settleMs: 8_000,
    ringSize: 5,
    updateRate: 0.15,
    summaryCapChars: 280,
  };
  /** The stage text to inject into the NEXT captioner call (delta mode). */
  private scenePrefix: string | null = null;
  /** Last step result's kind + surprise — amplitude blending. */
  private lastSceneKind: string | null = null;
  private lastSceneSurprise: number | null = null;
  /** When a CONFORMING-caption envelope last emitted (familiar-scene
   * throttle — texture cadence, not event cadence). */
  private lastFamiliarEmitAt = 0;

  constructor(
    config: Partial<MotionVisionOrganConfig> = {},
    sink: EnvelopeSink = () => {},
    context: MotionVisionContext = {},
  ) {
    this.config = { ...defaultMotionVisionConfig(), ...config };
    this.sink = sink;
    this.context = context;
    // Build the VLM runtime once — the rest of the Sensory Organ talks to the
    // VisionModelProvider interface and never knows which runtime it is.
    this.provider = createVisionProvider(
      this.config.provider,
      this.config.modelUrl,
      this.config.model,
    );
    // Classical perception: injected (tests) or built from config (runtime).
    // Disabled = today's behavior exactly — no presence, no identity facts.
    this.perceptionClient = this.config.perceptionEnabled
      ? context.perceptionClient ??
        new HttpPerceptionClient(this.config.perceptionUrl)
      : (context.perceptionClient ?? null);
    this.presenceConfig = {
      arrivalDebounceMs: this.config.arrivalDebounceMs,
      trackGraceMs: this.config.trackGraceMs,
      motionThreshold: this.config.motionThreshold,
      motionSustainMs: this.config.motionSustainMs,
    };
    // Scene baseline needs the shared embedder; without it the Sensory Organ falls
    // back to string habituation regardless of the config flag.
    this.embed = context.embed ?? null;
    if (this.config.sceneBaselineEnabled && this.embed) {
      this.scene = freshSceneBaseline();
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /** Start the capture loop + max-quiet timer. First capture fires immediately. */
  start(): void {
    if (this.captureRunning || !this.config.enabled) return;
    this.captureRunning = true;
    // Restore caption from state file if recent; else kick off an initial VLM
    // pass so the entity has visual presence from startup.
    void this.initialize();
    // Begin the capture loop (async, fire-and-forget). The loop owns the
    // FrameStream lifecycle — one persistent ffmpeg spawn for the Sensory Organ's
    // whole run, not a spawn per frame.
    void this.captureLoop();
    // Audio captioning: an optional parallel mic tap feeding the captioner
    // (input_audio blocks). Failure to spawn (no mic, bad device) is
    // logged once and captions stay frames-only — never fatal.
    if (this.config.audioCaptioningEnabled) {
      try {
        this.audioStream = new AudioStream(
          this.config.audioDevice,
          this.config.burstWindowMs,
        );
        this.audioStream.start();
        console.log(
          `[motion-vision] audio captioning on (${this.config.audioDevice})`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `[motion-vision] audio stream failed: ${msg} — captions stay frames-only`,
        );
        this.audioStream = null;
      }
    }
    // Max-quiet change check: the periodic quiet refresh never asks for a
    // description — asking a small VLM to "describe who" of a still or
    // empty room hallucinates people all through real absences. It asks
    // only same-or-changed against the previous read; the full caption
    // pass runs exactly when the scene actually diverged, which is when
    // the baseline needs a fresh sample. Motion-driven passes are
    // unaffected.
    this.quietTimer = setInterval(
      () => this.triggerQuietCheck(),
      this.config.maxQuietMs,
    );
  }

  /** Stop the capture loop + clear the max-quiet timer. Graceful: the current
   * capture (if mid-flight) finishes, then the loop exits and ffmpeg is killed.
   * The presence state flushes to the state file so the next start restores
   * instead of re-announcing. */
  stop(): void {
    this.captureRunning = false;
    this.frameStream?.stop();
    this.frameStream = null;
    this.browserSource = null;
    this.audioStream?.stop();
    this.audioStream = null;
    if (this.quietTimer !== null) {
      clearInterval(this.quietTimer);
      this.quietTimer = null;
    }
    void this.writePresenceState();
    void this.mergeSceneIntoStateFile();
  }

  /**
   * Modulation inlet (the Thalamus's down-chain): a semantic directive
   * that rides into the VLM's prompt via the Sensory Organ's getDirective seam
   * — "specifically watch for a blue Subaru" reaches the perception
   * model itself, so the SENSOR looks and Noticing stops guessing from
   * generic captions. The directive persists until replaced or cleared
   * with an empty string; TTL/expiry is the Thalamus's business, not
   * the Sensory Organ's.
   */
  receiveDirective(text: string): void {
    this.directive = text.trim() || null;
  }

  /** Control inlet: capture-rate/threshold knobs the Ego can tune. */
  applyControl(key: string, value: unknown): void {
    if (key === "motionThreshold" && typeof value === "number") {
      this.config.motionThreshold = Math.max(0, Math.min(1, value));
    } else if (key === "captureFps" && typeof value === "number") {
      this.config.captureFps = Math.max(1, Math.min(10, Math.round(value)));
    }
  }

  // ===========================================================================
  // Test seams — drive the gate directly with synthetic frames and inspect
  // presence state. Not used by the runtime; tests reach these so they don't
  // have to mock the FrameStream.
  // ===========================================================================

  /** @hidden One gated frame without the capture loop. */
  gateForTest(jpeg: Uint8Array): void {
    this.gate(jpeg);
  }

  /** @hidden Run one VLM pass over the given frames (bypasses the buffer),
   * so tests can drive caption→baseline→envelope cycles without ffmpeg.
   * `lean` selects the burst profile (default lean — the routine case). */
  async runProcessForTest(
    frames: MotionVisionFrame[],
    lean = true,
  ): Promise<OrganEnvelope | null> {
    this.buffer = [...frames];
    // The test just delivered frames — same as the capture loop, they
    // count as fresh (the blindness gate keys on this).
    this.lastFrameAt = Date.now();
    this.processingInFlight = true;
    try {
      return await this.runProcess({ lean });
    } finally {
      this.processingInFlight = false;
    }
  }

  /** @hidden Startup restore alone (no capture loop, no timer) — the part of
   * start() tests need for state-file round-trips. */
  async initializeForTest(): Promise<void> {
    await this.initialize();
  }

  /** @hidden Current presence snapshot (null when perception is disabled). */
  presenceStateForTest(): PresenceSnapshot | null {
    return this.presence;
  }

  // ===========================================================================
  // tick() — one-shot capture + maybe-process, for testability / manual triggers
  // ===========================================================================

  /**
   * Capture one frame (via a one-shot ffmpeg spawn, NOT the persistent stream),
   * run the motion gate, and if motion warrants, run one VLM pass. Returns the
   * emitted envelope (or null if nothing was emitted). Not polled by
   * FluxManager — exposed for tests and manual invocation.
   */
  async tick(): Promise<OrganEnvelope | null> {
    if (!this.config.enabled) return null;
    let jpeg: Uint8Array;
    try {
      jpeg = await captureFrame(this.config.device, CAPTURE_TIMEOUT_MS);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[motion-vision] tick capture failed: ${msg}`);
      return null;
    }
    this.gate(jpeg);
    if (this.lastMotionScore < this.config.motionThreshold) return null;
    return await this.runProcess({
      lean: this.lastMotionScore < this.config.escalationMotionThreshold,
    });
  }

  // ===========================================================================
  // Capture loop + motion gating
  // ===========================================================================

  /**
   * Async capture loop: read frames from a persistent `FrameStream`, gate each,
   * buffer it, trigger processing if warranted. The stream is (re)created on
   * demand — if it dies (webcam unplugged, ffmpeg crash), the loop backs off
   * briefly and respawns, so the Sensory Organ recovers without operator intervention.
   */
  private async captureLoop(): Promise<void> {
    while (this.captureRunning) {
      if (!this.frameStream) {
        if (this.config.source === "browser") {
          // Browser eyes: frames arrive via pushBrowserFrame
          // from the host seam. A null read is "nothing fresh yet" — the
          // app may be backgrounded — NOT stream death; keep waiting.
          this.browserSource = new BrowserFrameSource();
          this.frameStream = this.browserSource;
          this.frameStream.start();
        } else {
          this.frameStream = new FrameStream(
            this.config.device,
            this.config.captureFps,
            this.config.visionWidth,
            this.config.visionHeight,
          );
          try {
            this.frameStream.start();
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[motion-vision] FrameStream start failed: ${msg}`);
            this.frameStream = null;
            await this.sleep(1000);
            continue;
          }
        }
      }
      const jpeg = await this.frameStream!.nextFrame(CAPTURE_TIMEOUT_MS);
      if (!this.captureRunning) break;
      if (!jpeg) {
        if (this.config.source === "browser") {
          // No fresh browser frame within the window — loop and wait.
          continue;
        }
        // Server stream ended or timed out — drop it; the next iteration respawns.
        console.error("[motion-vision] FrameStream ended, restarting");
        this.frameStream.stop();
        this.frameStream = null;
        await this.sleep(500);
        continue;
      }
      this.gate(jpeg);
    }
    // Loop exited — clean up the stream.
    this.frameStream?.stop();
    this.frameStream = null;
    this.browserSource = null;
  }

  /**
   * Gate one JPEG: derive its grayscale thumbnail, compute the motion score
   * against the previous frame, buffer it, and trigger processing if motion
   * warrants. Shared by the persistent capture loop and the one-shot `tick()`.
   *
   * The perception call rides the same cadence but stays fully decoupled from
   * VLM triggering — presence tracking must observe every frame regardless of
   * motion (a sleeping person is motionless; absence detection exists exactly
   * because no-motion ≠ no-person).
   */
  /**
   * Host seam: one JPEG from a connected app's camera.
   * No-op unless this Sensory Organ runs its browser frame source.
   */
  pushBrowserFrame(jpeg: Uint8Array): void {
    if (this.browserSource) this.browserSource.push(jpeg);
  }

  private gate(jpeg: Uint8Array): void {
    this.lastFrameAt = Date.now();
    const gray = jpegToGrayscale(jpeg);
    const motionScore = this.prevGray
      ? computeMotionScore(gray, this.prevGray)
      : 0;
    this.prevGray = gray;
    this.lastMotionScore = motionScore;
    const frame = { jpeg, capturedAt: Date.now() };
    this.pushBuffer(frame);
    this.observePresence(frame, motionScore);
    this.onMotion(motionScore);
  }

  /**
   * Fire-and-forget perception over one frame, feeding the presence machines.
   * One-in-flight guarded — at the capture cadence (~3fps, ~333ms interval)
   * vs the round-trip (~35ms on TPU, up to the 2s timeout worst-case), we
   * effectively perceive every frame; a skipped frame is harmless because the
   * machines' debounces count time, not frames. Null results (sidecar down)
   * read as blindness — state freezes, never flips to "empty".
   */
  private observePresence(
    frame: MotionVisionFrame,
    motionScore: number,
  ): void {
    if (!this.perceptionClient || this.perceptionInFlight) return;
    this.perceptionInFlight = true;
    void this.perceptionClient.perceive(frame).then((result) => {
      this.perceptionInFlight = false;
      if (!this.presence) this.presence = freshPresence(frame.capturedAt);
      this.lastPerceived = result ? { ...result, at: frame.capturedAt } : null;

      const transition = stepPresence(
        this.presence,
        {
          at: frame.capturedAt,
          bodies: result?.people.boxes ?? [],
          faces: result?.faces ?? [],
          motionScore,
          recognizerOk: result !== null,
        },
        this.presenceConfig,
      );
      this.presence = transition.snapshot;
      // Forensic line: track-count flips are rare and meaningful —
      // the next dawn-light event leaves a timestamped trace.
      const liveTracks = transition.snapshot.tracks.length;
      if (liveTracks !== this.lastPersistedOccupancy) {
        console.log(
          `[motion-vision] tracks: ${liveTracks} ` +
            `(bodies=${result?.people.count ?? "?"} faces=${
              result?.faces.length ?? "?"
            } motion=${motionScore.toFixed(3)})`,
        );
      }
      for (const envelope of transition.envelopes) {
        void this.emit(envelope);
      }
      // Persist on track-count changes AND on envelope-bearing steps —
      // confirmation is envelope-bearing but count-neutral, and the slice
      // must not go stale between them.
      if (
        liveTracks !== this.lastPersistedOccupancy ||
        transition.envelopes.length > 0
      ) {
        this.lastPersistedOccupancy = liveTracks;
        void this.writePresenceState();
      }
    }).catch(() => {
      this.perceptionInFlight = false;
    });
  }

  /** Send an envelope through the sink; log, never crash. */
  private async emit(envelope: OrganEnvelope): Promise<void> {
    try {
      await this.sink(envelope);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[motion-vision] sink rejected envelope: ${msg}`);
    }
  }

  /** Build the presence + perception slices from CURRENT memory — the one
   * source both state-file writers use, so a racing read-modify-write can
   * never resurrect a stale slice. */
  private presenceSlices():
    | {
      presence: PresenceStateFile;
      perception: { available: boolean; lastOkAt?: string };
    }
    | null {
    if (!this.presence) return null;
    const snap = this.presence;
    const confirmed = snap.tracks.filter((t) => t.confirmedAt !== null);
    const named = confirmed.find((t) => t.identity);
    return {
      presence: {
        state: confirmed.length > 0 ? "occupied" : "empty",
        peopleCount: confirmed.length > 0 ? confirmed.length : undefined,
        identity: named?.identity?.id ?? null,
        identityConfidence: named?.identity?.confidence ?? null,
        since: named ? new Date(named.bornAt).toISOString() : undefined,
        lastSeenAt: named?.identity
          ? new Date(named.identity.at).toISOString()
          : undefined,
        tracks: snap.tracks.map((t) => ({
          tid: t.tid,
          identity: t.identity?.id ?? null,
          bornAt: new Date(t.bornAt).toISOString(),
        })),
      },
      perception: {
        available: this.lastPerceived !== null,
        ...(this.lastPerceived
          ? { lastOkAt: new Date(this.lastPerceived.at).toISOString() }
          : {}),
      },
    };
  }

  /**
   * Persist the presence slice of the state file (merged over whatever the
   * caption writer last left). Called on presence transitions and on stop().
   */
  private async writePresenceState(): Promise<void> {
    if (!this.context.dataRoot) return;
    const slices = this.presenceSlices();
    if (!slices) return;
    const state = await readStateFile(this.context.dataRoot);
    await writeStateFile(this.context.dataRoot, {
      caption: state?.caption ?? "",
      timestamp: state?.timestamp ?? new Date().toISOString(),
      model: state?.model ?? "",
      motionScore: state?.motionScore ?? this.lastMotionScore,
      presence: slices.presence,
      perception: slices.perception,
      ...(state?.scene ? { scene: state.scene } : {}),
    });
  }

  /** Promise-based sleep — used for capture-loop backoff. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Decide whether the motion score warrants a VLM pass. */
  private onMotion(score: number): void {
    if (score >= this.config.escalationMotionThreshold) {
      // Spike — bypass the cadence gate (immediate escalation path).
      this.triggerProcess(true);
    } else if (score >= this.config.motionThreshold) {
      this.triggerProcess(false);
    }
    // Below threshold: quiet. The state file already holds the caption.
  }

  /** Push a frame onto the buffer and trim anything older than the window. */
  private pushBuffer(frame: MotionVisionFrame): void {
    this.buffer.push(frame);
    const cutoff = Date.now() - this.config.burstWindowMs;
    while (this.buffer.length > 0 && this.buffer[0].capturedAt < cutoff) {
      this.buffer.shift();
    }
  }

  // ===========================================================================
  // Processing — VLM pass
  // ===========================================================================

  /**
   * Request a VLM pass. Respects the one-in-flight guard and (unless
   * `bypassCadence`) the minimum-emit gap. Fire-and-forget — callers don't
   * await this; the actual emit happens inside `runProcess`.
   *
   * `bypassCadence` is also the resolution-profile selector: a spike
   * (≥ escalation threshold — the reflex path) captions at the FULL capture
   * resolution (fat), because that's the moment detail matters most;
   * routine passes caption lean (downscaled — see `packageBurst`).
   */
  private triggerProcess(bypassCadence: boolean): void {
    if (this.processingInFlight) {
      if (bypassCadence) this.pendingSpike = true;
      return;
    }
    if (
      !bypassCadence &&
      Date.now() - this.lastProcessAt < this.config.tickIntervalMs
    ) {
      return;
    }
    // Mark in-flight synchronously so a subsequent capture can't double-fire.
    this.processingInFlight = true;
    void this.runProcess({ lean: !bypassCadence });
  }

  /**
   * Quiet-tick entry: one change-check pass, then (only on change) the
   * full caption pass. Holds the same in-flight guard discipline as
   * triggerProcess — a spike arriving mid-check queues exactly like a
   * spike arriving mid-caption.
   */
  private triggerQuietCheck(): void {
    if (this.processingInFlight) return;
    if (!this.framesFresh()) return;
    this.processingInFlight = true;
    let changed = false;
    void this.runQuietCheck()
      .then((c) => {
        changed = c;
      })
      .catch(() => {
        // A failed check reads as changed — never hide real change.
        changed = true;
      })
      .finally(() => {
        this.processingInFlight = false;
        if (this.pendingSpike) {
          this.pendingSpike = false;
          this.triggerProcess(true);
        } else if (changed) {
          this.triggerProcess(false);
        }
      });
  }

  /**
   * CAMERA-PATH BLINDNESS: a camera path gone silent (phone screen
   * off, camera disconnected) is NOT a still room — the organ keeps
   * describing "you looking directly at me" off a frozen burst. The
   * browser source's null read means "backgrounded, keep waiting" and
   * the buffer only trims on push, so the frozen burst lives forever
   * and the quiet check keeps asking a VLM same-or-changed about a
   * static frame until variance answers "changed" and fresh describes
   * of a still pour out. The frame FRESHNESS gate closes the whole
   * family: when no frame has arrived for maxQuietMs (the organ's own
   * quiet bound — generous enough to tolerate brief backgrounding),
   * the organ is BLIND — no quiet checks, no describes, no fiction.
   * Presence freezes (the sidecar contract: state freezes, never an
   * empty room); the state file keeps its last-true caption; recovery
   * is automatic on the next frame.
   */
  private framesFresh(): boolean {
    if (this.lastFrameAt === null) return false;
    const ageMs = Date.now() - this.lastFrameAt;
    if (ageMs <= this.config.maxQuietMs) {
      this.blindAnnounced = false;
      return true;
    }
    if (!this.blindAnnounced) {
      this.blindAnnounced = true;
      console.log(
        `[motion-vision] blind: no fresh frames for ${
          Math.round(ageMs / 1000)
        }s — camera path silent, perception frozen`,
      );
    }
    return false;
  }

  /**
   * One quiet comparison against the previous read. Resolves true when
   * the full caption pass should run (change, or no previous read to
   * compare against, or the check itself failed). "Unchanged" confirms
   * the baseline: nothing emitted, nothing stepped, the caption file
   * keeps its still-true value.
   */
  private async runQuietCheck(): Promise<boolean> {
    const previous = this.lastDescription?.trim();
    if (!previous) return true;
    const burst = this.packageBurst(true);
    if (burst.length === 0) return false;
    const changed = await this.provider.checkSceneChange(burst, {
      lastCaption: previous,
      audio: this.audioStream?.snapshotWav() ?? null,
    });
    if (changed === false) {
      console.log("[motion-vision] quiet check: unchanged");
      return false;
    }
    return true;
  }

  /**
   * Run one VLM pass over the current burst and (if warranted) emit an
   * envelope. Updates the state file regardless of whether an envelope is
   * emitted. Sets `lastProcessAt` and clears the in-flight guard.
   *
   * `opts.lean` (default true) selects the burst's resolution profile:
   * lean passes carry every frame, downscaled to leanWidth×leanHeight;
   * fat passes carry every frame at the full capture resolution. Frame
   * COUNT is identical either way — only image size adapts.
   */
  private async runProcess(
    opts: { lean?: boolean } = {},
  ): Promise<OrganEnvelope | null> {
    const lean = opts.lean ?? true;
    if (!this.framesFresh()) return null;
    try {
      const burst = this.packageBurst(lean);
      if (burst.length === 0) {
        return null;
      }
      this.lastBurstProfile = lean ? "lean" : "fat";

      const scene = await this.provider.describeScene(burst, {
        directive: this.directive ?? this.context.getDirective?.() ?? null,
        identity: this.sceneIdentity(),
        scenePrefix: this.scenePrefix,
        audio: this.audioStream?.snapshotWav() ?? null,
      });
      if (!scene) return null; // VLM failed — caption file keeps its last value

      this.lastProcessAt = Date.now();
      return this.handleScene(scene);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[motion-vision] process failed: ${msg}`);
      return null;
    } finally {
      this.processingInFlight = false;
      if (this.pendingSpike) {
        this.pendingSpike = false;
        // Re-trigger immediately for a spike that arrived mid-process.
        this.triggerProcess(true);
      }
    }
  }

  /**
   * Snapshot the current buffer (frames within the burst window), sized for
   * the pass's profile. Every frame in the window goes out either way — the
   * adaptive-burst lever is image SIZE, never frame count. Lean passes
   * downscale each frame in-process (decode → box-average → encode); fat
   * passes ship the buffer untouched at the capture resolution. Undecodable
   * frames pass through as-is (downscaleJpeg's guard), so a decode hiccup
   * can never drop a frame.
   */
  private packageBurst(lean: boolean): MotionVisionFrame[] {
    const burst = [...this.buffer];
    if (
      !lean || !this.config.adaptiveBursts ||
      this.config.leanWidth >= this.config.visionWidth
    ) {
      return burst;
    }
    return burst.map((f) => ({
      ...f,
      jpeg: downscaleJpeg(
        f.jpeg,
        this.config.leanWidth,
        this.config.leanHeight,
      ),
    }));
  }

  /**
   * The identity facts for the scene prompt, from the freshest perception
   * result. Stale results (>2 capture intervals old) yield null — a fact
   * older than the burst itself adds nothing and risks contradicting it.
   */
  private sceneIdentity(): SceneIdentity | null {
    if (!this.lastPerceived || !this.perceptionClient) return null;
    // Fresh for 2 capture intervals (~667ms at 3fps) — a fact older than
    // the burst itself adds nothing and risks contradicting it.
    const staleAfter = 2 * (1_000 / Math.max(1, this.config.captureFps));
    if (Date.now() - this.lastPerceived.at > staleAfter) return null;
    return {
      matched: this.lastPerceived.faces,
      peopleCount: this.lastPerceived.people.count,
    };
  }

  /**
   * Apply amplitude + habituation, update the state file, and emit an envelope
   * if the habituated amplitude is still above the emit floor.
   *
   * With the scene baseline active, the string-comparison habituation is
   * REPLACED by the baseline's surprise blend: conforming (stage-matching)
   * captions quiet down by contrast-normalized surprise, events stay loud,
   * and scene transitions get full amplitude plus their own envelope. The
   * reflex path is untouched — `amplitudeForMotion` still jumps to 0.9 on a
   * motion spike regardless of what the baseline thinks of the scene.
   */
  private async handleScene(scene: SceneResult): Promise<OrganEnvelope | null> {
    const base = amplitudeForMotion(
      this.lastMotionScore,
      this.config.escalationMotionThreshold,
    );

    let amplitude: number;
    let surprise: number | null = null;
    if (this.scene && this.embed) {
      const step = await this.stepSceneBaseline(scene);
      surprise = step.surprise;
      // Reflex-preserved blend (see blendAmplitude — a spike's 0.9 passes
      // through untouched; only non-reflex passes quiet by surprise).
      amplitude = blendAmplitude(
        base,
        step.kind,
        step.surprise,
        this.config.escalationMotionThreshold,
      );
    } else {
      const factor = habituationFactor(
        scene.description,
        this.lastDescription,
        this.habituationPrev,
      );
      this.habituationPrev = factor;
      amplitude = base * factor;
    }

    this.lastDescription = scene.description;

    // Always update the caption file (presence never habituates away). One
    // consolidated write, slices sourced from MEMORY (not the file) — the
    // presence writer and this writer race on read-modify-write, and a
    // stale read here would wipe the presence slice between transitions.
    if (this.context.dataRoot) {
      const slices = this.presenceSlices();
      const now = new Date();
      await writeStateFile(this.context.dataRoot, {
        caption: buildCaption(scene.description, now),
        timestamp: now.toISOString(),
        model: scene.model,
        motionScore: this.lastMotionScore,
        ...(slices
          ? { presence: slices.presence, perception: slices.perception }
          : {}),
        ...(this.scene ? { scene: this.scene } : {}),
      });
    }

    // Habituated below the emit floor — texture only, no event envelope.
    if (amplitude < EMIT_FLOOR) return null;

    // Familiar-scene throttle: a conforming caption (the stage unchanged,
    // nothing novel) emits at texture cadence, not event cadence — the
    // state file still updates every pass; events, transitions, and reflex
    // spikes bypass this entirely.
    if (
      this.scene && this.lastSceneKind === "conforming" &&
      Date.now() - this.lastFamiliarEmitAt < this.config.familiarEmitGapMs
    ) {
      return null;
    }
    if (this.scene && this.lastSceneKind === "conforming") {
      this.lastFamiliarEmitAt = Date.now();
    }

    // People context from the freshest perception result, when it's fresh
    // enough to describe this burst (same staleness rule as the prompt).
    const fresh = this.sceneIdentity();
    const envelope = buildEnvelope(
      this.config.id,
      scene,
      this.lastMotionScore,
      amplitude,
      fresh ? { count: fresh.peopleCount, identified: fresh.matched } : null,
    );
    // Declared novelty (generic, optional): the Thalamus turns this into a
    // `surprise:` tag and the promotion filter multiplies it into
    // effective salience — high model salience on a familiar scene stops
    // escalating, novel observations pass at full strength.
    if (surprise !== null) envelope.perception.data.surprise = surprise;
    // Which resolution profile produced this caption (adaptive bursts) —
    // forensics for caption-quality questions: lean and fat passes read
    // different levels of detail by design.
    envelope.perception.data.burstProfile = this.lastBurstProfile;
    try {
      await this.sink(envelope);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[motion-vision] sink rejected envelope: ${msg}`);
    }
    return envelope;
  }

  /**
   * Embed a caption and step the scene baseline. Updates the delta-prompt
   * prefix for the NEXT captioner call, and emits a low-amplitude
   * context envelope when the stage transitions (recognized or established —
   * "the setting changed" is worth knowing, not worth waking anyone).
   */
  private async stepSceneBaseline(
    scene: SceneResult,
  ): Promise<{ kind: string; surprise: number }> {
    if (!this.scene || !this.embed) {
      return { kind: "n/a", surprise: 0 };
    }
    let embedding: number[];
    try {
      embedding = await this.embed(scene.description);
    } catch {
      // Embedder hiccup — treat as no signal, keep prior factor behavior.
      return {
        kind: this.lastSceneKind ?? "conforming",
        surprise: this.lastSceneSurprise ?? 0,
      };
    }
    const step = stepSceneBaseline(
      this.scene,
      { summary: scene.description, embedding, at: Date.now() },
      this.sceneConfig,
    );
    this.scene = step.state;
    this.scenePrefix = step.result.promptPrefix;
    this.lastSceneKind = step.result.kind;
    this.lastSceneSurprise = step.result.surprise;

    if (
      step.result.kind === "established" || step.result.kind === "recognized"
    ) {
      const summary = this.scene.ring[this.scene.currentIndex ?? 0]?.summary ??
        "";
      await this.emit({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        organId: this.config.id,
        specialistModel: "scene-baseline",
        perception: {
          type: "motion-vision_scene",
          description: step.result.kind === "recognized"
            ? `The setting has changed back to a familiar scene: ${summary}`
            : `The setting has changed; I'm taking in a new scene: ${summary}`,
          data: {
            transition: step.result.kind,
            sceneSummary: summary,
            novelty: step.result.novelty,
          },
          confidence: 0.8,
        },
        amplitude: 0.3, // context, not emergency
      });
    }
    return { kind: step.result.kind, surprise: step.result.surprise };
  }

  /** Merge the scene-baseline slice into the state file (read-modify-write,
   * preserving whatever caption/presence state is already there). */
  private async mergeSceneIntoStateFile(): Promise<void> {
    if (!this.context.dataRoot || !this.scene) return;
    const state = await readStateFile(this.context.dataRoot);
    await writeStateFile(this.context.dataRoot, {
      caption: state?.caption ?? "",
      timestamp: state?.timestamp ?? new Date().toISOString(),
      model: state?.model ?? "",
      motionScore: state?.motionScore ?? this.lastMotionScore,
      ...(state?.presence ? { presence: state.presence } : {}),
      ...(state?.perception ? { perception: state.perception } : {}),
      scene: this.scene,
    });
  }

  // ===========================================================================
  // Startup initialization
  // ===========================================================================

  /**
   * Restore caption from the state file if it's recent; otherwise kick off an
   * initial VLM pass so the entity has visual presence from startup (never
   * blind from the get-go). Presence state restores too: a daemon restart is
   * not an arrival — seeding the machines from the persisted state suppresses
   * the spurious "someone is here" the first frames would otherwise emit.
   */
  private async initialize(): Promise<void> {
    if (!this.context.dataRoot) return;
    const state = await readStateFile(this.context.dataRoot);
    if (state?.presence && this.perceptionClient) {
      this.presence = restorePresence(state.presence);
      console.log(
        `[motion-vision] restored presence state (${
          state.presence.tracks?.length ?? 0
        } tracks)`,
      );
    }
    if (state?.scene && this.scene) {
      this.scene = restoreSceneBaseline(state.scene);
      const idx = this.scene.currentIndex;
      this.scenePrefix = idx !== null && this.scene.ring[idx]
        ? buildScenePromptPrefix(this.scene.ring[idx].summary)
        : null;
      console.log(
        `[motion-vision] restored scene baseline (${this.scene.ring.length} scenes in ring)`,
      );
    }
    if (state) {
      const ageMs = Date.now() - new Date(state.timestamp).getTime();
      if (ageMs < this.config.maxQuietMs) {
        console.log(
          `[motion-vision] restored recent caption (age ${
            Math.round(ageMs / 1000)
          }s)`,
        );
        return;
      }
    }
    // Stale or missing — populate from a fresh VLM pass.
    void this.initialPass();
  }

  /** Capture one frame and run a VLM pass to seed the caption file. */
  private async initialPass(): Promise<void> {
    try {
      const jpeg = await captureFrame(this.config.device, CAPTURE_TIMEOUT_MS);
      this.prevGray = jpegToGrayscale(jpeg);
      this.pushBuffer({ jpeg, capturedAt: Date.now() });
      this.lastMotionScore = 0; // no prior frame to diff against
      this.processingInFlight = true;
      try {
        await this.runProcess();
      } finally {
        this.processingInFlight = false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[motion-vision] initial pass failed: ${msg}`);
    }
  }
}

/**
 * Factory. Config is
 * partial and merged over `defaultMotionVisionConfig()`; the runtime wiring
 * passes values from `FluxSettings`.
 */
export function createMotionVisionOrgan(
  config: Partial<MotionVisionOrganConfig>,
  sink: EnvelopeSink,
  context: MotionVisionContext = {},
): MotionVisionOrgan {
  return new MotionVisionOrgan(config, sink, context);
}
