/**
 * Tests for the self-hosted gateway image-gen provider — the pure helpers:
 * canvas selection (preset + explicit dimensions) and readable typed-error
 * description for non-JSON gateway failures.
 */

import { assertEquals } from "@std/assert";
import {
  describeGatewayHttpFailure,
  gatewayCanvas,
} from "../src/tools/generate-image.ts";
import type { CommonImageGenParams } from "../src/llm/image-gen-settings.ts";

function params(
  overrides: Partial<CommonImageGenParams> = {},
): CommonImageGenParams {
  return {
    width: 1024,
    height: 1024,
    steps: 20,
    negative_prompt: "",
    ...overrides,
  };
}

// =============================================================================
// gatewayCanvas — preset selection
// =============================================================================

Deno.test("gatewayCanvas: square default maps to the enrolled preset of its size", () => {
  // Default params are 1024x1024 — the generator really produces 1024 pixels.
  assertEquals(gatewayCanvas(params(), false), { preset: "square_1024" });
});

Deno.test("gatewayCanvas: small configured square uses the 512 preset", () => {
  assertEquals(gatewayCanvas(params({ width: 512, height: 512 }), false), {
    preset: "square_512",
  });
});

Deno.test("gatewayCanvas: 40 configured steps pick the quality preset", () => {
  assertEquals(gatewayCanvas(params({ steps: 40 }), false), {
    preset: "square_1024_quality",
  });
});

Deno.test("gatewayCanvas: quality preset with reference images falls back to 20 steps", () => {
  // The quality preset is text-only; image inputs must use a 20-step preset.
  assertEquals(gatewayCanvas(params({ steps: 40 }), true), {
    preset: "square_1024",
  });
});

// =============================================================================
// gatewayCanvas — aspect ratio mapping
// =============================================================================

Deno.test("gatewayCanvas: 1:1 keeps a square preset (no explicit dims)", () => {
  assertEquals(gatewayCanvas(params({ aspect_ratio: "1:1" }), false), {
    preset: "square_1024",
  });
});

Deno.test("gatewayCanvas: 16:9 maps to the largest in-bounds multiple-of-32 dims", () => {
  assertEquals(gatewayCanvas(params({ aspect_ratio: "16:9" }), false), {
    preset: "square_1024",
    width: 1024,
    height: 576,
  });
});

Deno.test("gatewayCanvas: 4:3 maps to the enrolled landscape canvas", () => {
  assertEquals(gatewayCanvas(params({ aspect_ratio: "4:3" }), false), {
    preset: "square_1024",
    width: 1152,
    height: 864,
  });
});

Deno.test("gatewayCanvas: aspect ratio overrides configured width/height", () => {
  assertEquals(
    gatewayCanvas(
      params({ aspect_ratio: "9:16", width: 1216, height: 832 }),
      false,
    ),
    { preset: "square_1024", width: 576, height: 1024 },
  );
});

Deno.test("gatewayCanvas: unknown aspect label falls through to configured shape", () => {
  assertEquals(
    gatewayCanvas(
      params({ aspect_ratio: "7:3", width: 1216, height: 832 }),
      false,
    ),
    { preset: "square_1024", width: 1216, height: 832 },
  );
});

// =============================================================================
// gatewayCanvas — configured non-square dimensions
// =============================================================================

Deno.test("gatewayCanvas: valid custom dimensions pass through", () => {
  assertEquals(gatewayCanvas(params({ width: 1216, height: 832 }), false), {
    preset: "square_1024",
    width: 1216,
    height: 832,
  });
});

Deno.test("gatewayCanvas: custom dimensions below 768 use the 512 step carrier", () => {
  assertEquals(gatewayCanvas(params({ width: 512, height: 320 }), false), {
    preset: "square_512",
    width: 512,
    height: 320,
  });
});

Deno.test("gatewayCanvas: invalid custom landscape falls back to the enrolled landscape preset", () => {
  // 1000x700: not multiples of 32 — a guaranteed rejection if sent raw.
  assertEquals(gatewayCanvas(params({ width: 1000, height: 700 }), false), {
    preset: "landscape_1152x864",
  });
});

Deno.test("gatewayCanvas: invalid custom portrait falls back to the enrolled portrait preset", () => {
  assertEquals(gatewayCanvas(params({ width: 700, height: 1000 }), false), {
    preset: "portrait_864x1152",
  });
});

Deno.test("gatewayCanvas: over-pixel custom falls back to the enrolled landscape preset", () => {
  // 1536x1024 exceeds the 1048576-pixel output cap.
  assertEquals(gatewayCanvas(params({ width: 1536, height: 1024 }), false), {
    preset: "landscape_1152x864",
  });
});

// =============================================================================
// describeGatewayHttpFailure
// =============================================================================

Deno.test("describeGatewayHttpFailure: typed gateway error renders code, retryable, message", () => {
  const body = JSON.stringify({
    error: {
      code: "invalid_image_preset",
      message: "preset must be one of square_512, square_1024",
      retryable: false,
      request_id: null,
    },
  });
  assertEquals(
    describeGatewayHttpFailure(400, body),
    "Gateway error 400 invalid_image_preset: preset must be one of square_512, square_1024",
  );
});

Deno.test("describeGatewayHttpFailure: retryable typed error carries the retryable marker", () => {
  const body = JSON.stringify({
    error: { code: "admission_busy", message: "GPU busy", retryable: true },
  });
  assertEquals(
    describeGatewayHttpFailure(409, body),
    "Gateway error 409 admission_busy (retryable): GPU busy",
  );
});

Deno.test("describeGatewayHttpFailure: HTML body is summarized, not dumped", () => {
  const html =
    "<!doctype html><html><head><title>Access denied</title></head>\n<body>Cloudflare restricted access</body></html>";
  const msg = describeGatewayHttpFailure(403, html);
  assertEquals(
    msg,
    "The gateway returned HTTP 403 with a non-JSON body: <!doctype html><html><head><title>Access denied</title></head> <body>Cloudflare restricted access</body></html>",
  );
});

Deno.test("describeGatewayHttpFailure: empty body says so", () => {
  assertEquals(
    describeGatewayHttpFailure(502, ""),
    "The gateway returned HTTP 502 with a non-JSON body: (empty body)",
  );
});
