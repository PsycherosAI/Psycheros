import { assertEquals, assertStringIncludes } from "@std/assert";
import { completeFlow, prepareAuthUrl } from "../src/oauth/flow.ts";

/**
 * End-to-end OAuth flow test — two-phase API.
 *
 * Exercises the full plumbing:
 *   1. prepareAuthUrl() generates verifier/challenge/state, writes oauth-flow.json
 *   2. Test reads the state token from oauth-flow.json
 *   3. completeFlow() is called with the code + state — exchanges for tokens
 *   4. writeRefreshToken callback fires with the captured refresh token
 *   5. Returns success with email + grantedScopes
 */

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

    return await original(input as Parameters<typeof original>[0], init);
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("E2E: prepareAuthUrl + completeFlow captures code, exchanges for tokens", async () => {
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

  // Phase 1: prepare the auth URL
  const redirectUri =
    "https://example.com/api/plugins/google-suite/oauth-callback";
  const prepared = await prepareAuthUrl({
    clientId: "test-client-id",
    enabledServices: ["calendar"],
    statePath,
    redirectUri,
  });

  assertStringIncludes(prepared.authUrl, "accounts.google.com");
  assertStringIncludes(prepared.authUrl, "client_id=test-client-id");
  assertStringIncludes(prepared.authUrl, "code_challenge_method=S256");

  // Phase 2: complete the flow with the code + state
  const result = await completeFlow({
    code: cfg.fakeAuthCode,
    state: prepared.state,
    clientSecret: "test-client-secret",
    statePath,
    writeRefreshToken: async (token) => {
      writtenRefreshToken = token;
      writeCallCount++;
    },
  });

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

Deno.test("E2E: completeFlow rejects mismatched state", async () => {
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
  await prepareAuthUrl({
    clientId: "test-client-id",
    enabledServices: ["calendar"],
    statePath,
    redirectUri: "https://example.com/api/plugins/google-suite/oauth-callback",
  });

  const result = await completeFlow({
    code: "some-code",
    state: "wrong-state",
    clientSecret: "test-client-secret",
    statePath,
    writeRefreshToken: async () => {
      throw new Error("should not be called");
    },
  });

  restoreFetch();

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "state mismatch");
});

Deno.test("E2E: completeFlow rejects when no flow state exists", async () => {
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

  const result = await completeFlow({
    code: "some-code",
    state: "some-state",
    clientSecret: "test-client-secret",
    statePath,
    writeRefreshToken: async () => {
      throw new Error("should not be called");
    },
  });

  restoreFetch();

  assertEquals(result.success, false);
  assertStringIncludes(result.error ?? "", "No OAuth flow in progress");
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
  const prepared = await prepareAuthUrl({
    clientId: "test-client-id",
    enabledServices: ["calendar"],
    statePath,
    redirectUri: "https://example.com/api/plugins/google-suite/oauth-callback",
  });

  // completeFlow should throw on writeRefreshToken failure
  let caughtError: Error | undefined;
  try {
    await completeFlow({
      code: cfg.fakeAuthCode,
      state: prepared.state,
      clientSecret: "test-client-secret",
      statePath,
      writeRefreshToken: async () => {
        throw new Error("disk full");
      },
    });
  } catch (error) {
    caughtError = error as Error;
  }

  restoreFetch();

  assertStringIncludes(caughtError?.message ?? "", "disk full");
});
