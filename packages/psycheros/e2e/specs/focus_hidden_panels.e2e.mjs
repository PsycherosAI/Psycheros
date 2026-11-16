/**
 * WCAG 2.4.3 / 2.1.1: closed off-canvas surfaces (the sidebar and the graph
 * node panel) must not stay in the tab order. Both ship `inert` until opened.
 */
import { launch, makeReport, openChat, openGraph } from "../lib/harness.mjs";

const report = makeReport("hidden panels");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  const sidebarInert = await page.evaluate(() =>
    document.getElementById("sidebar")?.hasAttribute("inert") ?? null
  );
  report.check("the closed sidebar is inert", sidebarInert === true);

  const sidebarReached = await tabWalk(
    page,
    40,
    () => !!document.activeElement?.closest("#sidebar"),
  );
  report.check(
    "Tab never lands in the closed sidebar",
    sidebarReached === null,
    sidebarReached ? JSON.stringify(sidebarReached) : "",
  );

  // The context viewer toggle must report opened/closed state.
  await page.locator("#action-menu-btn").click();
  const toggleState = await page.evaluate(async () => {
    const toggle = document.querySelector(".context-toggle");
    if (!toggle) return null;
    const before = toggle.getAttribute("aria-expanded");
    toggle.click();
    await new Promise((r) => setTimeout(r, 200));
    const open = toggle.getAttribute("aria-expanded");
    toggle.click();
    await new Promise((r) => setTimeout(r, 200));
    return { before, open, closed: toggle.getAttribute("aria-expanded") };
  });
  report.check(
    "the context viewer toggle reports expanded state",
    toggleState?.before === "false" && toggleState?.open === "true" &&
      toggleState?.closed === "false",
    JSON.stringify(toggleState),
  );

  await openGraph(page);
  await page.click('#gv-view-toggle .gv-view-toggle-btn[data-view="graph"]');
  await page.waitForSelector("#gv-graph-view:not(.gv-hidden)", {
    timeout: 20000,
  });

  const panelInert = await page.evaluate(() =>
    document.getElementById("graph-node-panel")?.hasAttribute("inert") ?? null
  );
  report.check("the closed node panel is inert", panelInert === true);

  const panelReached = await tabWalk(
    page,
    60,
    () => !!document.activeElement?.closest("#graph-node-panel"),
  );
  report.check(
    "Tab never lands in the closed node panel",
    panelReached === null,
    panelReached ? JSON.stringify(panelReached) : "",
  );
} finally {
  await browser.close();
}
report.done();

/** Tab up to `steps` times; return the first focused element matching `inside`. */
async function tabWalk(page, steps, inside) {
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(inside)) {
      return await page.evaluate(() => {
        const a = document.activeElement;
        return {
          tag: a?.tagName ?? null,
          id: a?.id ?? null,
          cls: typeof a?.className === "string" ? a.className : "",
        };
      });
    }
  }
  return null;
}
