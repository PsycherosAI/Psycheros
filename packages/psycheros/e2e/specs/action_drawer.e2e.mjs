/** Merge integration: action controls survive polling and retain keyboard access. */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("action drawer");
const browser = await launch();
try {
  const page = await browser.newPage({ serviceWorkers: "block" });
  await page.route(
    /\/api\/skills\/held(?:\?|$)/,
    (route) => route.fulfill({ json: { skills: ["probe"] } }),
  );
  await page.route(
    "**/api/skills/probe",
    (route) =>
      route.fulfill({ json: { name: "probe", body: "Skill details" } }),
  );
  // Expose module-local renderers only in the browser test's intercepted copy.
  await page.route("**/js/psycheros.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        "refreshActionState();\nsetInterval(refreshActionState, 5000);",
        "currentConversationId = 'probe'; refreshActionState();\nsetInterval(refreshActionState, 5000);",
      ) + `
        globalThis.mergeProbe = { renderActionDrawerRows, renderStateSubBar,
          createTurnStreamState, handleSSEEvent, announceTranscript, refreshActionState };
      `,
    });
  });
  await openChat(page);
  await page.evaluate(() => mergeProbe.refreshActionState());
  await page.waitForSelector('[data-skill="probe"]', { timeout: 5000 });
  await page.locator("#action-menu-btn").click();
  await page.locator("#action-drawer .context-toggle").focus();
  const pollFocus = await page.evaluate(() => {
    const before = document.activeElement;
    mergeProbe.renderActionDrawerRows(true);
    mergeProbe.renderActionDrawerRows(true);
    return document.activeElement === before;
  });
  report.check("an unchanged poll preserves drawer focus", pollFocus);
  await page.keyboard.press("Escape");
  report.check(
    "Escape closes the drawer and restores its trigger",
    await page.evaluate(() =>
      document.activeElement?.id === "action-menu-btn" &&
      document.getElementById("action-menu-btn").getAttribute(
          "aria-expanded",
        ) ===
        "false"
    ),
  );

  // Tab from the trigger must reach the drawer rows before the sidebar, log,
  // or composer. The sub-bar may come first; it sits above the drawer.
  await page.locator("#action-menu-btn").focus();
  await page.keyboard.press("Enter");
  const stops = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        return {
          text: (active?.textContent ?? "").trim(),
          inBar: !!active?.closest("#state-sub-bar"),
          inDrawer: !!active?.closest("#action-drawer"),
          inChat: !!active?.closest("#chat"),
          inSidebar: !!active?.closest("#sidebar"),
        };
      }),
    );
  }
  const contextIndex = stops.findIndex((stop) =>
    stop.inDrawer && stop.text === "Context"
  );
  const outsideIndex = stops.findIndex((stop) => stop.inChat || stop.inSidebar);
  report.check(
    "Tab from the Actions trigger reaches the drawer before the conversation",
    contextIndex >= 0 && (outsideIndex === -1 || contextIndex < outsideIndex),
    JSON.stringify(stops),
  );

  // The Context row opens a panel that lives on <body>, so the panel itself
  // has to take focus, keep Tab inside, and hand focus back on Escape.
  await page.locator("#action-drawer .context-toggle").focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#context-viewer.visible", { timeout: 5000 });
  report.check(
    "the Context Inspector takes focus as a named modal",
    await page.evaluate(() => {
      const viewer = document.getElementById("context-viewer");
      return viewer?.getAttribute("role") === "dialog" &&
        viewer.getAttribute("aria-modal") === "true" &&
        viewer.getAttribute("aria-labelledby") === "context-viewer-title" &&
        document.activeElement === document.getElementById(
            "context-viewer-title",
          );
    }),
  );
  await page.locator("#context-viewer .context-viewer-close").focus();
  await page.keyboard.press("Shift+Tab");
  report.check(
    "Shift+Tab wraps inside the Inspector",
    await page.evaluate(() =>
      document.getElementById("context-viewer").contains(
        document.activeElement,
      )
    ),
  );
  await page.keyboard.press("Escape");
  report.check(
    "Escape closes the Inspector and restores the Actions trigger",
    await page.evaluate(() => {
      const viewer = document.getElementById("context-viewer");
      return !viewer.classList.contains("visible") && viewer.inert &&
        document.activeElement?.id === "action-menu-btn";
    }),
  );

  const chip = page.locator('[data-skill="probe"]');
  report.check(
    "the skill chip is a native button",
    await chip.evaluate((el) => el.tagName === "BUTTON"),
  );
  await chip.focus();
  report.check(
    "an unchanged poll preserves skill focus",
    await page.evaluate(() => {
      const before = document.activeElement;
      mergeProbe.renderStateSubBar();
      return before === document.activeElement;
    }),
  );
  await page.keyboard.press("Enter");
  await page.waitForSelector("dialog.skill-viewer[open]", { timeout: 5000 });
  report.check(
    "the named skill dialog owns focus",
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog.skill-viewer");
      return dialog.getAttribute("aria-label") === "probe" &&
        dialog.contains(document.activeElement);
    }),
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector("dialog.skill-viewer", { state: "detached" });
  report.check(
    "Escape restores skill focus",
    await chip.evaluate((el) => el === document.activeElement),
  );

  const streamed = await page.evaluate(() => {
    const state = mergeProbe.createTurnStreamState({ conversationId: "probe" });
    mergeProbe.handleSSEEvent("content", "Opening generation", state);
    mergeProbe.handleSSEEvent("done", "tool_calls", state);
    mergeProbe.handleSSEEvent("content", "Final answer", state);
    mergeProbe.handleSSEEvent("done", "stop", state);
    mergeProbe.announceTranscript(state.currentBubble());
    return {
      count: state.allBubbles().length,
      author: !!state.currentBubble().querySelector(".msg-author"),
      announcement: document.getElementById("transcript-announcer").textContent,
    };
  });
  report.check(
    "multi-generation replies retain metadata and announce the final answer",
    streamed.count === 2 && streamed.author &&
      streamed.announcement.includes("Final answer") &&
      !streamed.announcement.includes("Opening generation"),
    JSON.stringify(streamed),
  );
} finally {
  await browser.close();
}
report.done();
