/**
 * Shared helpers for the Psycheros accessibility browser specs.
 *
 * These specs need a running server (BASE_URL, default http://127.0.0.1:7780)
 * and a Playwright Chromium. They are deliberately NOT part of `deno task
 * test` / CI - see ../README.md.
 */
import { createRequire } from "node:module";
import process from "node:process";

export const BASE = process.env.BASE_URL ?? "http://127.0.0.1:7780";
export const CONV = process.env.CONV ?? "";

export async function launch() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    // Container images that preinstall Playwright keep it outside node's
    // default resolution path.
    ({ chromium } = createRequire("/usr/lib/node_modules/")("playwright"));
  }
  return await chromium.launch({ args: ["--no-sandbox"] });
}

/** Navigate to a chat view and wait for the app to be interactive. */
export async function openChat(page) {
  await page.goto(CONV ? `${BASE}/c/${CONV}` : BASE, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#message-input", { timeout: 20000 });
  await page.waitForFunction(() => !!globalThis.Psycheros, null, {
    timeout: 20000,
  });
}

/** Load the entity-core graph fragment into #chat. */
export async function openGraph(page) {
  await page.evaluate(() =>
    htmx.ajax("GET", "/fragments/settings/entity-core/graph", {
      target: "#chat",
      swap: "innerHTML",
    })
  );
  await page.waitForSelector("#gv-view-toggle", { timeout: 20000 });
}

/** Describe the currently focused element, for failure messages. */
export async function activeElement(page) {
  return await page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? null,
      id: a?.id ?? null,
      cls: typeof a?.className === "string" ? a.className : "",
      label: (a?.getAttribute?.("aria-label") || a?.textContent || "")
        .trim().slice(0, 60),
    };
  });
}

/** Collect named pass/fail lines and set a non-zero exit code on failure. */
export function makeReport(name) {
  const results = [];
  return {
    check(label, ok, detail) {
      results.push({ label, ok: !!ok });
      console.log(
        `${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`,
      );
    },
    skip(label, why) {
      console.log(`skip ${label} - ${why}`);
    },
    done() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(
        `\n${name}: ${
          failed ? `${failed} failure(s)` : "PASS"
        } (${results.length} checks)`,
      );
      if (failed) process.exitCode = 1;
    },
  };
}
