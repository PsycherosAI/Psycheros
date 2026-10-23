/**
 * Organ-level presence integration tests — a fake PerceptionClient driving
 * the real organ's gate() through the full occupied → empty → occupied arc.
 * These pin the wiring, not the machines (presence_test.ts owns semantics):
 * perception fires per frame regardless of motion, envelopes reach the sink,
 * the state file carries the presence slice, and a disabled/absent sidecar
 * leaves behavior exactly as before.
 *
 * Tests drive `gateForTest` directly — no `start()`, so no FrameStream and
 * no ffmpeg dependency. The organ's internal loops are exercised through
 * the same code path the capture loop uses (gate → observePresence).
 */

import { assertEquals } from "@std/assert";
import { MotionVisionOrgan } from "../src/organs/motion-vision/motion-vision-organ.ts";
import { readStateFile } from "../src/organs/motion-vision/response.ts";
import type {
  MotionVisionContext,
  PerceptionClient,
  PerceptionResult,
} from "../src/organs/motion-vision/types.ts";
import type { OrganEnvelope } from "../src/types.ts";

/** A fake sidecar scripted per call. */
class ScriptedPerception implements PerceptionClient {
  calls = 0;
  constructor(private script: (n: number) => PerceptionResult | null) {}
  perceive(): Promise<PerceptionResult | null> {
    return Promise.resolve(this.script(this.calls++));
  }
}

/** Person-with-optional-face result, boxes included (the tracker's substrate). */
function personBox(
  face?: { id: string; confidence: number },
): PerceptionResult {
  return {
    people: { count: 1, boxes: [[100, 100, 200, 300]] },
    faces: face ? [{ ...face, box: [125, 105, 175, 165] }] : [],
  };
}

const NOBODY: PerceptionResult = { people: { count: 0, boxes: [] }, faces: [] };

/** Undecodable bytes — the motion gate reads them as flat gray (zero motion). */
function junkFrame(): Uint8Array {
  return new Uint8Array([1, 2, 3, 4]);
}

/** Build the organ with perception on, cadences collapsed for test speed. */
function testOrgan(
  script: (n: number) => PerceptionResult | null,
  sink: (e: OrganEnvelope) => void = () => {},
  dataRoot?: string,
): MotionVisionOrgan {
  const client = new ScriptedPerception(script);
  const context: MotionVisionContext = { perceptionClient: client };
  if (dataRoot) context.dataRoot = dataRoot;
  return new MotionVisionOrgan(
    {
      enabled: true,
      perceptionEnabled: true,
      // Collapse debounces so tests advance with a handful of frames.
      arrivalDebounceMs: 100,
      trackGraceMs: 100,
      motionSustainMs: 50,
      motionThreshold: 0.5, // junk frames read as still
      maxQuietMs: 60_000,
    },
    sink,
    context,
  );
}

/** Let the perception promise chain settle. */
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

Deno.test("organ: full occupancy arc — occupied, departure, arrival envelopes reach the sink", async () => {
  const received: OrganEnvelope[] = [];
  // Script: 4 person frames, 6 empty frames, then people again.
  const script = (n: number) =>
    n < 4
      ? personBox({ id: "alex", confidence: 0.8 })
      : n < 10
      ? NOBODY
      : personBox({ id: "alex", confidence: 0.8 });
  const organ = testOrgan(script, (e) => {
    received.push(e);
  });
  try {
    // Person present: frames spanning > 100ms arrival debounce.
    for (let i = 0; i < 4; i++) {
      organ.gateForTest(junkFrame());
      await tick(40);
    }
    // Empty + still: 6 frames spanning > 300ms debounce.
    for (let i = 0; i < 6; i++) {
      await tick(80);
      organ.gateForTest(junkFrame());
      await tick();
    }
    // Return: person frames spanning > 100ms debounce.
    for (let i = 0; i < 4; i++) {
      organ.gateForTest(junkFrame());
      await tick(40);
    }
    const departures = received.filter((e) =>
      e.perception.data.presence === "departure"
    );
    const arrivals = received.filter((e) =>
      e.perception.data.presence === "arrival"
    );
    assertEquals(
      departures.length,
      1,
      `envelopes: ${
        JSON.stringify(received.map((e) => e.perception.description))
      }`,
    );
    // Track semantics: the FIRST confirmation announces too (daemon boot
    // with a person present says "someone is here" once), then the return.
    assertEquals(arrivals.length, 2);
    assertEquals(arrivals[0].perception.data.identity, "alex");
    assertEquals(arrivals[1].perception.data.identity, "alex");
  } finally {
    organ.stop();
  }
});

Deno.test("organ: perception runs even with zero motion (the absence-detection point)", async () => {
  let calls = 0;
  const organ = testOrgan(() => {
    calls++;
    return personBox();
  });
  try {
    organ.gateForTest(junkFrame());
    await tick();
    organ.gateForTest(junkFrame());
    await tick();
    assertEquals(
      calls,
      2,
      "perception must fire per frame, motion-gated or not",
    );
  } finally {
    organ.stop();
  }
});

Deno.test("organ: null perception (sidecar down) never emits and never crashes", async () => {
  const received: OrganEnvelope[] = [];
  const organ = testOrgan(() => null, (e) => {
    received.push(e);
  });
  try {
    for (let i = 0; i < 8; i++) {
      await tick(60);
      organ.gateForTest(junkFrame());
      await tick();
    }
    assertEquals(received.length, 0, "blindness emits nothing");
    assertEquals(organ.presenceStateForTest()?.tracks.length ?? 0, 0);
  } finally {
    organ.stop();
  }
});

Deno.test("organ: presence slice lands in the state file", async () => {
  const dataRoot = await Deno.makeTempDir();
  try {
    const script = (n: number) =>
      n < 4 ? personBox({ id: "alex", confidence: 0.8 }) : NOBODY;
    const organ = testOrgan(script, () => {}, dataRoot);
    for (let i = 0; i < 5; i++) {
      organ.gateForTest(junkFrame());
      await tick(35);
    }
    await tick(30);
    const state = await readStateFile(dataRoot);
    assertEquals(state?.presence?.state, "occupied");
    assertEquals(state?.presence?.identity, "alex");
    assertEquals(state?.perception?.available, true);
    organ.stop();
    await tick(10);
  } finally {
    await Deno.remove(dataRoot, { recursive: true });
  }
});

Deno.test("organ: perceptionEnabled=false leaves the organ fully functional without a sidecar", async () => {
  const received: OrganEnvelope[] = [];
  const organ = new MotionVisionOrgan(
    { enabled: true, perceptionEnabled: false },
    (e) => {
      received.push(e);
    },
  );
  try {
    organ.gateForTest(junkFrame());
    await tick();
    assertEquals(organ.presenceStateForTest(), null, "no presence machinery");
    assertEquals(received.length, 0);
  } finally {
    organ.stop();
  }
});

Deno.test("state file round-trips presence — restore suppresses re-announcement", async () => {
  const dataRoot = await Deno.makeTempDir();
  try {
    const person = (): PerceptionResult =>
      personBox({ id: "alex", confidence: 0.8 });
    const organ = testOrgan(person, () => {}, dataRoot);
    for (let i = 0; i < 5; i++) {
      organ.gateForTest(junkFrame());
      await tick(35);
    }
    organ.stop();
    await tick(30);
    const state = await readStateFile(dataRoot);
    assertEquals(state?.presence?.state, "occupied");

    // Fresh organ, same dataRoot — restores instead of re-announcing.
    const received: OrganEnvelope[] = [];
    const organ2 = testOrgan(person, (e) => {
      received.push(e);
    }, dataRoot);
    await organ2.initializeForTest();
    for (let i = 0; i < 3; i++) {
      organ2.gateForTest(junkFrame());
      await tick();
    }
    const announcements = received.filter((e) =>
      e.perception.data.event === "seen" ||
      e.perception.data.presence === "arrival"
    );
    assertEquals(
      announcements.length,
      0,
      `unexpected: ${JSON.stringify(received)}`,
    );
  } finally {
    await Deno.remove(dataRoot, { recursive: true });
  }
});
