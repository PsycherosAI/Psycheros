/**
 * WCAG 2.1.1 / 4.1.2: Flux entry edit controls are reachable by Tab, become
 * visible when focused, and carry an action name instead of the pencil glyph.
 *
 * Two surfaces: the standalone Flux Space page (fixture render) and the
 * overlay mounted on a live conversation.
 */
import { readFileSync } from "node:fs";
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const spaceHtml = readFileSync(
  new URL("../fixtures/flux-space.html", import.meta.url),
  "utf8",
);
const overlayHtml = readFileSync(
  new URL("../fixtures/flux-overlay.html", import.meta.url),
  "utf8",
);
const report = makeReport("Flux edit controls");
const browser = await launch();

/**
 * Focus the tab stop immediately before `selector`, then let the caller press
 * Tab. Returns whether the target is focusable at all (display:none controls
 * are not).
 */
async function focusPredecessor(page, selector) {
  return await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) return { found: false };
    const candidates = Array.from(document.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter((el) => {
      if (el.disabled || el.closest("[inert]")) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    });
    const index = candidates.indexOf(target);
    if (index < 0) return { found: true, tabbable: false };
    const predecessor = index > 0 ? candidates[index - 1] : document.body;
    predecessor.focus();
    return {
      found: true,
      tabbable: true,
      from: predecessor.id || predecessor.className || predecessor.tagName,
    };
  }, selector);
}

async function tabInto(page, selector) {
  const start = await focusPredecessor(page, selector);
  if (!start.found || !start.tabbable) return { ...start, reached: false };
  await page.keyboard.press("Tab");
  return {
    ...start,
    reached: await page.evaluate(
      (sel) => document.activeElement === document.querySelector(sel),
      selector,
    ),
    opacity: await page.evaluate(async (sel) => {
      const el = document.querySelector(sel);
      if (!el) return "";
      // The overlay fades the control in; let the transition settle.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return getComputedStyle(el).opacity;
    }, selector),
  };
}

try {
  // --- Standalone Flux Space page ---------------------------------------
  const space = await browser.newPage();
  await space.setContent(
    spaceHtml.replace(
      "<head>",
      "<head>" +
        `<script>
        globalThis.marked = { setOptions() {}, parse: (text) => text || "" };
        globalThis.DOMPurify = { sanitize: (text) => text || "" };
        globalThis.EventSource = class {
          constructor() { this.handlers = {}; globalThis.__fluxEvents = this; }
          addEventListener(type, handler) {
            (this.handlers[type] ??= []).push(handler);
          }
          close() {}
        };
        (() => {
          const json = (body) => Promise.resolve(new Response(
            JSON.stringify(body),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ));
          const durable = [
            { id: "u1", role: "user", content: "durable user entry",
              timestamp: "2026-11-11T10:00:00.000Z" },
            { id: "e1", role: "entity", content: "durable entity entry",
              timestamp: "2026-11-11T10:00:01.000Z" },
          ];
          globalThis.fetch = (input) => {
            const url = typeof input === "string" ? input : input.url;
            if (url.startsWith("/api/flux/entries")) return json(durable);
            if (url === "/api/flux/session") return json([]);
            if (url === "/api/flux/status") return json({ state: "running" });
            return json({});
          };
        })();
        </script>`,
    ),
    { waitUntil: "load" },
  );
  await space.waitForFunction(
    () => document.querySelectorAll("#flux-timeline .flux-entry").length >= 2,
    null,
    { timeout: 5000 },
  );

  const userTab = await tabInto(
    space,
    "#flux-timeline .flux-entry.user .flux-edit-btn",
  );
  report.check(
    "a Tab press reaches the user entry edit control",
    userTab.reached,
    JSON.stringify(userTab),
  );
  report.check(
    "the focused user edit control becomes visible",
    userTab.reached && userTab.opacity === "1",
    JSON.stringify(userTab),
  );

  const entityName = await space.getByRole("button", {
    name: "Edit entity entry",
  })
    .count();
  report.check(
    "the entity edit control is named by its action",
    entityName === 1,
    `buttons named Edit entity entry: ${entityName}`,
  );
  const userName = await space.getByRole("button", { name: "Edit your entry" })
    .count();
  report.check(
    "the user edit control is named by its action",
    userName === 1,
    `buttons named Edit your entry: ${userName}`,
  );

  // --- Overlay on a live conversation -----------------------------------
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await openChat(page);
  await page.evaluate(async () => {
    await Psycheros.newConversation();
  });
  await page.waitForSelector("#message-input", { timeout: 10000 });
  const convId = await page.evaluate(() =>
    location.pathname.split("/").filter(Boolean).pop()
  );
  const fragmentForConversation = overlayHtml.replace(
    '"conv-1"',
    JSON.stringify(convId),
  );
  await page.evaluate((html) => {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.__probeFetched = [];
    const json = (body) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      globalThis.__probeFetched.push(url);
      if (url === "/api/flux/start") return json({ ok: true });
      if (url === "/api/flux/status") return json({ state: "running" });
      if (url.startsWith("/api/flux/entries")) return json([]);
      if (url === "/api/flux/session") {
        return json([{
          id: "session-user-1",
          messageId: "msg-user-1",
          kind: "user",
          fromMessages: true,
          content: "editable overlay entry",
          timestamp: "2026-11-11T10:00:02.000Z",
        }]);
      }
      if (url.startsWith("/fragments/flux/")) {
        return Promise.resolve(
          new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
        );
      }
      return realFetch(input, init);
    };
  }, fragmentForConversation);
  await page.evaluate(async () => {
    await Psycheros.startFluxOverlay();
  });
  try {
    await page.waitForSelector("#flux-timeline .msg-edit-btn", {
      timeout: 10000,
    });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      overlay: !!document.getElementById("flux-overlay"),
      timeline: document.getElementById("flux-timeline")?.innerHTML ??
        "missing",
      fetched: globalThis.__probeFetched ?? null,
      errors: globalThis.__probeErrors ?? null,
    }));
    console.error(
      "edit control did not render:",
      JSON.stringify({ ...diagnostic, pageErrors }),
    );
    throw error;
  }

  const overlayName = await page.getByRole("button", {
    name: "Edit your message",
  }).count();
  report.check(
    "the overlay edit control is named by its action",
    overlayName === 1,
    `buttons named Edit your message: ${overlayName}`,
  );
  const svgHidden = await page.evaluate(() =>
    document.querySelector("#flux-timeline .msg-edit-btn svg")
      ?.getAttribute("aria-hidden")
  );
  report.check(
    "the overlay pencil icon is hidden from assistive tech",
    svgHidden === "true",
    String(svgHidden),
  );

  const overlayTab = await tabInto(page, "#flux-timeline .msg-edit-btn");
  report.check(
    "a Tab press reaches the overlay edit control",
    overlayTab.reached,
    JSON.stringify(overlayTab),
  );
  report.check(
    "the focused overlay edit control becomes visible",
    overlayTab.reached && Number(overlayTab.opacity) >= 0.7,
    JSON.stringify(overlayTab),
  );
} finally {
  await browser.close();
  report.done();
}
