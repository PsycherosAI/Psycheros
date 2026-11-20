/**
 * Flux Space timeline renders both entry shapes.
 *
 * The page merges two stores: durable rows go through appendEntry(entry)
 * and session rows through appendSessionEntry(e). Each renderer reads its
 * own parameter's timestamp; a wrong identifier throws on every entry and
 * leaves the page with static chrome only. This spec loads the rendered
 * page (see scripts/check-flux-page.ts), renders one of each shape from
 * the initial fetches, then fires live flux_entry events for the same two
 * shapes and fails on any page error.
 */
import { readFileSync } from "node:fs";
import { launch, makeReport } from "../lib/harness.mjs";

const html = readFileSync(
  new URL("../fixtures/flux-space.html", import.meta.url),
  "utf8",
);
const report = makeReport("Flux Space timeline");
const browser = await launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("page:", message.text());
  });

  const durable = [{
    id: "durable-user-1",
    role: "user",
    content: "audit durable user",
    timestamp: "2026-11-11T10:00:00.000Z",
  }];
  const session = [{
    id: "session-ego-1",
    kind: "ego",
    content: "audit session ego",
    timestamp: "2026-11-11T10:00:01.000Z",
    fromMessages: false,
  }];

  // addInitScript does not run for setContent, so the stubs ride in the
  // page ahead of the template's inline script.
  const bootstrap = `<script>
    globalThis.marked = { setOptions() {}, parse: (text) => text || "" };
    globalThis.DOMPurify = { sanitize: (text) => text || "" };
    globalThis.EventSource = class {
      constructor() { this.handlers = {}; globalThis.__fluxEvents = this; }
      addEventListener(type, handler) {
        (this.handlers[type] ??= []).push(handler);
      }
      close() {}
    };
    globalThis.__fireFlux = (type, data) => {
      for (const handler of globalThis.__fluxEvents?.handlers[type] ?? []) {
        handler({ data: JSON.stringify(data) });
      }
    };
    (() => {
      const realFetch = globalThis.fetch.bind(globalThis);
      const durable = ${JSON.stringify(durable)};
      const session = ${JSON.stringify(session)};
      const json = (body) => Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      globalThis.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith("/api/flux/entries")) return json(durable);
        if (url === "/api/flux/session") return json(session);
        if (url === "/api/flux/status") return json({ state: "running" });
        return realFetch(input, init);
      };
    })();
  </script>`;

  await page.setContent(html.replace("<head>", "<head>" + bootstrap), {
    waitUntil: "load",
  });
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("#flux-timeline .flux-entry").length >= 2,
      null,
      { timeout: 5000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      timeline: document.getElementById("flux-timeline")?.innerHTML ??
        "missing",
      badge: document.getElementById("flux-badge")?.textContent ?? "missing",
    }));
    console.error(
      "timeline did not render:",
      JSON.stringify(diagnostic),
      errors,
    );
    throw error;
  }

  const initial = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#flux-timeline .flux-entry")).map(
      (el) => ({
        cls: el.className,
        text: el.textContent.trim(),
        ts: el.dataset.ts,
      }),
    )
  );
  report.check(
    "stored durable and session entries both render",
    initial.length === 2,
    JSON.stringify(initial),
  );
  report.check(
    "the durable user entry renders its text and timestamp",
    initial.some((el) =>
      el.cls.includes("user") && el.text.includes("audit durable user") &&
      Number(el.ts) > 0
    ),
    JSON.stringify(initial),
  );
  report.check(
    "the session ego entry renders its text and timestamp",
    initial.some((el) =>
      el.cls.includes("entity") && el.text.includes("audit session ego") &&
      Number(el.ts) > 0
    ),
    JSON.stringify(initial),
  );

  // The timeline is a log, not a live region, and the
  // initial history render must not announce.
  const semantics = await page.evaluate(() => {
    const timeline = document.getElementById("flux-timeline");
    const announcer = document.getElementById("flux-announcer");
    const toast = document.getElementById("flux-toast");
    return {
      role: timeline?.getAttribute("role"),
      live: timeline?.getAttribute("aria-live"),
      label: timeline?.getAttribute("aria-label"),
      announcerRole: announcer?.getAttribute("role"),
      announcerLive: announcer?.getAttribute("aria-live"),
      announced: announcer?.textContent ?? "",
      toastRole: toast?.getAttribute("role"),
      toastLive: toast?.getAttribute("aria-live"),
    };
  });
  report.check(
    "the timeline is a named log with announcements off",
    semantics.role === "log" && semantics.live === "off" &&
      /timeline/i.test(semantics.label ?? ""),
    JSON.stringify(semantics),
  );
  const landmarks = {
    h1: await page.getByRole("heading", { level: 1 }).count(),
    main: await page.getByRole("main", { name: "Flux Space" }).count(),
    log: await page.getByRole("log", { name: "Flux Space timeline" }).count(),
  };
  report.check(
    "the page exposes one h1, a named main landmark, and the named timeline",
    landmarks.h1 === 1 && landmarks.main === 1 && landmarks.log === 1,
    JSON.stringify(landmarks),
  );
  report.check(
    "the status announcer and toast are polite regions",
    semantics.announcerRole === "status" &&
      semantics.announcerLive === "polite" &&
      semantics.toastRole === "status" && semantics.toastLive === "polite",
    JSON.stringify(semantics),
  );
  report.check(
    "loading the backlog does not announce stored entries",
    semantics.announced === "",
    JSON.stringify(semantics),
  );

  // A live user turn is one announcement.
  await page.evaluate(() => {
    globalThis.__fireFlux("flux_entry", {
      role: "user",
      content: "live user entry",
      timestamp: "2026-11-11T10:00:04.000Z",
    });
  });
  const userAnnouncement = await page.evaluate(() =>
    document.getElementById("flux-announcer")?.textContent ?? ""
  );
  report.check(
    "a live user turn is announced once with its speaker",
    userAnnouncement.includes("live user entry") &&
      userAnnouncement.includes("the user"),
    JSON.stringify(userAnnouncement),
  );

  // Generating state is announced once; stream fragments are not.
  await page.evaluate(() => globalThis.__fireFlux("flux_generating", {}));
  const generatingAnnouncement = await page.evaluate(() =>
    document.getElementById("flux-announcer")?.textContent ?? ""
  );
  report.check(
    "the generating state is announced",
    generatingAnnouncement === "Generating reply",
    JSON.stringify(generatingAnnouncement),
  );
  await page.evaluate(() => {
    globalThis.__fireFlux("flux_ego_stream", { fragment: "stream fragment" });
  });
  const fragmentAnnouncement = await page.evaluate(() =>
    document.getElementById("flux-announcer")?.textContent ?? ""
  );
  report.check(
    "streamed reply fragments are not announced piecemeal",
    fragmentAnnouncement === "Generating reply",
    JSON.stringify(fragmentAnnouncement),
  );

  // A completed entity turn is announced once, then convergence reload is
  // silent.
  await page.evaluate(() => {
    globalThis.__fireFlux("flux_entry", {
      role: "entity",
      content: "live entity reply",
      timestamp: "2026-11-11T10:00:05.000Z",
    });
  });
  const entityAnnouncement = await page.evaluate(() =>
    document.getElementById("flux-announcer")?.textContent ?? ""
  );
  report.check(
    "a live entity turn is announced once with its speaker",
    entityAnnouncement.includes("live entity reply") &&
      entityAnnouncement.includes("the entity"),
    JSON.stringify(entityAnnouncement),
  );
  await page.evaluate(() => globalThis.__fireFlux("flux_turn_done", {}));
  await page.waitForFunction(
    () =>
      document.getElementById("flux-announcer")?.textContent ===
        "the entity: live entity reply",
    null,
    { timeout: 5000 },
  );
  report.check(
    "turn-done convergence does not re-announce the backlog",
    true,
    "convergence kept the single entry announcement",
  );

  // Live SSE entries take the same two renderers, so exercise both again.
  await page.evaluate(() => {
    globalThis.__fireFlux("flux_entry", {
      role: "entity",
      content: "live durable entity",
      timestamp: "2026-11-11T10:00:02.000Z",
    });
    globalThis.__fireFlux("flux_entry", {
      kind: "tool_use",
      id: "live-tool-1",
      source: "shell",
      content: "printf live",
      timestamp: "2026-11-11T10:00:03.000Z",
    });
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#flux-timeline .flux-entry").length >= 4,
    null,
    { timeout: 5000 },
  );
  const live = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#flux-timeline .flux-entry")).map(
      (el) => ({
        cls: el.className,
        text: el.textContent.trim(),
        ts: el.dataset.ts,
      }),
    )
  );
  report.check(
    "live durable and session events append without throwing",
    live.length === 4 &&
      live.some((el) =>
        el.cls.includes("entity") && el.text.includes("live durable entity")
      ) &&
      live.some((el) =>
        el.cls.includes("tool-wrap") && el.text.includes("shell")
      ),
    JSON.stringify(live),
  );

  // Tool and thinking headers are native buttons with a
  // synchronized expanded state and a real aria-controls target.
  await page.evaluate(() => {
    globalThis.__fireFlux("flux_entry", {
      kind: "tool_use",
      id: "live-tool-2",
      source: "shell",
      content: "printf disclosure",
      timestamp: "2026-11-11T10:00:09.000Z",
    });
    globalThis.__fireFlux("flux_ego_thinking", {
      fragment: "live thought",
    });
  });
  const disclosures = await page.evaluate(() => {
    const toolHeader = document.querySelector(
      "#flux-timeline .tool-wrap .tool-header",
    );
    const thinkingHeader = document.querySelector(
      "#flux-timeline .thinking-wrap .thinking-header",
    );
    const toolControls = toolHeader?.getAttribute("aria-controls");
    const thinkingControls = thinkingHeader?.getAttribute("aria-controls");
    return {
      toolTag: toolHeader?.tagName,
      toolName: toolHeader?.querySelector(".tool-name")?.textContent,
      toolExpanded: toolHeader?.getAttribute("aria-expanded"),
      toolResolves: !!(toolControls &&
        document.getElementById(toolControls)),
      thinkingTag: thinkingHeader?.tagName,
      thinkingExpanded: thinkingHeader?.getAttribute("aria-expanded"),
      thinkingResolves: !!(thinkingControls &&
        document.getElementById(thinkingControls)),
    };
  });
  report.check(
    "tool headers are named buttons with a disclosure target",
    disclosures.toolTag === "BUTTON" &&
      disclosures.toolName === "shell" &&
      disclosures.toolExpanded === "false" &&
      disclosures.toolResolves,
    JSON.stringify(disclosures),
  );
  report.check(
    "the live thinking header is a button with a disclosure target",
    disclosures.thinkingTag === "BUTTON" &&
      disclosures.thinkingExpanded === "true" &&
      disclosures.thinkingResolves,
    JSON.stringify(disclosures),
  );

  await page.evaluate(() => {
    document
      .querySelector("#flux-timeline .tool-wrap .tool-header")
      ?.focus();
  });
  await page.keyboard.press("Enter");
  const afterEnter = await page.evaluate(() => {
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
  const afterSpace = await page.evaluate(() => {
    const header = document.querySelector(
      "#flux-timeline .tool-wrap .tool-header",
    );
    return {
      expanded: header?.getAttribute("aria-expanded"),
      focused: document.activeElement === header,
    };
  });
  report.check(
    "Enter expands a tool card and Space collapses it, keeping focus",
    afterEnter.expanded === "true" && afterEnter.cardExpanded &&
      afterEnter.focused && afterSpace.expanded === "false" &&
      afterSpace.focused,
    JSON.stringify({ afterEnter, afterSpace }),
  );

  await page.evaluate(() => {
    document
      .querySelector("#flux-timeline .thinking-wrap .thinking-header")
      ?.focus();
  });
  await page.keyboard.press("Enter");
  const thinkingAfterEnter = await page.evaluate(() => {
    const header = document.querySelector(
      "#flux-timeline .thinking-wrap .thinking-header",
    );
    return {
      expanded: header?.getAttribute("aria-expanded"),
      open: !!header?.closest(".thinking-card")?.classList.contains("open"),
      focused: document.activeElement === header,
    };
  });
  report.check(
    "Enter collapses the live thinking card and keeps focus",
    thinkingAfterEnter.expanded === "false" && !thinkingAfterEnter.open &&
      thinkingAfterEnter.focused,
    JSON.stringify(thinkingAfterEnter),
  );
  report.check(
    "no page errors while rendering or appending entries",
    errors.length === 0,
    errors.join("; "),
  );

  report.done();
} finally {
  await browser.close();
}
