/**
 * WCAG 4.1.2 / 1.3.1 / 2.1.1: the Flux settings tabs expose which panel
 * is current, associate each tab with its panel, and support the
 * arrow-key model; section and hookup titles are headings.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("Flux settings tabs");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  await page.evaluate(() => {
    htmx.ajax("GET", "/fragments/settings/flux", {
      target: "#chat",
      swap: "innerHTML",
    });
  });
  await page.waitForSelector("#flux-tab-btn-general", { timeout: 10000 });

  const state = () =>
    page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("#chat [role=tab]"));
      return {
        tabs: tabs.map((t) => ({
          name: t.textContent.trim(),
          selected: t.getAttribute("aria-selected"),
          tabindex: t.tabIndex,
          controls: t.getAttribute("aria-controls"),
          focused: document.activeElement === t,
        })),
        panels: Array.from(
          document.querySelectorAll("#chat [role=tabpanel]"),
        ).map((p) => ({
          id: p.id,
          labelledby: p.getAttribute("aria-labelledby"),
          hidden: p.style.display === "none",
        })),
        tablistLabel: document.querySelector("#chat [role=tablist]")
          ?.getAttribute("aria-label"),
        headings: Array.from(
          document.querySelectorAll("#chat h1, #chat h2, #chat h3"),
        ).map((h) => ({
          level: h.tagName,
          text: h.textContent.trim().slice(0, 40),
          hidden: h.offsetParent === null,
        })),
      };
    });

  const visible = (s, name) =>
    s.panels.find((p) => p.id === `flux-tab-${name}`)?.hidden === false;
  const selected = (s) => s.tabs.filter((t) => t.selected === "true");
  const focusedName = (s) => s.tabs.find((t) => t.focused)?.name;

  const initial = await state();
  report.check(
    "the tablist is named and holds three tabs linked to their panels",
    initial.tablistLabel === "Flux settings" &&
      initial.tabs.length === 3 &&
      initial.tabs.every((t) =>
        t.controls === `flux-tab-${t.name.toLowerCase()}`
      ) &&
      initial.panels.length === 3 &&
      initial.panels.every((p) => p.labelledby.startsWith("flux-tab-btn-")),
    JSON.stringify(initial),
  );
  report.check(
    "General is selected, in the tab order, and the only visible panel",
    selected(initial).length === 1 &&
      selected(initial)[0].name === "General" &&
      initial.tabs[0].tabindex === 0 &&
      initial.tabs.slice(1).every((t) => t.tabindex === -1) &&
      visible(initial, "general") && !visible(initial, "hookups") &&
      !visible(initial, "sensory"),
    JSON.stringify(initial.tabs),
  );

  const counts = initial.headings.reduce((acc, h) => {
    acc[h.level] = (acc[h.level] ?? 0) + 1;
    return acc;
  }, {});
  report.check(
    "the page has one h1, its section titles are h2, hookup jobs are h3",
    counts.H1 === 1 && (counts.H2 ?? 0) >= 8 && counts.H3 === 4,
    JSON.stringify(counts),
  );

  await page.evaluate(() => {
    document.getElementById("flux-tab-btn-general").focus();
  });
  await page.keyboard.press("ArrowRight");
  const right = await state();
  report.check(
    "ArrowRight moves selection and focus to Hookups and shows its panel",
    selected(right).length === 1 && selected(right)[0].name === "Hookups" &&
      right.tabs[1].tabindex === 0 && right.tabs[0].tabindex === -1 &&
      focusedName(right) === "Hookups" && visible(right, "hookups") &&
      !visible(right, "general"),
    JSON.stringify(right.tabs),
  );

  await page.keyboard.press("End");
  const end = await state();
  report.check(
    "End selects and focuses the last tab (Sensory)",
    selected(end).length === 1 && selected(end)[0].name === "Sensory" &&
      focusedName(end) === "Sensory" && visible(end, "sensory"),
    JSON.stringify(end.tabs),
  );

  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  const wrapped = await state();
  report.check(
    "Home then ArrowLeft wraps from the first tab to the last",
    selected(wrapped).length === 1 && selected(wrapped)[0].name === "Sensory" &&
      focusedName(wrapped) === "Sensory",
    JSON.stringify(wrapped.tabs),
  );

  await page.getByRole("tab", { name: "Hookups" }).click();
  const clicked = await state();
  report.check(
    "clicking a tab keeps its selected state and panel in sync",
    selected(clicked).length === 1 && selected(clicked)[0].name === "Hookups" &&
      visible(clicked, "hookups") && !visible(clicked, "sensory"),
    JSON.stringify(clicked.tabs),
  );

  report.check(
    "the live tab panel is reachable by its role and tab name",
    await page.getByRole("tabpanel", { name: "Hookups" }).count() === 1,
  );
} finally {
  await browser.close();
}
report.done();
