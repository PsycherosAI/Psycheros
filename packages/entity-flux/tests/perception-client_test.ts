/**
 * Perception client tests — the HTTP seam to the sidecar, via the same
 * fetch-mocking pattern as the scene-describer tests. The contract these
 * pin: correct request shape, lenient-but-total response parsing (any
 * malformed payload is a null, never a guess), and null on every failure
 * mode so the presence machines read blindness, not emptiness.
 */

import { assertEquals } from "@std/assert";
import {
  HttpPerceptionClient,
  parsePerception,
} from "../src/organs/motion-vision/perception-client.ts";

/** Mock fetch (mirrors motion-vision_test.ts) with failure injection. */
function mockFetch(
  responder: (
    url: string,
    body: unknown,
  ) =>
    | { status?: number; json?: unknown; text?: string }
    | Promise<Response>,
): { restore: () => void; bodies: unknown[]; urls: string[] } {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  const urls: string[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    urls.push(_url);
    const body = init.body ? JSON.parse(init.body as string) : null;
    bodies.push(body);
    const r = responder(_url, body);
    if (r instanceof Promise) return r;
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

function frame(): { jpeg: Uint8Array; capturedAt: number } {
  return { jpeg: new Uint8Array([1, 2, 3, 4]), capturedAt: Date.now() };
}

Deno.test("perceive: sends base64 image to /perceive and parses the result", async () => {
  const m = mockFetch(() => ({
    json: {
      people: { count: 2 },
      faces: [{ id: "alex", confidence: 0.83 }, {
        id: "friend",
        confidence: 0.71,
      }],
      latency_ms: 30,
    },
  }));
  try {
    const client = new HttpPerceptionClient("http://localhost:18085");
    const result = await client.perceive(frame());
    assertEquals(result?.people.count, 2);
    assertEquals(result?.faces.length, 2);
    assertEquals(result?.faces[0], { id: "alex", confidence: 0.83 });
    assertEquals(m.urls, ["http://localhost:18085/perceive"]);
    const body = m.bodies[0] as { image_b64: string };
    assertEquals(typeof body.image_b64, "string");
    // base64 of [1,2,3,4]
    assertEquals(body.image_b64, "AQIDBA==");
  } finally {
    m.restore();
  }
});

Deno.test("perceive: unmatched people are count > faces.length, no fake unknown id", async () => {
  const m = mockFetch(() => ({
    json: { people: { count: 1 }, faces: [] },
  }));
  try {
    const client = new HttpPerceptionClient("http://x:1");
    const result = await client.perceive(frame());
    assertEquals(result?.people.count, 1);
    assertEquals(result?.faces, []);
  } finally {
    m.restore();
  }
});

Deno.test("perceive: null on HTTP 500", async () => {
  const m = mockFetch(() => ({ status: 500, text: "boom" }));
  try {
    const client = new HttpPerceptionClient("http://x:1");
    assertEquals(await client.perceive(frame()), null);
  } finally {
    m.restore();
  }
});

Deno.test("perceive: null on network failure (fetch throws)", async () => {
  const m = mockFetch(() => Promise.reject(new Error("connection refused")));
  try {
    const client = new HttpPerceptionClient("http://x:1");
    assertEquals(await client.perceive(frame()), null);
  } finally {
    m.restore();
  }
});

Deno.test("perceive: null on malformed payload", async () => {
  const cases: unknown[] = [
    {}, // no people
    { people: {} }, // no count
    { people: { count: "two" } }, // count not a number
    { people: { count: 1 }, faces: "alex" }, // faces not an array
    { people: { count: 1 }, faces: [{ id: "alex" }] }, // entry missing confidence
    { people: { count: 1 }, faces: [{ confidence: 0.9 }] }, // entry missing id
  ];
  for (const json of cases) {
    const m = mockFetch(() => ({ json }));
    try {
      const client = new HttpPerceptionClient("http://x:1");
      assertEquals(
        await client.perceive(frame()),
        null,
        `payload: ${JSON.stringify(json)}`,
      );
    } finally {
      m.restore();
    }
  }
});

Deno.test("parsePerception: accepts missing faces array (empty match list)", () => {
  assertEquals(parsePerception({ people: { count: 3 } }), {
    people: { count: 3 },
    faces: [],
  });
});

Deno.test("parsePerception: rejects negative count", () => {
  assertEquals(parsePerception({ people: { count: -1 } }), null);
});
