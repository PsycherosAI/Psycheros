import { assertEquals, assertRejects } from "@std/assert";
import {
  type CallbackListenerHandle,
  OAuthTimeoutError,
  startCallbackListener,
} from "../src/oauth/listener.ts";

/**
 * Pick a port range outside the standard 8765-8785 to avoid collisions with
 * concurrent test runs or any local dev server on those ports. Use a unique
 * range per test by deriving from process pid + test counter.
 */
function uniquePortRange(): number[] {
  // Use a high range unlikely to collide with anything. The listener tries
  // each port in order; for tests we only need one to bind.
  const base = 38000 + (Deno.pid % 1000) * 10;
  return [base, base + 1, base + 2, base + 3, base + 4];
}

Deno.test("callback listener captures code + state from a matching callback", async () => {
  const ports = uniquePortRange();
  const expectedState = crypto.randomUUID();
  const handle: CallbackListenerHandle = await startCallbackListener({
    expectedState,
    ports,
    timeoutMs: 5000,
  });
  try {
    // Hit the listener with the expected state.
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/callback?code=test-code-123&state=${expectedState}`,
    );
    assertEquals(response.status, 200);
    const body = await response.text();
    assertEquals(body.includes("Connected"), true);

    // waitForCode resolves with the captured values.
    const captured = await handle.waitForCode();
    assertEquals(captured.code, "test-code-123");
    assertEquals(captured.state, expectedState);
  } finally {
    await handle.shutdown();
  }
});

Deno.test("callback listener rejects callbacks with wrong state (CSRF defense)", async () => {
  const ports = uniquePortRange();
  const expectedState = crypto.randomUUID();
  const handle = await startCallbackListener({
    expectedState,
    ports,
    timeoutMs: 2000,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/callback?code=attacker-code&state=wrong-state`,
    );
    const body = await response.text();
    // Browser sees a 400 with an error page. Listener stays alive.
    assertEquals(response.status, 400);
    assertEquals(body.includes("state_mismatch"), true);
  } finally {
    await handle.shutdown();
  }
});

Deno.test("callback listener returns 404 for non-callback paths", async () => {
  const ports = uniquePortRange();
  const handle = await startCallbackListener({
    expectedState: "ignored",
    ports,
    timeoutMs: 2000,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/not-a-callback-path`,
    );
    const body = await response.text();
    assertEquals(response.status, 404);
    // Drain body so Deno's leak detector doesn't flag the unconsumed stream.
    void body;
  } finally {
    await handle.shutdown();
  }
});

Deno.test("callback listener times out and rejects waitForCode after timeoutMs", async () => {
  const ports = uniquePortRange();
  const handle = await startCallbackListener({
    expectedState: "never-arrives",
    ports,
    timeoutMs: 200, // short timeout
  });
  try {
    await assertRejects(
      () => handle.waitForCode(),
      OAuthTimeoutError,
    );
  } finally {
    await handle.shutdown();
  }
});

Deno.test("callback listener surfaces Google error params to the browser", async () => {
  const ports = uniquePortRange();
  const handle = await startCallbackListener({
    expectedState: "ignored-here",
    ports,
    timeoutMs: 2000,
  });
  try {
    // User denied consent — Google redirects with ?error=access_denied.
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/callback?error=access_denied&error_description=user+cancelled`,
    );
    assertEquals(response.status, 200);
    const body = await response.text();
    assertEquals(body.includes("access_denied"), true);
    assertEquals(body.includes("user cancelled"), true);
  } finally {
    await handle.shutdown();
  }
});
