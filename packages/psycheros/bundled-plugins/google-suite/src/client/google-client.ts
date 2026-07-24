/**
 * Authenticated fetch wrapper for Google APIs.
 *
 * Lazy refresh + memoization:
 *   - Access token is cached in-memory only (~1 hour lifetime).
 *   - On expired/missing token, refresh runs once; concurrent callers share
 *     the in-flight refresh via `refreshPromise`. This is critical — Google
 *     invalidates refresh tokens on concurrent reuse (RFC 6749 §10.4).
 *   - Refresh tokens are NOT rotated by Google for installed apps by default,
 *     but if a refresh response includes a new one, the optional
 *     `onRefreshTokenRotated` callback fires so the caller can persist it.
 *
 * 401 retry:
 *   - On 401, force one refresh and retry the request once. Repeated 401 → throw.
 *
 * Token state never persists across daemon restarts — only the refresh token
 * (in plugin-secrets) survives. Fresh access token is minted on first request
 * after startup.
 */

import { refreshAccessToken } from "../oauth/refresh.ts";

export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  /** Undefined until OAuth completes — `isConfigured()` reflects this. */
  refreshToken?: string;
  /**
   * Called when Google returns a new refresh_token mid-refresh. Rare for
   * installed apps but the API allows it; the caller writes the new token
   * to plugin-secrets so the next daemon start uses it.
   */
  onRefreshTokenRotated?: (newToken: string) => Promise<void>;
}

export class GoogleAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export class GoogleClient {
  private accessToken: string | undefined;
  private expiresAt = 0;
  private refreshPromise: Promise<string> | undefined;

  constructor(private opts: GoogleClientOptions) {}

  isConfigured(): boolean {
    return this.opts.refreshToken !== undefined;
  }

  /** Get a valid access token (refreshing if needed). For callers that need
   *  to make raw fetch calls without going through the client's fetch chain. */
  async getAccessToken(): Promise<string> {
    return await this.ensureAccessToken();
  }

  /** Current connected email — populated by the OAuth flow via the plugin's
   *  state file, not by the client itself. Exposed for callers that want
   *  to display connection status. */
  get refreshToken(): string | undefined {
    return this.opts.refreshToken;
  }

  /**
   * Make an authenticated request. Adds `Authorization: Bearer <access_token>`.
   * Lazily refreshes the token if missing or about to expire.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchWithRetries(url, init, 0);
    return response;
  }

  /**
   * Convenience: fetch and parse JSON. Throws GoogleAuthError on 4xx/5xx with
   * the response body included for diagnostics.
   */
  async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(url, init);
    if (!response.ok) {
      const body = await response.text();
      throw new GoogleAuthError(
        `${response.status} ${response.statusText} from ${url}: ${body}`,
        response.status,
      );
    }
    return await response.json() as T;
  }

  private async fetchWithRetries(
    url: string,
    init: RequestInit | undefined,
    attempt: number,
  ): Promise<Response> {
    const token = await this.ensureAccessToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers });

    if (response.status === 401 && attempt < 1) {
      // Force a refresh and retry once. If this 401 was a clock-skew false
      // positive, the retry succeeds. If the refresh token is revoked, the
      // refresh call throws GoogleAuthError — propagated to caller.
      this.invalidateToken();
      return this.fetchWithRetries(url, init, attempt + 1);
    }

    return response;
  }

  /**
   * Returns a valid access token, refreshing if needed. Concurrent callers
   * share the same in-flight refresh promise to avoid token-reuse races.
   */
  private async ensureAccessToken(): Promise<string> {
    // 60-second safety margin: refresh proactively before the actual expiry
    // so a slow request doesn't hit Google with a just-expired token.
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    if (!this.opts.refreshToken) {
      throw new GoogleAuthError(
        "Google Suite is not connected. Configure credentials in Settings → Plugins → Google Suite.",
      );
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<string> {
    if (!this.opts.refreshToken) {
      throw new GoogleAuthError("cannot refresh: no refresh token configured");
    }
    const result = await refreshAccessToken({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      refreshToken: this.opts.refreshToken,
    });
    this.accessToken = result.accessToken;
    this.expiresAt = result.expiresAt;

    if (
      result.newRefreshToken &&
      result.newRefreshToken !== this.opts.refreshToken
    ) {
      this.opts = { ...this.opts, refreshToken: result.newRefreshToken };
      if (this.opts.onRefreshTokenRotated) {
        try {
          await this.opts.onRefreshTokenRotated(result.newRefreshToken);
        } catch (error) {
          console.warn(
            `[google-suite] onRefreshTokenRotated callback failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    return this.accessToken;
  }

  /** Force next request to refresh the token. Called on 401. */
  private invalidateToken(): void {
    this.accessToken = undefined;
    this.expiresAt = 0;
  }
}
