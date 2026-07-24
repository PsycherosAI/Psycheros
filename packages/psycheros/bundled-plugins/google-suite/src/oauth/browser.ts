/**
 * Cross-platform "open URL in default browser" helper.
 *
 * Used by the OAuth flow to send the operator to Google's consent screen.
 * Best-effort: if the underlying platform command fails (headless server,
 * sandbox, missing xdg-open), the caller surfaces the URL in the settings UI
 * as a clickable link so the operator can open it manually.
 *
 * Detection uses `Deno.build.os` (the documented stable API). The Windows
 * branch invokes `cmd /c start` via the shell because `start` itself isn't
 * an executable — it's a cmd builtin.
 */

export interface OpenBrowserResult {
  /** Whether the platform open command appears to have succeeded. */
  ok: boolean;
  /** The URL the caller asked to open — passed back so the UI can show a
   *  clickable link as a manual fallback. */
  fallbackUrl: string;
  /** Error message if `ok` is false. */
  error?: string;
}

export async function openBrowser(url: string): Promise<OpenBrowserResult> {
  const command = browserCommandFor(Deno.build.os);
  if (!command) {
    return {
      ok: false,
      fallbackUrl: url,
      error: `unsupported platform: ${Deno.build.os}`,
    };
  }

  try {
    const cmd = new Deno.Command(command.executable, {
      args: [...command.prefixArgs, url, ...command.suffixArgs],
      stdout: "null",
      stderr: "null",
    });
    const status = await cmd.output();
    // xdg-open exits 0 even when no default browser is configured; "ok"
    // here means the command ran, not that a browser actually opened.
    // The caller always provides a fallback link regardless.
    return { ok: status.success, fallbackUrl: url };
  } catch (error) {
    return {
      ok: false,
      fallbackUrl: url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface BrowserCommand {
  executable: string;
  prefixArgs: readonly string[];
  suffixArgs: readonly string[];
}

function browserCommandFor(
  os: typeof Deno.build.os,
): BrowserCommand | undefined {
  switch (os) {
    case "darwin":
      return { executable: "open", prefixArgs: [], suffixArgs: [] };
    case "linux":
    case "freebsd":
    case "netbsd":
    case "aix":
    case "solaris":
    case "illumos":
      return { executable: "xdg-open", prefixArgs: [], suffixArgs: [] };
    case "windows":
      // `start` is a cmd builtin, so we go through cmd.exe. Empty first arg
      // is intentional — it sets the (blank) window title, otherwise the
      // URL itself would be interpreted as the title when it contains spaces.
      return {
        executable: "cmd",
        prefixArgs: ["/c", "start", ""],
        suffixArgs: [],
      };
    default:
      return undefined;
  }
}
