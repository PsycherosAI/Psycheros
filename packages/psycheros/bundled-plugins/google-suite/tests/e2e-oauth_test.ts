import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { runOAuthFlow } from "../src/oauth/flow.ts";

/**
 * End-to-end OAuth flow test.
 *
 * Exercises the full plumbing:
 *   1. runOAuthFlow() generates verifier/challenge/state
 *   2. Starts a real transient HTTP listener on a test port range
 *   3. Writes oauth-flow.json with the state token (we read it back to craft
 *      a valid callback URL — simulating Google's redirect)
 *   4. Flow's exchangeCode() hits stubbed fetch and returns canned tokens
 *   5. writeRefreshToken callback fires with the captured refresh token
 *   6. Flow returns success with email + grantedScopes
 *
 * What this catches that unit tests don't:
 *   - State token threading between flow.ts → listener.ts → exchangeCode
 *   - Listener lifecycle (port binding, callback routing, shutdown)
 *   - PKCE verifier passed correctly from flow to exchangeCode
 *   - Refresh token reaches the writeRefreshToken callback
 */

const TEST_PORT_RANGE = [38501, 38502, 38503, 38504, 38505];

interface StubConfig {
  fakeAuthCode: string;
  fakeRefreshToken: string;
  fakeAccessToken: string;
  fakeEmail: string;
  fakeScopes: string[];
}

function installOAuthStubFetch(
  cfg: StubConfig,
  captured: { tokenRequestBodies: string[]; userinfoRequests: number },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const method = init?.method ?? "GET";

    if (url === "https://oauth2.googleapis.com/token" && method === "POST") {
      // Body can be a string, URLSearchParams, or other. Coerce to string
      // for assertion convenience.
      let bodyStr = "";
      if (typeof init?.body === "string") bodyStr = init.body;
      else if (init?.body instanceof URLSearchParams) {
        bodyStr = init.body.toString();
      } else if (init?.body instanceof FormData) bodyStr = "<FormData>";
      captured.tokenRequestBodies.push(bodyStr);
      return new Response(
        JSON.stringify({
          access_token: cfg.fakeAccessToken,
          refresh_token: cfg.fakeRefreshToken,
          expires_in: 3600,
          scope: cfg.fakeScopes.join(" "),
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      url === "https://www.googleapis.com/oauth2/v2/userinfo" &&
      method === "GET"
    ) {
      captured.userinfoRequests++;
      return new Response(
        JSON.stringify({ email: cfg.fakeEmail, id: "user-123" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fall through to the real fetch for everything else — this is critical
    // because the test makes a real fetch to the local callback listener.
    return await original(input as Parameters<typeof original>[0], init);
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Read the state token from <statePath>/oauth-flow.json. The flow writes
 * this file at startup for crash recovery — we use it as the source of truth
 * for what state value the listener expects.
 */
async function readFlowState(statePath: string): Promise<string> {
  const flowFile = join(statePath, "oauth-flow.json");
  for (let i = 0; i < 100; i++) {
    try {
      const raw = await Deno.readTextFile(flowFile);
      const parsed = JSON.parse(raw) as { state?: string };
      if (parsed.state) return parsed.state;
    } catch {
      // File not written yet — flow hasn't started. Retry.
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`oauth-flow.json never appeared at ${flowFile}`);
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__probe__`);
      await response.body?.cancel();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`port ${port} didn't open within ${timeoutMs}ms`);
}

Deno.test("E2E: runOAuthFlow captures code, exchanges for tokens, persists refresh token", async () => {
  const cfg: StubConfig = {
    fakeAuthCode: "test-auth-code-abc",
    fakeRefreshToken: "test-refresh-token-xyz",
    fakeAccessToken: "test-access-token-123",
    fakeEmail: "alice@example.com",
    fakeScopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  };
  const captured = { tokenRequestBodies: [] as string[], userinfoRequests: 0 };

  let writtenRefreshToken: string | undefined;
  let writeCallCount = 0;

  const restoreFetch = installOAuthStubFetch(cfg, captured);
  const statePath = await Deno.makeTempDir({ prefix: "psycheros-e2e-" });

  const flowPromise = runOAuthFlow({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    enabledServices: ["calendar"],
    statePath,
    writeRefreshToken: async (token) => {
      writtenRefreshToken = token;
      writeCallCount++;
    },
    portOverride: TEST_PORT_RANGE,
    timeoutMs: 5000,
  });

  // Wait for the flow to write oauth-flow.json AND bind the listener.
  const expectedState = await readFlowState(statePath);
  await waitForPort(TEST_PORT_RANGE[0], 1000);

  // Hit the listener with a matching state + auth code.
  const callbackUrl = `http://127.0.0.1:${
    TEST_PORT_RANGE[0]
  }/callback?code=${cfg.fakeAuthCode}&state=${expectedState}`;
  console.log("[test] callback URL:", callbackUrl);
  const callbackResponse = await fetch(callbackUrl);
  const callbackBody = await callbackResponse.text();
  console.log("[test] callback status:", callbackResponse.status);
  console.log("[test] callback body snippet:", callbackBody.slice(0, 200));
  assertEquals(callbackResponse.status, 200);
  assertStringIncludes(callbackBody, "Connected");

  const result = await flowPromise;
  restoreFetch();

  assertEquals(
    result.success,
    true,
    `flow should succeed; got error: ${result.error}`,
  );
  assertEquals(result.email, "alice@example.com");
  assertEquals(result.grantedScopes?.length, 2);
  assertStringIncludes(result.grantedScopes?.[0] ?? "", "calendar");

  assertEquals(writeCallCount, 1);
  assertEquals(writtenRefreshToken, "test-refresh-token-xyz");

  assertEquals(captured.tokenRequestBodies.length, 1);
  const tokenBody = captured.tokenRequestBodies[0];
  assertStringIncludes(tokenBody, "grant_type=authorization_code");
  assertStringIncludes(tokenBody, `code=${cfg.fakeAuthCode}`);
  assertStringIncludes(tokenBody, "code_verifier=");
  assertStringIncludes(tokenBody, "client_id=test-client-id");

  assertEquals(captured.userinfoRequests, 1);
});

Deno.test("E2E: runOAuthFlow times out when no callback arrives", async () => {
  const restoreFetch = installOAuthStubFetch(
    {
      fakeAuthCode: "ignored",
      fakeRefreshToken: "ignored",
      fakeAccessToken: "ignored",
      fakeEmail: "ignored@x.com",
      fakeScopes: [],
    },
    { tokenRequestBodies: [], userinfoRequests: 0 },
  );

  const statePath = await Deno.makeTempDir({ prefix: "psycheros-e2e-" });
  const result = await runOAuthFlow({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    enabledServices: ["calendar"],
    statePath,
    writeRefreshToken: async () => {
      throw new Error("should not be called");
    },
    portOverride: TEST_PORT_RANGE,
    timeoutMs: 200, // very short
  });
  restoreFetch();

  assertEquals(result.success, false);
  assertEquals(result.timedOut, true);
  assertStringIncludes(result.error ?? "", "timed out");
});

Deno.test("E2E: writeRefreshToken callback failure surfaces in flow result", async () => {
  const cfg: StubConfig = {
    fakeAuthCode: "test-code",
    fakeRefreshToken: "test-refresh",
    fakeAccessToken: "test-access",
    fakeEmail: "bob@example.com",
    fakeScopes: ["https://www.googleapis.com/auth/calendar"],
  };
  const captured = { tokenRequestBodies: [] as string[], userinfoRequests: 0 };
  const restoreFetch = installOAuthStubFetch(cfg, captured);

  const statePath = await Deno.makeTempDir({ prefix: "psycheros-e2e-" });
  const flowPromise = runOAuthFlow({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    enabledServices: ["calendar"],
    statePath,
    writeRefreshToken: async () => {
      throw new Error("disk full");
    },
    portOverride: TEST_PORT_RANGE,
    timeoutMs: 5000,
  });

  const expectedState = await readFlowState(statePath);
  await waitForPort(TEST_PORT_RANGE[0], 1000);
  const cbResponse = await fetch(
    `http://127.0.0.1:${
      TEST_PORT_RANGE[0]
    }/callback?code=${cfg.fakeAuthCode}&state=${expectedState}`,
  );
  await cbResponse.text();
  const result = await flowPromise;
  restoreFetch();

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "disk full");
});
