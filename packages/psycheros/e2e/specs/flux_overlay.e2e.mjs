/**
 * WCAG 2.4.3 / 1.3.1 / 4.1.2: the Flux overlay names its view, keeps the top
 * bar and sidebar reachable (it is not modal), and closing it returns focus
 * to the original trigger, the rebuilt Flux ON control, or the composer.
 */
import { readFileSync } from "node:fs";
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const fragment = readFileSync(
  new URL("../fixtures/flux-overlay.html", import.meta.url),
  "utf8",
);
const report = makeReport("Flux overlay");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  // The disposable data dir tolerates a throwaway conversation, which gives
  // startFluxOverlay a real conversation id without a live Ego.
  await page.evaluate(async () => {
    await Psycheros.newConversation();
  });
  await page.waitForSelector("#message-input", { timeout: 10000 });
  const convId = await page.evaluate(() =>
    location.pathname.split("/").filter(Boolean).pop()
  );
  const fragmentForConversation = fragment.replace(
    '"conv-1"',
    JSON.stringify(convId),
  );

  await page.evaluate((html) => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const json = (body) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    globalThis.__fluxStatus = () => ({ state: "running", active: true });
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/flux/start") return json({ ok: true });
      if (url === "/api/flux/status") return json(globalThis.__fluxStatus());
      if (url === "/api/flux/entries") return json([]);
      if (url === "/api/flux/session") return json([]);
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

  const opened = await page.evaluate(async () => {
    const trigger = document.createElement("button");
    trigger.id = "flux-test-trigger";
    trigger.className = "state-seg state-flux";
    trigger.textContent = "Flux ON";
    document.body.appendChild(trigger);
    trigger.focus();
    await Psycheros.startFluxOverlay();
    for (
      let i = 0;
      i < 40 && !document.getElementById("flux-overlay");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const overlay = document.getElementById("flux-overlay");
    const heading = document.getElementById("flux-overlay-title");
    return {
      mounted: !!overlay,
      focused: document.activeElement?.id ?? "",
      role: overlay?.getAttribute("role") ?? "",
      labelledby: overlay?.getAttribute("aria-labelledby") ?? "",
      headingTag: heading?.tagName ?? "",
      headingText: heading?.textContent ?? "",
      modal: overlay?.getAttribute("aria-modal"),
      inert: overlay?.hasAttribute("inert") ?? false,
      headerInert: document.querySelector(".header")?.hasAttribute("inert"),
    };
  });
  report.check(
    "the overlay mounts as a named region with a real heading",
    opened.mounted && opened.role === "region" &&
      opened.labelledby === "flux-overlay-title" &&
      opened.headingTag === "H2" && opened.headingText === "Flux",
    JSON.stringify(opened),
  );
  report.check(
    "focus lands in the view without making it modal",
    opened.focused === "flux-input" && opened.modal === null &&
      opened.inert === false && opened.headerInert === false,
    JSON.stringify(opened),
  );

  await page.evaluate(() => {
    document.querySelector("#flux-overlay button").click();
  });
  await page.waitForFunction(
    () => !document.getElementById("flux-overlay"),
    null,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => document.activeElement?.id === "flux-test-trigger",
    null,
    { timeout: 5000 },
  );
  const closed = await page.evaluate(() => ({
    focused: document.activeElement?.id ?? "",
    overlay: !!document.getElementById("flux-overlay"),
  }));
  report.check(
    "closing removes the overlay and returns focus to the Flux ON trigger",
    !closed.overlay && closed.focused === "flux-test-trigger",
    JSON.stringify(closed),
  );
  await page.evaluate(() =>
    document.getElementById("flux-test-trigger")?.remove()
  );

  // When the opener is replaced during the re-render, focus goes to the
  // rebuilt Flux ON control the state bar renders.
  const rebuilt = await page.evaluate(async () => {
    const trigger = document.createElement("button");
    trigger.id = "flux-test-trigger";
    trigger.className = "state-seg state-flux";
    trigger.textContent = "Flux ON";
    document.body.appendChild(trigger);
    trigger.focus();
    await Psycheros.startFluxOverlay();
    for (
      let i = 0;
      i < 40 && !document.getElementById("flux-overlay");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    trigger.remove();
    document.querySelector("#flux-overlay button").click();
    const bar = document.getElementById("state-sub-bar");
    for (
      let i = 0;
      i < 160 && !bar?.contains(document.activeElement);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const seg = document.querySelector("#state-sub-bar .state-flux");
    return {
      focusedSeg: document.activeElement === seg &&
        seg?.textContent === "Flux ON",
      active: document.activeElement?.id || document.activeElement?.tagName,
      overlay: !!document.getElementById("flux-overlay"),
    };
  });
  report.check(
    "a replaced opener hands focus to the rebuilt Flux ON control",
    rebuilt.focusedSeg && !rebuilt.overlay,
    JSON.stringify(rebuilt),
  );

  // With no Flux control available at all, focus falls back to the composer
  // instead of dropping to body. Report the subsystem as stopped so the
  // state bar cannot reintroduce a Flux ON segment during the close.
  await page.evaluate(() => {
    globalThis.__fluxStatus = () => ({ state: "stopped", active: false });
  });
  await page.waitForFunction(
    () => !document.querySelector(".state-flux"),
    null,
    { timeout: 12000 },
  );
  const fallback = await page.evaluate(async () => {
    const trigger = document.createElement("button");
    trigger.id = "flux-test-trigger";
    trigger.className = "state-seg";
    trigger.textContent = "Flux ON";
    document.body.appendChild(trigger);
    trigger.focus();
    await Psycheros.startFluxOverlay();
    for (
      let i = 0;
      i < 40 && !document.getElementById("flux-overlay");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    trigger.remove();
    document.querySelector("#flux-overlay button").click();
    for (
      let i = 0;
      i < 160 && document.activeElement?.id !== "message-input";
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const input = document.getElementById("message-input");
    return {
      focused: document.activeElement?.id ?? "",
      tag: document.activeElement?.tagName ?? "",
      hasInput: !!input,
      inputConnected: input?.isConnected ?? false,
      overlay: !!document.getElementById("flux-overlay"),
      seg: !!document.querySelector(".state-flux"),
    };
  });
  report.check(
    "a gone Flux control falls back to the composer",
    fallback.focused === "message-input",
    JSON.stringify(fallback),
  );
} finally {
  await browser.close();
}
report.done();
