/**
 * OAuth flow orchestrator — wires together PKCE generation, the transient
 * callback listener, browser-open, and the token endpoint exchange.
 *
 * Single entry point: `runOAuthFlow(opts)` returns success/failure with the
 * connected email + granted scopes. The caller persists the refresh token
 * via the `writeRefreshToken` callback (so it goes to the right secrets file
 * via PluginManager.services.writeSecret, not direct file I/O).
 */

import { join } from "@std/path";
import { computeCodeChallenge, generateCodeVerifier } from "./pkce.ts";
import { OAuthTimeoutError, startCallbackListener } from "./listener.ts";
import { openBrowser } from "./browser.ts";
import { buildScopeString, type ServiceId } from "./scopes.ts";
import { exchangeCode, fetchUserinfo } from "./refresh.ts";

export interface OAuthFlowResult {
  success: boolean;
  email?: string;
  /** Scopes Google actually granted — should match requested but may be a
   *  subset if the user edited permissions during consent. */
  grantedScopes?: string[];
  error?: string;
  /** Set when the failure was a timeout vs. some other error — lets the UI
   *  show a more specific message. */
  timedOut?: boolean;
}

export interface RunOAuthFlowOptions {
  clientId: string;
  clientSecret: string;
  enabledServices: readonly ServiceId[];
  /**
   * Plugin statePath — used to persist `oauth-flow.json` for crash recovery.
   * If the daemon dies mid-flow, the next startup can detect the orphaned
   * file and surface a warning (operator can clean up by deleting it).
   */
  statePath: string;
  /**
   * Persists the captured refresh token to the plugin's secrets file. Caller
   * is PluginManager.services.writeSecret, which validates the name prefix.
   */
  writeRefreshToken: (token: string) => Promise<void>;
  /** Override for testing — production callers should omit. */
  portOverride?: readonly number[];
  /** Override for testing — production callers should omit. */
  timeoutMs?: number;
}

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export async function runOAuthFlow(
  opts: RunOAuthFlowOptions,
): Promise<OAuthFlowResult> {
  const verifier = generateCodeVerifier();
  const challenge = await computeCodeChallenge(verifier);
  const state = crypto.randomUUID();
  const scopes = buildScopeString(opts.enabledServices);

  // Persist flow state for crash recovery. Just enough to detect an orphaned
  // flow on next startup — we don't actually use it to resume the flow.
  const flowFile = join(opts.statePath, "oauth-flow.json");
  try {
    await Deno.mkdir(opts.statePath, { recursive: true });
    await Deno.writeTextFile(
      flowFile,
      JSON.stringify({
        state,
        startedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.warn(
      `[google-suite] could not write oauth-flow.json for crash recovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let listenerHandle;
  try {
    listenerHandle = await startCallbackListener({
      expectedState: state,
      ports: opts.portOverride,
      timeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const redirectUri = `http://127.0.0.1:${listenerHandle.port}/callback`;
  const authUrl = new URL(GOOGLE_AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", opts.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
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

  const browserResult = await openBrowser(authUrl.toString());
  if (!browserResult.ok) {
    console.warn(
      `[google-suite] could not auto-open browser: ${
        browserResult.error ?? "unknown error"
      }. Operator must open the URL manually.`,
    );
    // Don't abort — the operator may have a headless setup and will open
    // the URL from the settings UI's clickable link.
  }

  try {
    const { code, state: receivedState } = await listenerHandle.waitForCode();
    if (receivedState !== state) {
      return {
        success: false,
        error:
          "OAuth state mismatch — possible CSRF attack or stale browser tab. Flow aborted.",
      };
    }

    const tokens = await exchangeCode({
      code,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri,
      verifier,
    });

    const userinfo = await fetchUserinfo(tokens.access_token);

    await opts.writeRefreshToken(tokens.refresh_token!);

    return {
      success: true,
      email: userinfo.email,
      grantedScopes: tokens.scope?.split(" ") ?? [scopes],
    };
  } catch (error) {
    if (error instanceof OAuthTimeoutError) {
      return {
        success: false,
        timedOut: true,
        error:
          "OAuth flow timed out after 5 minutes. Restart the flow from Settings → Plugins → Google Suite → Configure.",
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await listenerHandle.shutdown();
    try {
      await Deno.remove(flowFile);
    } catch {
      // Already gone or never written — non-fatal.
    }
  }
}
