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

  // The overlay timeline is a named log, and completed
  // entries announce once through the status region while stream fragments
  // stay silent.
  const announcements = await page.evaluate(async () => {
    const handlers = {};
    globalThis.__overlayEvents = handlers;
    globalThis.EventSource = class {
      addEventListener(type, handler) {
        (handlers[type] ??= []).push(handler);
      }
      close() {}
    };
    globalThis.__fireOverlay = (type, data) => {
      for (const handler of handlers[type] ?? []) {
        handler({ data: JSON.stringify(data) });
      }
    };
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
    const timeline = document.getElementById("flux-timeline");
    const announcer = document.getElementById("flux-announcer");
    const base = {
      mounted: !!document.getElementById("flux-overlay"),
      role: timeline?.getAttribute("role"),
      live: timeline?.getAttribute("aria-live"),
      label: timeline?.getAttribute("aria-label"),
      announcerRole: announcer?.getAttribute("role"),
      announcerLive: announcer?.getAttribute("aria-live"),
      announced: announcer?.textContent ?? "",
    };
    globalThis.__fireOverlay("flux_entry", {
      role: "user",
      content: "overlay user entry",
      timestamp: "2026-11-11T10:00:06.000Z",
    });
    const user = announcer?.textContent ?? "";
    globalThis.__fireOverlay("flux_generating", {});
    const generating = announcer?.textContent ?? "";
    globalThis.__fireOverlay("flux_ego_stream", {
      fragment: "overlay fragment",
    });
    const fragment = announcer?.textContent ?? "";
    globalThis.__fireOverlay("flux_entry", {
      role: "entity",
      content: "overlay entity reply",
      timestamp: "2026-11-11T10:00:07.000Z",
    });
    const entity = announcer?.textContent ?? "";
    document.querySelector("#flux-overlay button")?.click();
    return { base, user, generating, fragment, entity };
  });
  report.check(
    "the overlay timeline is a named log with a status announcer",
    announcements.base.mounted && announcements.base.role === "log" &&
      announcements.base.live === "off" &&
      /timeline/i.test(announcements.base.label ?? "") &&
      announcements.base.announcerRole === "status" &&
      announcements.base.announcerLive === "polite",
    JSON.stringify(announcements.base),
  );
  report.check(
    "the overlay never announced the empty initial backlog",
    announcements.base.announced.trim() === "",
    JSON.stringify(announcements.base),
  );
  report.check(
    "the overlay announces a live user turn once",
    announcements.user.includes("overlay user entry"),
    JSON.stringify(announcements.user),
  );
  report.check(
    "the overlay announces generating state but not fragments",
    announcements.generating === "Generating reply" &&
      announcements.fragment === "Generating reply",
    JSON.stringify([announcements.generating, announcements.fragment]),
  );
  report.check(
    "the overlay announces a completed entity turn once",
    announcements.entity.includes("overlay entity reply"),
    JSON.stringify(announcements.entity),
  );

  // Overlay tool and live-thinking headers are native
  // buttons with synchronized expanded state and real disclosure targets.
  const disclosures = await page.evaluate(async () => {
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
    globalThis.__fireOverlay("flux_entry", {
      kind: "tool_use",
      id: "overlay-tool-1",
      source: "shell",
      content: "printf overlay",
      timestamp: "2026-11-11T10:00:08.000Z",
    });
    globalThis.__fireOverlay("flux_ego_thinking", {
      fragment: "overlay thought",
    });
    const toolHeader = document.querySelector(
      "#flux-timeline .tool-wrap .tool-header",
    );
    const thinkingHeader = document.querySelector(
      "#flux-timeline .live-ego .thinking-header",
    );
    const toolControls = toolHeader?.getAttribute("aria-controls");
    const thinkingControls = thinkingHeader?.getAttribute("aria-controls");
    toolHeader?.focus();
    return {
      toolTag: toolHeader?.tagName,
      toolName: toolHeader?.querySelector(".tool-name")?.textContent,
      toolExpanded: toolHeader?.getAttribute("aria-expanded"),
      toolResolves: !!(toolControls &&
        document.getElementById(toolControls)),
      toolFocused: document.activeElement === toolHeader,
      thinkingTag: thinkingHeader?.tagName,
      thinkingExpanded: thinkingHeader?.getAttribute("aria-expanded"),
      thinkingResolves: !!(thinkingControls &&
        document.getElementById(thinkingControls)),
    };
  });
  report.check(
    "overlay tool headers are named buttons with a disclosure target",
    disclosures.toolTag === "BUTTON" &&
      disclosures.toolName === "shell" &&
      disclosures.toolExpanded === "false" &&
      disclosures.toolResolves && disclosures.toolFocused,
    JSON.stringify(disclosures),
  );
  report.check(
    "the overlay live thinking header is a button with a disclosure target",
    disclosures.thinkingTag === "BUTTON" &&
      disclosures.thinkingExpanded === "true" &&
      disclosures.thinkingResolves,
    JSON.stringify(disclosures),
  );

  await page.keyboard.press("Enter");
  const toolEnter = await page.evaluate(() => {
    const header = document.querySelector(
      "#flux-timeline .tool-wrap .tool-header",
    );
    return {
      expanded: header?.getAttribute("aria-expanded"),
      cardExpanded: !!header?.closest(".tool")?.classList.contains("expanded"),
      focused: document.activeElement === header,
    };
  });
  await page.keyboard.press(" ");
  const toolSpace = await page.evaluate(() => {
    const header = document.querySelector(
      "#flux-timeline .tool-wrap .tool-header",
    );
    return {
      expanded: header?.getAttribute("aria-expanded"),
      focused: document.activeElement === header,
    };
  });
  report.check(
    "Enter expands and Space collapses the overlay tool card",
    toolEnter.expanded === "true" && toolEnter.cardExpanded &&
      toolEnter.focused && toolSpace.expanded === "false" &&
      toolSpace.focused,
    JSON.stringify({ toolEnter, toolSpace }),
  );

  await page.evaluate(() => {
    document
      .querySelector("#flux-timeline .live-ego .thinking-header")
      ?.focus();
  });
  await page.keyboard.press("Enter");
  const thinkingEnter = await page.evaluate(() => {
    const header = document.querySelector(
      "#flux-timeline .live-ego .thinking-header",
    );
    return {
      expanded: header?.getAttribute("aria-expanded"),
      expandedClass: !!header?.closest(".thinking")?.classList.contains(
        "expanded",
      ),
      focused: document.activeElement === header,
    };
  });
  report.check(
    "Enter collapses the overlay live thinking card and keeps focus",
    thinkingEnter.expanded === "false" && !thinkingEnter.expandedClass &&
      thinkingEnter.focused,
    JSON.stringify(thinkingEnter),
  );
  await page.evaluate(() => {
    document.querySelector("#flux-overlay button")?.click();
  });
} finally {
  await browser.close();
}
report.done();
