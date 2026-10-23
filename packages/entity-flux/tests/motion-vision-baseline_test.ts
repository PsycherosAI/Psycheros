/**
 * Organ-level scene-baseline integration tests — a fake embedder + mocked
 * VLM driving the real organ through caption→baseline→envelope cycles.
 * These pin the WIRING (the module's semantics are pinned in
 * scene-baseline_test.ts): the prompt prefix reaches the captioner, the
 * amplitude blend replaces string habituation when active, transitions
 * emit their context envelope, the state file round-trips, and the
 * baseline stays off (string habituation intact) when not enabled.
 */

import { assertEquals } from "@std/assert";
import { MotionVisionOrgan } from "../src/organs/motion-vision/motion-vision-organ.ts";
import { readStateFile } from "../src/organs/motion-vision/response.ts";
import type { MotionVisionFrame } from "../src/organs/motion-vision/types.ts";
import type { OrganEnvelope } from "../src/types.ts";

/** Mock fetch: canned VLM captions, captured request bodies. */
function mockVlm(
  captions: string[],
): { restore: () => void; prompts: string[] } {
  const original = globalThis.fetch;
  const prompts: string[] = [];
  let call = 0;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      messages: Array<{
        content: Array<{ type: string; text?: string }>;
      }>;
    };
    const textBlocks = body.messages[0].content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    prompts.push(textBlocks);
    const caption = captions[Math.min(call++, captions.length - 1)];
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: caption } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), prompts };
}

function frame(): MotionVisionFrame {
  return { jpeg: new Uint8Array([1, 2, 3, 4]), capturedAt: Date.now() };
}

/** Fake embedder: hashes keywords to orthogonal-ish toy axes. */
function toyEmbed(text: string): Promise<number[]> {
  const v = new Array(16).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const w of words) v[hash(w) % 16] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Promise.resolve(v.map((x) => x / norm));
}
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function makeOrgan(
  _captions: string[],
  received: OrganEnvelope[],
  dataRoot?: string,
): MotionVisionOrgan {
  return new MotionVisionOrgan(
    {
      enabled: true,
      provider: "openai-compatible",
      modelUrl: "http://x:1/v1",
      model: "test",
      // Escalation high so amplitudeForMotion stays in the linear band
      // (0.15..0.5) — the blend is visible in the envelope amplitudes.
      motionThreshold: 0.01,
      escalationMotionThreshold: 0.99,
      familiarEmitGapMs: 0, // amplitude tests — throttle off
      sceneBaselineEnabled: true,
    },
    (e) => {
      received.push(e);
    },
    { embed: toyEmbed, ...(dataRoot ? { dataRoot } : {}) },
  );
}

const deskCaption =
  "The user sits at the desk in a warm room with an orange couch, working quietly.";
const deskCaption2 =
  "The user sits at the desk in the warm room, working quietly as before.";
const couchCaption =
  "The room from a different angle: The user is now settled on the orange couch, relaxed.";

Deno.test("baseline: prompt prefix reaches the captioner from the second call", async () => {
  const m = mockVlm([deskCaption, deskCaption2, deskCaption2]);
  try {
    const received: OrganEnvelope[] = [];
    const organ = makeOrgan(
      [deskCaption, deskCaption2, deskCaption2],
      received,
    );
    await organ.runProcessForTest([frame()]);
    await organ.runProcessForTest([frame()]);
    await organ.runProcessForTest([frame()]);
    assertEquals(m.prompts.length, 3);
    assertEquals(
      m.prompts[0].includes("Known scene"),
      false,
      "first call has no stage yet",
    );
    assertEquals(
      m.prompts[1].includes("Known scene"),
      true,
      "second call carries the stage prefix",
    );
    assertEquals(
      m.prompts[2].includes("Known scene"),
      true,
      "prefix persists across conforming captions",
    );
  } finally {
    m.restore();
  }
});

Deno.test("baseline: conforming captions quiet down, transitions get full amplitude", async () => {
  const m = mockVlm([deskCaption, deskCaption2, deskCaption2, couchCaption]);
  try {
    const received: OrganEnvelope[] = [];
    const organ = makeOrgan([], received);
    const first = await organ.runProcessForTest([frame()]);
    assertEquals(first?.amplitude !== undefined, true);
    const firstAmp = first!.amplitude;

    // Two more conforming captions — amplitude should drop (stage known).
    await organ.runProcessForTest([frame()]);
    const quiet = await organ.runProcessForTest([frame()]);
    assertEquals(
      quiet!.amplitude < firstAmp,
      true,
      `conforming caption quieter (${quiet!.amplitude} vs ${firstAmp})`,
    );

    // Transition to the couch — full amplitude + a transition envelope.
    await organ.runProcessForTest([frame()]);
    assertEquals(m.prompts.length, 4, "four VLM calls happened");
    const transitionEnv = received.find((e) =>
      e.perception.data.transition !== undefined
    );
    assertEquals(
      transitionEnv !== undefined,
      true,
      "transition envelope emitted",
    );
    assertEquals(
      ["established", "recognized"].includes(
        transitionEnv!.perception.data.transition as string,
      ),
      true,
    );
  } finally {
    m.restore();
  }
});

Deno.test("baseline: scene slice lands in the state file and survives restore", async () => {
  const dataRoot = await Deno.makeTempDir();
  const m = mockVlm([deskCaption, deskCaption2]);
  try {
    const received: OrganEnvelope[] = [];
    const organ = makeOrgan([], received, dataRoot);
    await organ.runProcessForTest([frame()]);
    await organ.runProcessForTest([frame()]);
    const state = await readStateFile(dataRoot);
    assertEquals(state?.scene !== undefined, true, "scene slice persisted");
    assertEquals(state?.scene?.ring.length, 1, "one stage calibrated");

    // Fresh organ restores the ring — no relearning, prefix available.
    const received2: OrganEnvelope[] = [];
    const organ2 = new MotionVisionOrgan(
      {
        enabled: true,
        provider: "openai-compatible",
        modelUrl: "http://x:1/v1",
        model: "test",
        motionThreshold: 0.01,
        escalationMotionThreshold: 0.99,
        sceneBaselineEnabled: true,
      },
      (e) => {
        received2.push(e);
      },
      { embed: toyEmbed, dataRoot },
    );
    await organ2.initializeForTest();
    await organ2.runProcessForTest([frame()]);
    assertEquals(
      m.prompts[m.prompts.length - 1].includes("Known scene"),
      true,
      "restored organ injects the stage on its first caption",
    );
    organ.stop();
    organ2.stop();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    m.restore();
    await Deno.remove(dataRoot, { recursive: true });
  }
});

Deno.test("baseline disabled: string habituation path intact, no prefix", async () => {
  const m = mockVlm([deskCaption, deskCaption, deskCaption]);
  try {
    const received: OrganEnvelope[] = [];
    const organ = new MotionVisionOrgan(
      {
        enabled: true,
        provider: "openai-compatible",
        modelUrl: "http://x:1/v1",
        model: "test",
        motionThreshold: 0.01,
        escalationMotionThreshold: 0.99,
        sceneBaselineEnabled: false,
      },
      (e) => {
        received.push(e);
      },
      { embed: toyEmbed },
    );
    await organ.runProcessForTest([frame()]);
    await organ.runProcessForTest([frame()]);
    assertEquals(
      m.prompts.every((p) => !p.includes("scene I already know")),
      true,
      "no prefix when disabled",
    );
    // String habituation halves on exact repeats — the classic behavior.
    const envs = received.filter((e) =>
      e.perception.data.motionScore !== undefined
    );
    assertEquals(envs.length >= 1, true, "scene envelopes still emitted");
    organ.stop();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    m.restore();
  }
});

Deno.test("reflex preserve: a motion spike's 0.9 never gets blended down", async () => {
  const m = mockVlm([deskCaption, deskCaption2, couchCaption]);
  try {
    const received: OrganEnvelope[] = [];
    const organ = makeOrgan([], received);
    // First: establish + conform (non-reflex, blended).
    await organ.runProcessForTest([frame()]);
    await organ.runProcessForTest([frame()]);
    const envs = received.filter((e) =>
      e.perception.data.motionScore !== undefined &&
      e.perception.data.transition === undefined
    );
    assertEquals(envs.length > 0, true, "scene envelopes emitted");
    // Every scene envelope now declares its surprise (novelty signal for
    // the promotion filter).
    for (const e of envs) {
      assertEquals(
        typeof e.perception.data.surprise === "number",
        true,
        "surprise declared on scene envelopes",
      );
    }
    // The pure blend: spike base passes through, normal base blends.
    const { blendAmplitude } = await import(
      "../src/organs/motion-vision/motion-vision-organ.ts"
    );
    assertEquals(
      blendAmplitude(0.9, "conforming", 0, 0.5),
      0.9,
      "spike base (≥ escalation) untouched — the sneeze guarantee",
    );
    assertEquals(
      Math.abs(blendAmplitude(0.4, "conforming", 0, 0.5) - 0.4 * 0.3) < 1e-9,
      true,
      "non-reflex base blends by surprise",
    );
    organ.stop();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    m.restore();
  }
});

Deno.test("familiar-scene throttle: conforming captions emit at texture cadence", async () => {
  const m = mockVlm([
    deskCaption,
    deskCaption2,
    deskCaption2,
    deskCaption2,
    deskCaption2,
  ]);
  try {
    const received: OrganEnvelope[] = [];
    const organ = new MotionVisionOrgan(
      {
        enabled: true,
        provider: "openai-compatible",
        modelUrl: "http://x:1/v1",
        model: "test",
        motionThreshold: 0.01,
        escalationMotionThreshold: 0.99,
        familiarEmitGapMs: 50, // tiny for test speed
        sceneBaselineEnabled: true,
      },
      (e) => {
        received.push(e);
      },
      { embed: toyEmbed },
    );
    await organ.runProcessForTest([frame()]); // establish — emits (transition)
    await organ.runProcessForTest([frame()]); // conforming — emits, arms throttle
    const throttled = await organ.runProcessForTest([frame()]); // conforming inside gap
    assertEquals(
      throttled,
      null,
      "conforming caption inside the gap does not emit",
    );
    await new Promise((r) => setTimeout(r, 80)); // past the 50ms gap
    const after = await organ.runProcessForTest([frame()]); // conforming, gap expired
    assertEquals(
      after !== null,
      true,
      "conforming caption after the gap emits",
    );
    organ.stop();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    m.restore();
  }
});

Deno.test("blindness: stale frames — the quiet check is skipped", async () => {
  // A disconnected camera must not leave the organ describing a frozen
  // frame: past maxQuietMs with no fresh frame the organ is BLIND, and
  // the quiet-check path must not ask the VLM anything (no fiction about
  // a still room). runProcessForTest deliberately re-stamps freshness on
  // delivery — the gate under test here is the quiet path's.
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, _init?: RequestInit) => {
    calls.push("vlm");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "a frozen room" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  try {
    const organ = new MotionVisionOrgan(
      {
        enabled: true,
        source: "browser",
        provider: "openai-compatible",
        modelUrl: "http://127.0.0.1:9/v1",
        model: "test",
        maxQuietMs: 60_000,
      },
      () => {},
      { dataRoot: await Deno.makeTempDir() },
    );
    // Establish a real read first (also stamps lastFrameAt to now)…
    await organ.runProcessForTest([frame()]);
    calls.length = 0; // the establish pass legitimately called — silence starts now
    // …then rewind: the camera went silent 10 minutes ago.
    (organ as unknown as { lastFrameAt: number | null }).lastFrameAt =
      Date.now() - 10 * 60_000;
    // Private seam: drive the quiet path directly.
    (
      organ as unknown as { triggerQuietCheck: () => void }
    ).triggerQuietCheck();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(calls, [], "blind organ must not call the VLM at all");
  } finally {
    globalThis.fetch = original;
  }
});
