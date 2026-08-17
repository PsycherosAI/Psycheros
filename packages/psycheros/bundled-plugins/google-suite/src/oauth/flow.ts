/**
 * OAuth flow — two-phase design for headless/containerized Psycheros.
 *
 * Phase 1 (`prepareAuthUrl`): generates PKCE verifier + challenge, builds the
 * Google consent URL, and persists flow state to `oauth-flow.json` for crash
 * recovery. Returns the URL for the caller to surface as a clickable link.
 *
 * Phase 2 (`completeFlow`): called when Google redirects back to our server
 * callback (`/api/plugins/google-suite/oauth-callback`). Exchanges the code for
 * tokens and returns the result. The caller (routes.ts) persists the refresh
 * token.
 *
 * This replaces the original loopback-listener design, which broke in
 * containerized setups: `xdg-open` can't open a browser inside a headless
 * container, and `127.0.0.1:8765` inside the container is unreachable from the
 * operator's browser. The callback now routes through Psycheros's own web
 * server (port 3000), which the operator can actually reach.
 */

import { join } from "@std/path";
import { computeCodeChallenge, generateCodeVerifier } from "./pkce.ts";
import { exchangeCode, fetchUserinfo } from "./refresh.ts";
import { buildScopeString, type ServiceId } from "./scopes.ts";

export interface OAuthFlowResult {
  success: boolean;
  email?: string;
  /** Scopes Google actually granted — should match requested but may be a
   *  subset if the user edited permissions during consent. */
  grantedScopes?: string[];
  error?: string;
}

export interface PrepareAuthUrlOptions {
  clientId: string;
  enabledServices: readonly ServiceId[];
  /**
   * Plugin statePath — used to persist `oauth-flow.json` for crash recovery
   * and to carry PKCE state between prepareAuthUrl() and completeFlow().
   */
  statePath: string;
  /**
   * The redirect URI Google should send the callback to. This is the
   * Psycheros server's own callback endpoint, e.g.
   * `https://echo.example.com/api/plugins/google-suite/oauth-callback`.
   * Passed in by routes.ts from the incoming request's origin.
   */
  redirectUri: string;
}

export interface PreparedFlow {
  authUrl: string;
  state: string;
}

/** Phase 1: build the Google consent URL with PKCE + state. */
export async function prepareAuthUrl(
  opts: PrepareAuthUrlOptions,
): Promise<PreparedFlow> {
  const verifier = generateCodeVerifier();
  const challenge = await computeCodeChallenge(verifier);
  const state = crypto.randomUUID();
  const scopes = buildScopeString(opts.enabledServices);

  // Persist flow state: PKCE verifier + state for the callback exchange,
  // plus a timestamp for crash-recovery detection on next startup.
  const flowFile = join(opts.statePath, "oauth-flow.json");
  await Deno.mkdir(opts.statePath, { recursive: true });
  await Deno.writeTextFile(
    flowFile,
    JSON.stringify({
      state,
      verifier,
      redirectUri: opts.redirectUri,
      clientId: opts.clientId,
      startedAt: new Date().toISOString(),
    }),
  );

  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", opts.clientId);
  authUrl.searchParams.set("redirect_uri", opts.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  // access_type=offline + prompt=consent are REQUIRED to get a refresh_token
  // from Google. Without prompt=consent, Google may skip issuing a refresh
  // token on subsequent flows for an already-authorized user.
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  return { authUrl: authUrl.toString(), state };
}

export interface CompleteFlowOptions {
  /** Authorization code from Google's callback redirect. */
  code: string;
  /** State parameter from Google's callback — must match what we stored. */
  state: string;
  /** Client secret for the token exchange. */
  clientSecret: string;
  /** Plugin statePath — reads oauth-flow.json for verifier + redirectUri. */
  statePath: string;
  /** Persists the captured refresh token to the plugin's secrets file. */
  writeRefreshToken: (token: string) => Promise<void>;
}

/**
 * Phase 2: exchange the callback code for tokens. Reads PKCE verifier +
 * redirect URI from the persisted flow state, validates the state parameter,
 * exchanges the code, fetches userinfo, and persists the refresh token.
 *
 * Throws on: state mismatch, missing/expired flow state, token exchange
 * failure, or missing refresh token in the response.
 */
export async function completeFlow(
  opts: CompleteFlowOptions,
): Promise<OAuthFlowResult> {
  const flowFile = join(opts.statePath, "oauth-flow.json");
  let flowData: {
    state: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    startedAt: string;
  };

  try {
    const raw = await Deno.readTextFile(flowFile);
    flowData = JSON.parse(raw);
  } catch {
    return {
      success: false,
      error:
        "No OAuth flow in progress. Start the flow from Settings → Plugins → Google Suite → Connect Account.",
    };
  }

  if (opts.state !== flowData.state) {
    return {
      success: false,
      error:
        "OAuth state mismatch — possible CSRF attack or stale browser tab. Flow aborted.",
    };
  }

  const tokens = await exchangeCode({
    code: opts.code,
    clientId: flowData.clientId,
    clientSecret: opts.clientSecret,
    redirectUri: flowData.redirectUri,
    verifier: flowData.verifier,
  });

  const userinfo = await fetchUserinfo(tokens.access_token);

  await opts.writeRefreshToken(tokens.refresh_token!);

  // Clean up the flow state file.
  try {
    await Deno.remove(flowFile);
  } catch {
    // Already gone — non-fatal.
  }

  return {
    success: true,
    email: userinfo.email,
    grantedScopes: tokens.scope?.split(" ") ?? [],
  };
}

/**
 * Clear persisted flow state (if any) — called on disconnect or when a stale
 * flow is detected on startup.
 */
export async function clearFlowState(statePath: string): Promise<void> {
  const flowFile = join(statePath, "oauth-flow.json");
  try {
    await Deno.remove(flowFile);
  } catch {
    // Already gone — non-fatal.
  }
}

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
