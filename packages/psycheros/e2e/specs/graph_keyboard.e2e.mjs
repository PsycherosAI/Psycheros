/**
 * WCAG 1.1.1 / 2.1.1 / 4.1.2: the complete graph list is present for
 * sequential navigation, card disclosures retain focus, and view state is
 * exposed independently of color.
 */
import { launch, makeReport, openChat, openGraph } from "../lib/harness.mjs";

const report = makeReport("graph keyboard controls");
const browser = await launch();
try {
  const page = await browser.newPage();
  await page.route("**/api/graph", async (route) => {
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      id: `node-${i + 1}`,
      type: "topic",
      label: `Node ${String(i + 1).padStart(2, "0")}`,
      description: `Description ${i + 1}`,
    }));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ nodes, edges: [] }),
    });
  });
  await page.route("https://unpkg.com/**", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `globalThis.vis = {
        DataSet: class { constructor(items) { this.items = items; } },
        Network: class {
          constructor(container) {
            const surface = document.createElement('div');
            surface.className = 'vis-network';
            surface.tabIndex = 0;
            container.appendChild(surface);
          }
          on() {}
          destroy() {}
          setOptions() {}
          fit() {}
        }
      };`,
    });
  });

  await openChat(page);
  await openGraph(page);
  await page.waitForFunction(
    () => document.querySelectorAll(".gv-card-header").length === 25,
  );

  const cardCount = await page.locator(".gv-card-header").count();
  report.check(
    "all filtered graph nodes are present in the List view",
    cardCount === 25,
    `found ${cardCount}`,
  );

  const first = page.locator(".gv-card-header").first();
  await first.focus();
  await page.keyboard.press("Enter");
  const expanded = page.locator(".gv-card-header").first();
  report.check(
    "Enter expands a card and preserves focus",
    await expanded.getAttribute("aria-expanded") === "true" &&
      await expanded.evaluate((el) => document.activeElement === el),
  );
  const targetId = await expanded.getAttribute("aria-controls");
  report.check(
    "the card controls an existing detail region",
    !!targetId && await page.locator(`#${targetId}`).count() === 1,
  );
  await page.keyboard.press("Space");
  const collapsed = page.locator(".gv-card-header").first();
  report.check(
    "Space collapses a card and preserves focus",
    await collapsed.getAttribute("aria-expanded") === "false" &&
      await collapsed.evaluate((el) => document.activeElement === el),
  );

  const list = page.locator('[data-view="list"]');
  const network = page.locator('[data-view="graph"]');
  report.check(
    "List is initially exposed as selected",
    await list.getAttribute("aria-pressed") === "true" &&
      await network.getAttribute("aria-pressed") === "false",
  );
  await network.click();
  await page.waitForSelector("#gv-graph-view:not(.gv-hidden)");
  report.check(
    "Network selection state follows the visible view",
    await list.getAttribute("aria-pressed") === "false" &&
      await network.getAttribute("aria-pressed") === "true",
  );
  report.check(
    "the network surface is named and described",
    await page.locator(".vis-network").getAttribute("aria-label") ===
        "Knowledge graph network" &&
      await page.locator(".vis-network").getAttribute("aria-describedby") ===
        "graph-network-help",
  );
} finally {
  await browser.close();
}
report.done();
