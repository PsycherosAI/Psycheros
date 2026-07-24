/**
 * Transient HTTP listener for capturing OAuth callback redirects.
 *
 * Lifecycle:
 *   const handle = await startCallbackListener({ expectedState });
 *   // ... browser opens, Google redirects to http://127.0.0.1:<port>/callback
 *   const { code, state } = await handle.waitForCode();
 *   await handle.shutdown();
 *
 * The listener tries ports 8765-8785 in order (per RFC 8252 §7.3 — loopback
 * redirect URIs for native apps). First successful bind wins; if all are in
 * use, throws with a clear error.
 *
 * Auto-shutdown:
 *   - On successful callback: handler resolves waitForCode, caller shuts down.
 *   - On timeout (default 5 min): waitForCode rejects with OAuthTimeoutError,
 *     listener self-shuts.
 *
 * Wrong-state callbacks are logged and rejected (HTTP 400 response) but do
 * NOT shut down the listener — operator may have hit the wrong consent flow
 * or this is a CSRF attempt; either way, we stay alive for the legit callback.
 */

export const CALLBACK_PORT_RANGE = [
  8765,
  8766,
  8767,
  8768,
  8769,
  8770,
  8771,
  8772,
  8773,
  8774,
  8775,
  8776,
  8777,
  8778,
  8779,
  8780,
  8781,
  8782,
  8783,
  8784,
  8785,
] as const;

export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CallbackListenerHandle {
  port: number;
  /**
   * Resolve with the captured { code, state } on successful callback.
   * Reject with OAuthTimeoutError on timeout, or OAuthListenerError if the
   * listener crashes mid-flow.
   */
  waitForCode(): Promise<{ code: string; state: string }>;
  /** Stop the HTTP listener. Safe to call multiple times. */
  shutdown(): Promise<void>;
}

export class OAuthTimeoutError extends Error {
  constructor(message = "OAuth callback timed out") {
    super(message);
    this.name = "OAuthTimeoutError";
  }
}

export class OAuthListenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthListenerError";
  }
}

export interface StartCallbackListenerOptions {
  expectedState: string;
  timeoutMs?: number;
  /**
   * Optional override for the port range — primarily for testing where we
   * want predictable ports. Production callers should omit this.
   */
  ports?: readonly number[];
}

export async function startCallbackListener(
  opts: StartCallbackListenerOptions,
): Promise<CallbackListenerHandle> {
  const ports = opts.ports ?? CALLBACK_PORT_RANGE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  let resolveCode: (value: { code: string; state: string }) => void;
  let rejectCode: (error: Error) => void;
  const codePromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    },
  );

  // Try each port in turn until one binds.
  let server: Deno.HttpServer | undefined;
  let boundPort: number | undefined;
  const errors: string[] = [];
  for (const port of ports) {
    try {
      server = Deno.serve(
        {
          port,
          hostname: "127.0.0.1",
          onListen: () => {
            boundPort = port;
          },
        },
        (req) => handleCallback(req, opts.expectedState, resolveCode!),
      );
      // Wait for onListen to confirm the bind before continuing.
      // Deno.serve resolves its returned promise on completion; we test the
      // bind by checking if the instance is created without throwing.
      boundPort = port;
      break;
    } catch (error) {
      errors.push(
        `port ${port}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!server || boundPort === undefined) {
    throw new OAuthListenerError(
      `could not bind any callback port in [${ports[0]}..${
        ports[ports.length - 1]
      }]: ${errors.join("; ")}`,
    );
  }

  const port = boundPort;
  const timeoutHandle = setTimeout(() => {
    rejectCode!(new OAuthTimeoutError());
    shutdownServer(server!, port);
  }, timeoutMs);

  return {
    port,
    waitForCode: () => codePromise,
    async shutdown() {
      clearTimeout(timeoutHandle);
      await shutdownServer(server!, port);
    },
  };
}

async function shutdownServer(
  server: Deno.HttpServer,
  _port: number,
): Promise<void> {
  try {
    await server.shutdown();
  } catch {
    // Already shut down or never fully bound — non-fatal.
  }
}

function handleCallback(
  req: Request,
  expectedState: string,
  resolveCode: (value: { code: string; state: string }) => void,
): Response {
  const url = new URL(req.url);
  if (url.pathname !== "/callback") {
    return new Response("Not Found", { status: 404 });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    // Google returned an OAuth error (user denied, etc.) — surface to the
    // browser so the operator sees it in the tab.
    const errorDesc = url.searchParams.get("error_description") ?? "";
    return new Response(
      renderErrorPage(error, errorDesc),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  if (state !== expectedState) {
    console.warn(
      `[google-suite] OAuth callback state mismatch: expected ${expectedState}, got ${state}. Possible CSRF — callback ignored.`,
    );
    return new Response(
      renderErrorPage(
        "state_mismatch",
        "The state parameter did not match what we expected. This may indicate a CSRF attempt or a stale browser tab. Close this window and try again.",
      ),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  resolveCode({ code, state });

  return new Response(
    renderSuccessPage(),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function renderSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Connected</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 4rem 1rem; color: #1a1a1a; }
    h1 { font-weight: 500; }
    .check { font-size: 4rem; color: #22c55e; }
  </style>
</head>
<body>
  <div class="check">✓</div>
  <h1>Connected</h1>
  <p>You can close this tab and return to Psycheros.</p>
</body>
</html>`;
}

function renderErrorPage(error: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Connection failed</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 4rem 1rem; color: #1a1a1a; }
    h1 { font-weight: 500; }
    .x { font-size: 4rem; color: #ef4444; }
    code { background: #f3f4f6; padding: 0.2em 0.4em; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="x">×</div>
  <h1>Connection failed</h1>
  <p>Google returned an error: <code>${escapeHtml(error)}</code></p>
  ${description ? `<p>${escapeHtml(description)}</p>` : ""}
  <p>Close this tab and try again from Psycheros.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
