/**
 * Motion-Vision organ — the perception sidecar client.
 *
 * My link to the shared perception sidecar (a small Python service, started
 * by systemd like the model servers, running classical models on the Coral
 * TPU). One POST per frame: the sidecar counts bodies (stable presence) and
 * matches faces (identity), and I turn those into the presence layer's
 * observations.
 *
 * The contract is deliberately forgiving: any failure — server down,
 * timeout, non-200, malformed body — returns null, and the presence machines
 * treat a null as blindness (hold state), never as an empty room. Perception
 * must never stall my capture loop either: every call carries a hard
 * AbortController timeout well under the frame interval.
 *
 * Availability logging is one-line-per-transition: the first failure after a
 * success logs "down", the first success after failures logs "back". A dead
 * sidecar must not spam a log line per frame at 3fps.
 */

import { encodeBase64 } from "@std/encoding/base64";
import type { MotionVisionFrame, PerceptionResult } from "./types.ts";

/** Hard per-call timeout — perception must never stall the capture loop.
 * Generous enough for a CPU-fallback run of two models on a slow frame. */
const PERCEIVE_TIMEOUT_MS = 2_000;

/**
 * The sidecar's `/perceive` response shape (what crosses the wire).
 * `faces` carries matched identities only; `people.count` counts ALL
 * detections, so `count > faces.length` means "person present, identity
 * unknown".
 */
export interface WirePerceptionResponse {
  people?: { count?: number; boxes?: number[][] };
  faces?: Array<{ id?: string; confidence?: number; box?: number[] }>;
}

/**
 * HTTP client for the perception sidecar. Implements the Sensory Organ-side half of
 * the `PerceptionClient` seam (`types.ts`); the Sensory Organ constructs me from
 * config or receives a fake through `MotionVisionContext` in tests.
 */
export class HttpPerceptionClient {
  /** Last known availability, for one-line-per-transition logging. */
  private available: boolean | null = null;

  constructor(
    /** Base URL of the sidecar, e.g. "http://localhost:18085". */
    private readonly baseUrl: string,
  ) {}

  /**
   * Perceive one frame. Returns the result, or null on ANY failure — the
   * caller treats null as blindness, not as an empty room.
   */
  async perceive(frame: MotionVisionFrame): Promise<PerceptionResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PERCEIVE_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/perceive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_b64: encodeBase64(frame.jpeg) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.noteAvailability(false, `HTTP ${res.status}`);
        return null;
      }
      const data = await res.json() as WirePerceptionResponse;
      const result = parsePerception(data);
      if (!result) {
        this.noteAvailability(false, "malformed response");
        return null;
      }
      this.noteAvailability(true);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.noteAvailability(false, msg);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Log availability transitions only — never per-frame. */
  private noteAvailability(ok: boolean, detail?: string): void {
    const was = this.available;
    this.available = ok;
    if (ok && was === false) {
      console.log("[motion-vision] perception sidecar is back");
    } else if (!ok && was !== false) {
      console.error(
        `[motion-vision] perception sidecar unreachable (${
          detail ?? "unknown"
        }) — identity/presence degraded, captioning continues`,
      );
    }
  }
}

/**
 * Parse and validate a wire response into a `PerceptionResult`. Returns null
 * when the payload doesn't hold the fields I rely on — a sidecar that speaks
 * a different dialect is a failure, not a guess. Boxes are OPTIONAL
 * carry-through: the tracker needs them when present (the sidecar always
 * sends them), but older/partial responses without boxes still parse —
 * counts and matches survive, tracking degrades to count-level.
 */
export function parsePerception(
  data: WirePerceptionResponse,
): PerceptionResult | null {
  const count = data.people?.count;
  if (typeof count !== "number" || count < 0) return null;
  const faces: PerceptionResult["faces"] = [];
  for (const f of data.faces ?? []) {
    if (typeof f?.id !== "string" || typeof f?.confidence !== "number") {
      return null; // malformed entry — refuse the whole payload
    }
    faces.push({
      id: f.id,
      confidence: f.confidence,
      ...(validBox(f.box) ? { box: f.box } : {}),
    });
  }
  const bodyBoxes = (data.people?.boxes ?? [])
    .filter(validBox)
    .map((b) => [...b] as [number, number, number, number]);
  return {
    people: { count, ...(bodyBoxes.length > 0 ? { boxes: bodyBoxes } : {}) },
    faces,
  };
}

/** A box is [x1, y1, x2, y2] with sane ordering. */
function validBox(b: unknown): b is [number, number, number, number] {
  return Array.isArray(b) && b.length === 4 &&
    b.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    (b[2] as number) > (b[0] as number) && (b[3] as number) > (b[1] as number);
}
