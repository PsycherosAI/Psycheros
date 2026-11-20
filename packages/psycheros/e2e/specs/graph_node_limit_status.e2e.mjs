// WCAG 4.1.3: a node-limit load announces the shown and total node counts,
// while the visible "showing N" hint stays a non-live indicator.
import {
  launch,
  makeReport,
  newPage,
  openChat,
  openGraph,
} from "../lib/harness.mjs";

const TOTAL = 25;
const nodesFor = (limit) =>
  Array.from({ length: Math.min(limit, TOTAL) }, (_, i) => ({
    id: `node-${i + 1}`,
    type: "topic",
    label: `Node ${String(i + 1).padStart(2, "0")}`,
    description: `Description ${i + 1}`,
  }));

const report = makeReport("graph node limit status");
const browser = await launch();
try {
  const page = await newPage(browser);
  await page.route(
    (url) => url.pathname === "/api/graph",
    async (route) => {
      const url = new URL(route.request().url());
      const limit = parseInt(url.searchParams.get("limit") ?? "500", 10);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          nodes: nodesFor(limit),
          edges: [],
          stats: { totalNodes: TOTAL, totalEdges: 0 },
        }),
      });
    },
  );
  await page.route("https://unpkg.com/**", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `globalThis.vis = {
        DataSet: class { constructor(items) { this.items = items; } },
        Network: class {
          constructor(container) {
            const surface = document.createElement('div');
            surface.className = 'vis-network';
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
  const waitForCards = async (count) => {
    try {
      await page.waitForFunction(
        (n) => document.querySelectorAll(".gv-card-header").length === n,
        count,
        { timeout: 15000 },
      );
    } catch (err) {
      const state = await page.evaluate(() => ({
        cards: document.querySelectorAll(".gv-card-header").length,
        listHtmlLength: document.getElementById("gv-list-view")?.innerHTML
          .length,
        loading: !!document.querySelector(".gv-loading"),
        limit: document.getElementById("graph-node-limit")?.value,
        shown: document.getElementById("gv-shown-count")?.textContent,
        fetchLog: globalThis.__fetchLog ?? null,
      }));
      throw new Error(
        `${err.message}; state=${JSON.stringify(state)}`,
      );
    }
  };
  await waitForCards(25);
  report.check(
    "opening the graph view loads nodes without announcing",
    (await page.locator("#transcript-announcer").textContent()) === "",
  );

  const setLimit = async (value, expectedCards) => {
    await page.evaluate((v) => {
      const input = document.getElementById("graph-node-limit");
      // Enter or the spinner commits the value while the control still has
      // focus; a synthetic change alone would leave activeElement on body.
      input.focus();
      input.value = v;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    await waitForCards(expectedCards);
  };

  await setLimit("10", 10);
  await page.waitForFunction(
    () =>
      document.getElementById("transcript-announcer").textContent ===
        "Showing 10 of 25 nodes. Raise Max to load more.",
    null,
    { timeout: 15000 },
  );
  const truncated = await page.evaluate(() => ({
    announced: document.getElementById("transcript-announcer").textContent,
    hint: document.getElementById("gv-shown-count").textContent,
    hintVisible: !document.querySelector(".gv-shown-row").classList.contains(
      "gv-hidden",
    ),
    hintRole: document.getElementById("gv-shown-count").getAttribute("role"),
    announcerOutsideChat: !document.getElementById("chat").contains(
      document.getElementById("transcript-announcer"),
    ),
    focusedId: document.activeElement?.id ?? null,
  }));
  report.check(
    "lowering Max announces the shown and total counts",
    truncated.announced ===
      "Showing 10 of 25 nodes. Raise Max to load more.",
    truncated.announced,
  );
  report.check(
    "the visible count stays a non-live hint",
    truncated.hint === "showing 10" && truncated.hintVisible &&
      truncated.hintRole === null,
    JSON.stringify({
      hint: truncated.hint,
      visible: truncated.hintVisible,
      role: truncated.hintRole,
    }),
  );
  report.check(
    "the status region lives outside the swapped chat view",
    truncated.announcerOutsideChat,
  );
  report.check(
    "the Max control keeps focus after the reload",
    truncated.focusedId === "graph-node-limit",
    truncated.focusedId,
  );

  await setLimit("500", 25);
  await page.waitForFunction(
    () =>
      document.getElementById("transcript-announcer").textContent ===
        "Showing all 25 nodes.",
    null,
    { timeout: 15000 },
  );
  const full = await page.evaluate(() => ({
    hinted: document.getElementById("gv-shown-count").textContent,
    hidden: document.querySelector(".gv-shown-row").classList.contains(
      "gv-hidden",
    ),
  }));
  report.check(
    "raising Max announces the full count and hides the hint",
    full.hinted === "" && full.hidden,
    JSON.stringify(full),
  );
} finally {
  await browser.close();
}
report.done();
