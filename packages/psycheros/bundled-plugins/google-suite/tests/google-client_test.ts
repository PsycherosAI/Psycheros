import { assertEquals, assertRejects } from "@std/assert";
import { GoogleAuthError, GoogleClient } from "../src/client/google-client.ts";

/**
 * Mock fetch with a stateful call counter. The test stubs globalThis.fetch
 * to track how many refresh-token requests actually fire — concurrent
 * callers of GoogleClient.fetch() during an expired-token window should
 * share one in-flight refresh (memoized promise), per the critical
 * invariant in google-client.ts.
 */

interface MockState {
  refreshCallCount: number;
  apiCallCount: number;
  /** What the next refresh response should look like. */
  nextRefreshResponse: {
    access_token: string;
    expires_in: number;
    scope?: string;
    refresh_token?: string;
  };
  /** Status to return for the API call. */
  nextApiStatus: number;
  /** Body to return for the API call. */
  nextApiBody: string;
}

function defaultMockState(): MockState {
  return {
    refreshCallCount: 0,
    apiCallCount: 0,
    nextRefreshResponse: {
      access_token: "fresh-access-token",
      expires_in: 3600,
    },
    nextApiStatus: 200,
    nextApiBody: "{}",
  };
}

function installMockFetch(state: MockState): () => void {
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

    // Token endpoint — refresh access_token.
    if (url === "https://oauth2.googleapis.com/token" && method === "POST") {
      state.refreshCallCount++;
      return new Response(JSON.stringify(state.nextRefreshResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Otherwise it's an API call.
    state.apiCallCount++;
    return new Response(state.nextApiBody, {
      status: state.nextApiStatus,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("GoogleClient refreshes lazily on first fetch after construction", async () => {
  const state = defaultMockState();
  const restore = installMockFetch(state);
  try {
    const client = new GoogleClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
    });
    assertEquals(state.refreshCallCount, 0);
    await client.fetch("https://example.com/api");
    assertEquals(state.refreshCallCount, 1);
    assertEquals(state.apiCallCount, 1);
  } finally {
    restore();
  }
});

Deno.test("GoogleClient memoizes refresh — 5 concurrent fetches hit refresh exactly once", async () => {
  // Critical invariant: Google invalidates refresh tokens on concurrent reuse
  // (RFC 6749 §10.4). The client MUST coalesce concurrent refresh attempts.
  const state = defaultMockState();
  const restore = installMockFetch(state);
  try {
    const client = new GoogleClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
    });

    // Fire 5 concurrent fetches. Without memoization, each would refresh
    // independently and Google would invalidate the token on the 2nd call.
    const results = await Promise.all([
      client.fetch("https://example.com/api/1"),
      client.fetch("https://example.com/api/2"),
      client.fetch("https://example.com/api/3"),
      client.fetch("https://example.com/api/4"),
      client.fetch("https://example.com/api/5"),
    ]);

    assertEquals(results.length, 5);
    assertEquals(state.refreshCallCount, 1);
    assertEquals(state.apiCallCount, 5);
  } finally {
    restore();
  }
});

Deno.test("GoogleClient retries once on 401, refreshing the token", async () => {
  // First API call returns 401 (token revoked server-side or clock skew).
  // Client should force a refresh and retry. Second call returns 200.
  const state = defaultMockState();
  state.nextApiStatus = 401;
  state.nextApiBody = '{"error": "invalid_token"}';

  // We need to flip the response after the first attempt — track call count.
  let firstCallSeen = false;
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
      state.refreshCallCount++;
      return new Response(JSON.stringify(state.nextRefreshResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    state.apiCallCount++;
    if (!firstCallSeen) {
      firstCallSeen = true;
      return new Response(state.nextApiBody, { status: 401 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const client = new GoogleClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
    });
    const response = await client.fetch("https://example.com/api");
    assertEquals(response.status, 200);
    // Two refreshes: initial lazy refresh + forced refresh after 401.
    assertEquals(state.refreshCallCount, 2);
    assertEquals(state.apiCallCount, 2);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("GoogleClient rejects fetch when no refresh token configured", async () => {
  const state = defaultMockState();
  const restore = installMockFetch(state);
  try {
    const client = new GoogleClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      // No refreshToken
    });
    assertEquals(client.isConfigured(), false);
    await assertRejects(
      () => client.fetch("https://example.com/api"),
      GoogleAuthError,
      "not connected",
    );
    assertEquals(state.refreshCallCount, 0);
  } finally {
    restore();
  }
});

Deno.test("GoogleClient fires onRefreshTokenRotated when Google returns a new refresh token", async () => {
  const state = defaultMockState();
  state.nextRefreshResponse = {
    access_token: "fresh",
    expires_in: 3600,
    refresh_token: "rotated-refresh-token", // Google returned a new one
  };

  const restore = installMockFetch(state);
  let observedNewToken: string | undefined;
  try {
    const client = new GoogleClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "original-refresh",
      async onRefreshTokenRotated(newToken) {
        observedNewToken = newToken;
      },
    });
    await client.fetch("https://example.com/api");
    assertEquals(observedNewToken, "rotated-refresh-token");
  } finally {
    restore();
  }
});

Deno.test("GoogleClient.fetchJson throws GoogleAuthError on non-2xx with body for diagnostics", async () => {
  const state = defaultMockState();
  state.nextApiStatus = 403;
  state.nextApiBody = '{"error": "forbidden"}';
  const restore = installMockFetch(state);
  try {
    const client = new GoogleClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
    });
    await assertRejects(
      () => client.fetchJson("https://example.com/api"),
      GoogleAuthError,
      "403",
    );
    // Body content surfaces in the message for diagnostics.
    await assertRejects(
      () => client.fetchJson("https://example.com/api"),
      GoogleAuthError,
      "forbidden",
    );
  } finally {
    restore();
  }
});
