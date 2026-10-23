/**
 * Motion-Vision organ — unit tests.
 *
 * Covers the pure-ish pieces: the motion gate, the scene describer (with fetch
 * mocked), the state-file helpers, and the amplitude/habituation math. The
 * organ's loops (capture, processing) need a real webcam + Ollama and are
 * verified manually — see the plan's end-to-end checklist.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
} from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { decode as jpegDecode, encode as jpegEncode } from "jpeg-js";

import {
  amplitudeForMotion,
  buildCaption,
  buildEnvelope,
  computeMotionScore,
  createVisionProvider,
  downscaleJpeg,
  formatCaptionTime,
  habituationFactor,
  MotionVisionOrgan,
  OpenAICompatibleVisionProvider,
  readStateFile,
  writeStateFile,
} from "../src/organs/motion-vision/mod.ts";
import type { MotionVisionFrame } from "../src/organs/motion-vision/mod.ts";
import { GRAY_H, GRAY_W } from "../src/organs/motion-vision/mod.ts";

// =============================================================================
// Helpers
// =============================================================================

function makeFrame(
  jpeg: number[] = [1, 2, 3],
  capturedAt = Date.now(),
): MotionVisionFrame {
  return {
    jpeg: new Uint8Array(jpeg),
    capturedAt,
  };
}

/** Fully gray frame (no signal) at the thumbnail resolution. */
function blankGray(value = 128): number[] {
  return Array(GRAY_W * GRAY_H).fill(value);
}

// =============================================================================
// Motion gate
// =============================================================================

Deno.test("motion gate: identical frames score zero", () => {
  const a = new Uint8Array(blankGray(100));
  assertEquals(computeMotionScore(a, a), 0);
});

Deno.test("motion gate: every pixel changed above threshold scores ~1", () => {
  const a = new Uint8Array(blankGray(0));
  const b = new Uint8Array(blankGray(255)); // diff 255 > 25 everywhere
  assertEquals(computeMotionScore(b, a), 1);
});

Deno.test("motion gate: sub-threshold differences score zero (noise ignored)", () => {
  // Each pixel differs by 10 — below PIXEL_CHANGE_THRESHOLD (25).
  const a = new Uint8Array(blankGray(100));
  const b = new Uint8Array(blankGray(110));
  assertEquals(computeMotionScore(b, a), 0);
});

Deno.test("motion gate: partial change produces the expected fraction", () => {
  const a = new Uint8Array(blankGray(100));
  const b = new Uint8Array(blankGray(100));
  // Flip exactly half the pixels by a large amount.
  const half = b.length / 2;
  for (let i = 0; i < half; i++) b[i] = 200; // diff 100 > 25
  const score = computeMotionScore(b, a);
  assertEquals(score, 0.5);
});

Deno.test("motion gate: mismatched lengths return zero", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2]);
  assertEquals(computeMotionScore(a, b), 0);
});

Deno.test("motion gate: empty arrays return zero", () => {
  assertEquals(computeMotionScore(new Uint8Array(0), new Uint8Array(0)), 0);
});

// =============================================================================
// Scene describer (fetch mocked)
// =============================================================================

/** Stand-in for real frames — describeScene only reads jpeg bytes + timestamps. */
function dummyBurst(n: number): MotionVisionFrame[] {
  return Array.from(
    { length: n },
    (_, i) => makeFrame([10 + i, 20, 30], Date.now() - (n - i) * 100),
  );
}

// =============================================================================
// Scene describer — Ollama provider (fetch mocked)
// =============================================================================

/** Mock fetch that captures the JSON body and returns a canned response. */
function mockFetch(
  responder: (
    url: string,
    body: unknown,
  ) => { status?: number; json?: unknown; text?: string },
): { restore: () => void; bodies: unknown[]; urls: string[] } {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  const urls: string[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    urls.push(_url);
    const body = init.body ? JSON.parse(init.body as string) : null;
    bodies.push(body);
    const r = responder(_url, body);
    const status = r.status ?? 200;
    const payload = r.json !== undefined
      ? JSON.stringify(r.json)
      : (r.text ?? "");
    return Promise.resolve(
      new Response(payload, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return {
    bodies,
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.test("providers: change check parses unchanged/changed answers", async () => {
  // Unchanged (varied punctuation) → false; anything else → true.
  const cases: Array<[string, boolean]> = [
    ["unchanged", false],
    ["Unchanged.", false],
    ["  unchanged ", false],
    ["changed", true],
    ["Changed — a person walked in.", true],
  ];
  for (const [answer, expected] of cases) {
    const m = mockFetch(() => ({
      json: { choices: [{ message: { content: answer } }] },
    }));
    try {
      const provider = new OpenAICompatibleVisionProvider("http://x/v1", "m");
      assertEquals(
        await provider.checkSceneChange(dummyBurst(2), {
          lastCaption: "a quiet room",
        }),
        expected,
        `answer "${answer}" should read ${expected ? "changed" : "unchanged"}`,
      );
      // The comparison ask carries no description instruction and caps
      // the answer tokens.
      const body = m.bodies[0] as {
        max_tokens: number;
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      assertEquals(body.max_tokens, 8);
      const text = body.messages[0].content.find((b) => b.type === "text")!
        .text as string;
      assertEquals(text.includes("unchanged"), true);
      assertEquals(text.includes("Describe specifically"), false);
    } finally {
      m.restore();
    }
  }
});

Deno.test("providers: change check failure reads as changed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  try {
    const provider = new OpenAICompatibleVisionProvider("http://x/v1", "m");
    assertEquals(
      await provider.checkSceneChange(dummyBurst(1), { lastCaption: "x" }),
      null,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// =============================================================================
// Scene describer — OpenAI-compatible provider (fetch mocked)
// =============================================================================

Deno.test("openai-compatible provider: parses a successful chat completion", async () => {
  const m = mockFetch(() => ({
    json: {
      choices: [{ message: { content: "A cluttered room with a cabinet." } }],
    },
  }));
  try {
    const provider = new OpenAICompatibleVisionProvider(
      "http://lan:8080/v1",
      "gemma4-26b",
    );
    const result = await provider.describeScene(dummyBurst(2), {});
    assertEquals(result?.description, "A cluttered room with a cabinet.");
    assertEquals(result?.model, "gemma4-26b");
    assertEquals(result?.frameCount, 2);
    // Endpoint + request shape.
    assertEquals(m.urls[0], "http://lan:8080/v1/chat/completions");
    const body = m.bodies[0] as {
      model: string;
      messages: Array<{
        role: string;
        content: Array<
          { type: string; image_url?: { url: string }; text?: string }
        >;
      }>;
      stream: boolean;
    };
    assertEquals(body.model, "gemma4-26b");
    assertEquals(body.stream, false);
    // One text block FIRST (prefix-cache friendly — the stable scene-stage
    // head reuses llama-server's prompt cache), then two image_url blocks.
    assertEquals(body.messages[0].content.length, 3);
    assertEquals(body.messages[0].content[0].type, "text");
    assertEquals(body.messages[0].content[1].type, "image_url");
    assertEquals(body.messages[0].content[2].type, "image_url");
    // image_url is a base64 data URI (blocks follow the leading text).
    assert(
      body.messages[0].content[1].image_url!.url.startsWith(
        "data:image/jpeg;base64,",
      ),
    );
  } finally {
    m.restore();
  }
});

Deno.test("openai-compatible provider: directive appended to the text block", async () => {
  const m = mockFetch(() => ({
    json: { choices: [{ message: { content: "ok" } }] },
  }));
  try {
    const provider = new OpenAICompatibleVisionProvider("http://x/v1", "m");
    await provider.describeScene(dummyBurst(1), { directive: "a blue Subaru" });
    const body = m.bodies[0] as {
      messages: Array<{
        content: Array<{ type: string; text?: string }>;
      }>;
    };
    const textBlock = body.messages[0].content.find((c) => c.type === "text");
    assert(textBlock?.text?.includes("a blue Subaru"));
  } finally {
    m.restore();
  }
});

Deno.test("openai-compatible provider: returns null on empty choices", async () => {
  const m = mockFetch(() => ({ json: { choices: [] } }));
  try {
    const provider = new OpenAICompatibleVisionProvider("http://x/v1", "m");
    assertEquals(await provider.describeScene(dummyBurst(1), {}), null);
  } finally {
    m.restore();
  }
});

// =============================================================================
// Provider factory
// =============================================================================

Deno.test("factory: returns the right provider type", () => {
  assertEquals(
    createVisionProvider("openai-compatible", "http://x/v1", "m").type,
    "openai-compatible",
  );
});

// =============================================================================
// State file helpers
// =============================================================================

Deno.test("state file: round-trip write + read", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mv-state-test-" });
  try {
    const state = {
      caption: "[Sun 02:30 PM] Test caption.",
      timestamp: new Date("2026-08-02T14:30:00Z").toISOString(),
      model: "gemma4:e4b",
      motionScore: 0.18,
    };
    await writeStateFile(dir, state);
    const read = await readStateFile(dir);
    assertEquals(read, state);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("state file: read returns null when missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mv-state-test-" });
  try {
    const read = await readStateFile(dir);
    assertEquals(read, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("state file: read returns null on malformed JSON", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mv-state-test-" });
  try {
    const path = `${dir}/.psycheros/organ-state/motion-vision.json`;
    await Deno.mkdir(`${dir}/.psycheros/organ-state`, { recursive: true });
    await Deno.writeTextFile(path, "{ not valid json");
    assertEquals(await readStateFile(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// =============================================================================
// Caption time formatting (mirrors noticing layer)
// =============================================================================

Deno.test("caption time: produces weekday + time bracket", () => {
  const now = new Date("2026-08-02T14:30:00Z");
  const t = formatCaptionTime(now);
  // Structure check (locale-stable): "Weekday HH:MM AM/PM" — has a space
  // between weekday and time, and a colon in the time.
  assert(/^\w{3} \d{1,2}:\d{2}/.test(t), `unexpected format: ${t}`);
});

Deno.test("caption: bracketed time prefix + description", () => {
  const caption = buildCaption("Hello room.", new Date("2026-08-02T14:30:00Z"));
  assert(caption.startsWith("["), `missing bracket: ${caption}`);
  assert(caption.endsWith("Hello room."));
  assert(caption.includes("] Hello room."));
});

// =============================================================================
// Amplitude + habituation
// =============================================================================

Deno.test("amplitude: below threshold scales linearly in [0.15, ~0.5]", () => {
  const esc = 0.5;
  // Just above zero motion → near the floor (0.15).
  assert(amplitudeForMotion(0.001, esc) >= 0.15);
  assert(amplitudeForMotion(0.001, esc) < 0.16);
  // Halfway to escalation → 0.15 + 0.5*0.35 = 0.325 (floating point, so fuzzy).
  assertAlmostEquals(amplitudeForMotion(0.25, esc), 0.325, 1e-9);
});

Deno.test("amplitude: at escalation threshold jumps to 0.9", () => {
  assertEquals(amplitudeForMotion(0.5, 0.5), 0.9);
  assertEquals(amplitudeForMotion(0.9, 0.5), 0.9);
});

Deno.test("habituation: same description halves the factor", () => {
  assertEquals(
    habituationFactor("The user is reading.", "The user is reading.", 1.0),
    0.5,
  );
  assertEquals(
    habituationFactor("The user is reading.", "The user is reading.", 0.5),
    0.25,
  );
});

Deno.test("habituation: different description resets to 1.0", () => {
  assertEquals(
    habituationFactor("The user left.", "The user is reading.", 0.125),
    1.0,
  );
});

Deno.test("habituation: normalization ignores case + whitespace", () => {
  // These should count as the same description.
  const a = "The user  is READING.";
  const b = "the user is reading.";
  assertEquals(habituationFactor(a, b, 1.0), 0.5);
});

Deno.test("habituation: null previous description resets", () => {
  assertEquals(habituationFactor("anything", null, 0.25), 1.0);
});

// =============================================================================
// Envelope construction
// =============================================================================

Deno.test("envelope: carries perception + amplitude + model", () => {
  const scene = {
    description: "A test scene.",
    model: "gemma4:e4b",
    frameCount: 4,
    windowMs: 3000,
  };
  const env = buildEnvelope("motion-vision", scene, 0.3, 0.4);
  assertEquals(env.organId, "motion-vision");
  assertEquals(env.specialistModel, "gemma4:e4b");
  assertEquals(env.perception.type, "motion-vision_scene");
  assertEquals(env.perception.description, "A test scene.");
  assertEquals(env.perception.confidence, 0.8);
  assertEquals(env.amplitude, 0.4);
  assertEquals((env.perception.data as { frameCount: number }).frameCount, 4);
  assertNotEquals(env.id, "");
  // No mood modifiers in v1 (conservative default).
  assertEquals(env.moodModifiers, undefined);
});

// =============================================================================
// Audio captioning — WAV format + provider block
// =============================================================================

Deno.test("wavFromPcm: 44-byte RIFF header, correct fields, payload intact", async () => {
  const { wavFromPcm } = await import("../src/organs/motion-vision/capture.ts");
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const wav = wavFromPcm(pcm, 16000);
  assertEquals(wav.length, 44 + 6);
  const dv = new DataView(wav.buffer);
  const tag = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
  assertEquals(tag(0), "RIFF");
  assertEquals(tag(8), "WAVE");
  assertEquals(tag(36), "data");
  assertEquals(dv.getUint32(4, true), 36 + 6);
  assertEquals(dv.getUint32(24, true), 16000); // sample rate
  assertEquals(dv.getUint16(22, true), 1); // mono
  assertEquals(dv.getUint16(34, true), 16); // bits
  assertEquals([...wav.slice(44)], [1, 2, 3, 4, 5, 6]);
});

Deno.test("openai provider: audio option attaches an input_audio block first", async () => {
  const m = mockFetch(() => ({
    json: { choices: [{ message: { content: "She laughs at the screen." } }] },
  }));
  try {
    const provider = new OpenAICompatibleVisionProvider("http://x:1/v1", "m");
    const wav = new Uint8Array([82, 73, 70, 70]); // stub wav bytes
    const result = await provider.describeScene(dummyBurst(1), { audio: wav });
    assertEquals(result?.description, "She laughs at the screen.");
    const body = m.bodies[0] as {
      messages: Array<{
        content: Array<
          { type: string; input_audio?: { data: string; format: string } }
        >;
      }>;
    };
    const blocks = body.messages[0].content;
    assertEquals(blocks[0].type, "input_audio", "audio block leads");
    assertEquals(blocks[0].input_audio?.format, "wav");
    assertEquals(typeof blocks[0].input_audio?.data, "string");
    assertEquals(blocks[1].type, "text", "text second");
    assertEquals(blocks[2].type, "image_url", "images follow");
    // the prompt mentions sound
    const text = blocks.find((b) => b.type === "text") as unknown as {
      text: string;
    };
    assert(
      text.text.includes("notable sounds"),
      "prompt tells the model it can hear",
    );
    assert(
      !text.text.includes("fold notable sounds"),
      "compressed wording, not the draft",
    );
  } finally {
    m.restore();
  }
});

Deno.test("openai provider: no audio = no input_audio block, no audio line", async () => {
  const m = mockFetch(() => ({
    json: { choices: [{ message: { content: "Quiet room." } }] },
  }));
  try {
    const provider = new OpenAICompatibleVisionProvider("http://x:1/v1", "m");
    await provider.describeScene(dummyBurst(1), {});
    const body = m.bodies[0] as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const types = body.messages[0].content.map((b) => b.type);
    assertEquals(types.includes("input_audio"), false);
    const text = body.messages[0].content.find((b) => b.type === "text") as {
      text: string;
    };
    assertEquals(
      text.text.includes("audio"),
      false,
      "no audio line when no audio",
    );
  } finally {
    m.restore();
  }
});

// =============================================================================
// Adaptive bursts — lean/fat resolution switching (image SIZE adapts,
// frame COUNT never changes)
// =============================================================================

/** A real, decodable solid-color JPEG at the given dimensions. */
function solidJpeg(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 120;
    data[i + 2] = 60;
    data[i + 3] = 255;
  }
  return jpegEncode({ data, width: w, height: h }, 90).data;
}

Deno.test("downscaleJpeg: produces the target dimensions at a smaller size", () => {
  const fat = solidJpeg(640, 480);
  const lean = downscaleJpeg(fat, 480, 360);
  const decoded = jpegDecode(lean);
  assertEquals(decoded.width, 480);
  assertEquals(decoded.height, 360);
  assert(lean.length < fat.length, "lean burst should be fewer bytes");
});

Deno.test("downscaleJpeg: same-size input is a byte-identical no-op", () => {
  const jpeg = solidJpeg(480, 360);
  assertEquals(downscaleJpeg(jpeg, 480, 360), jpeg);
});

Deno.test("downscaleJpeg: undecodable input passes through untouched", () => {
  // Garbage bytes (like test fixtures) must never be dropped or altered —
  // downscaling is an optimization, not a gate.
  const garbage = new Uint8Array([1, 2, 3]);
  assertEquals(downscaleJpeg(garbage, 480, 360), garbage);
});

Deno.test("downscaleJpeg: box average preserves a solid frame's color", () => {
  const lean = downscaleJpeg(solidJpeg(640, 480), 480, 360);
  const { data } = jpegDecode(lean);
  // Center pixel ≈ the source color (JPEG is lossy — fuzzy compare).
  const i = (180 * 480 + 240) * 4;
  assertAlmostEquals(data[i], 200, 30);
  assertAlmostEquals(data[i + 1], 120, 30);
  assertAlmostEquals(data[i + 2], 60, 30);
});

/** Decode the image_url blocks a captioner request actually received. */
function sentImageDims(body: unknown): string[] {
  const b = body as {
    messages: Array<{
      content: Array<{ type: string; image_url?: { url: string } }>;
    }>;
  };
  return b.messages[0].content
    .filter((c) => c.type === "image_url")
    .map((c) => {
      const jpeg = decodeBase64(c.image_url!.url.split(",")[1]);
      const d = jpegDecode(jpeg);
      return `${d.width}x${d.height}`;
    });
}

Deno.test("adaptive bursts: lean pass downscales every frame, fat ships full", async () => {
  const m = mockFetch(() => ({
    json: { choices: [{ message: { content: "She waves." } }] },
  }));
  try {
    const organ = new MotionVisionOrgan({
      provider: "openai-compatible",
      modelUrl: "http://x:1/v1",
      model: "m",
      adaptiveBursts: true,
      visionWidth: 640,
      visionHeight: 480,
      leanWidth: 480,
      leanHeight: 360,
    });
    const frames: MotionVisionFrame[] = [
      { jpeg: solidJpeg(640, 480), capturedAt: Date.now() - 100 },
      { jpeg: solidJpeg(640, 480), capturedAt: Date.now() },
    ];
    const leanEnv = await organ.runProcessForTest(frames, true);
    assertEquals(leanEnv?.perception.data.burstProfile, "lean");
    const fatEnv = await organ.runProcessForTest(frames, false);
    assertEquals(fatEnv?.perception.data.burstProfile, "fat");

    // The captioner received EVERY frame both times — count never adapts.
    assertEquals(m.bodies.length, 2);
    // Lean: both frames downscaled to 480×360.
    assertEquals(sentImageDims(m.bodies[0]), ["480x360", "480x360"]);
    // Fat: both frames at the full capture resolution.
    assertEquals(sentImageDims(m.bodies[1]), ["640x480", "640x480"]);
  } finally {
    m.restore();
  }
});

Deno.test("adaptive bursts: disabled flag ships full frames on lean passes", async () => {
  const m = mockFetch(() => ({
    json: { choices: [{ message: { content: "ok" } }] },
  }));
  try {
    const organ = new MotionVisionOrgan({
      provider: "openai-compatible",
      modelUrl: "http://x:1/v1",
      model: "m",
      adaptiveBursts: false,
      visionWidth: 640,
      visionHeight: 480,
      leanWidth: 480,
      leanHeight: 360,
    });
    await organ.runProcessForTest(
      [{ jpeg: solidJpeg(640, 480), capturedAt: Date.now() }],
      true,
    );
    assertEquals(sentImageDims(m.bodies[0]), ["640x480"]);
  } finally {
    m.restore();
  }
});
