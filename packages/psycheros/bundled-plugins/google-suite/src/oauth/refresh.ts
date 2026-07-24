/**
 * OAuth token endpoint + userinfo interactions.
 *
 * `exchangeCode` runs once at the end of the OAuth flow (turns the code
 * captured by the listener into a refresh + access token). `refreshAccessToken`
 * runs whenever the cached access token has expired (lazy refresh on next
 * authenticated fetch — see GoogleClient).
 *
 * Google does NOT rotate refresh tokens for installed apps by default, but
 * the spec allows it. If a refresh response includes a new `refresh_token`,
 * callers should persist it via the `onRefreshTokenRotated` callback.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: "Bearer";
}

export interface RefreshResult {
  accessToken: string;
  /** Epoch ms when the token expires. */
  expiresAt: number;
  /** Space-split scopes from the response, if Google returned them. */
  scope?: string[];
  /** Present only on rare rotation events (Google for installed apps). */
  newRefreshToken?: string;
}

export interface ExchangeCodeOptions {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** PKCE verifier generated at flow start. */
  verifier: string;
}

export class OAuthExchangeError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthExchangeError";
  }
}

export async function exchangeCode(
  opts: ExchangeCodeOptions,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  const tokens = await postTokenEndpoint(body);
  if (!tokens.refresh_token) {
    // Google may omit refresh_token if `prompt=consent` wasn't passed or if
    // the user has already authorized this client. Without it the plugin
    // can't persist access beyond the 1-hour token lifetime — surface a
    // clear error rather than silently degrading.
    throw new OAuthExchangeError(
      "Google did not return a refresh_token. Re-run the OAuth flow; if the problem persists, revoke the app from your Google Account → Security → Third-party access and try again.",
      "missing_refresh_token",
    );
  }
  return tokens;
}

export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const tokens = await postTokenEndpoint(body);
  return {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope?.split(" "),
    newRefreshToken: tokens.refresh_token,
  };
}

export interface UserinfoResult {
  email: string;
  /** Stable user ID — useful as a stable key if we ever want to detect account switches. */
  userId?: string;
}

export async function fetchUserinfo(
  accessToken: string,
): Promise<UserinfoResult> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new OAuthExchangeError(
      `userinfo request failed: ${response.status} ${await response.text()}`,
      "userinfo_failed",
      response.status,
    );
  }
  const data = await response.json() as {
    email?: string;
    id?: string;
  };
  if (!data.email) {
    throw new OAuthExchangeError(
      "userinfo response missing email — the openid/email scope may not have been granted",
      "userinfo_no_email",
    );
  }
  return { email: data.email, userId: data.id };
}

/**
 * Best-effort token revocation. Google returns 200 on success even if the
 * token is already invalid. Failures are surfaced but not thrown — the
 * operator's intent is "disconnect locally," and a failed revoke shouldn't
 * block the UI flow.
 */
export async function revokeToken(token: string): Promise<{ ok: boolean }> {
  try {
    const response = await fetch(
      `${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "Content-Length": "0" } },
    );
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

async function postTokenEndpoint(
  body: URLSearchParams,
): Promise<OAuthTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorCode: string | undefined;
    let errorMsg: string;
    try {
      const parsed = JSON.parse(errorBody) as {
        error?: string;
        error_description?: string;
      };
      errorCode = parsed.error;
      errorMsg = parsed.error_description ?? parsed.error ?? errorBody;
    } catch {
      errorMsg = errorBody;
    }
    throw new OAuthExchangeError(
      `token endpoint ${response.status}: ${errorMsg}`,
      errorCode,
      response.status,
    );
  }

  return await response.json() as OAuthTokens;
}
