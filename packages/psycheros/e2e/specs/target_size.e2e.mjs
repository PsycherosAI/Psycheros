/**
 * WCAG 2.5.8 (Target Size, Minimum, AA): icon-only controls expose at least a
 * 24x24 CSS pixel target. Text controls are exempt from the automated check
 * here - they satisfy the criterion through the inline spacing exception,
 * which a bounding-box measurement cannot see.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const MIN = 24;

const MEASURE = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("button")) {
    const text = (el.textContent || "").replace(/\\s+/g, "");
    const iconOnly = !!el.querySelector("svg, img") && text === "";
    if (!iconOnly) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (
      rect.width === 0 || rect.height === 0 ||
      style.visibility === "hidden" || style.display === "none"
    ) continue;
    out.push({
      cls: typeof el.className === "string" ? el.className : "",
      id: el.id || null,
      label: el.getAttribute("aria-label") || el.title || "",
      w: Math.round(rect.width * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
    });
  }
  return out;
})()`;

const report = makeReport("target size (2.5.8)");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  const main = await page.evaluate(MEASURE);
  const small = main.filter((b) => b.w < MIN || b.h < MIN);
  report.check(
    `${main.length} icon-only control(s) are >= ${MIN}x${MIN}`,
    small.length === 0 && main.length > 0,
    small.map((b) => `${b.label || b.cls} ${b.w}x${b.h}`).join("; "),
  );

  // The row actions stay hidden until the row has focus; reveal and re-measure.
  await page.evaluate(() => {
    globalThis.Psycheros?.toggleSidebar();
    document.querySelector("#sidebar .conv-item[data-conv-id]")?.focus();
  });
  await page.waitForTimeout(150);
  const row = await page.evaluate(() => {
    const items = [
      ...document.querySelectorAll("#sidebar .conv-item[data-conv-id]"),
    ]
      .slice(0, 3);
    for (const item of items) item.focus();
    return items.length;
  });
  const rowActions = (await page.evaluate(MEASURE))
    .filter((b) => b.cls.includes("conv-action-btn"));
  const smallRow = rowActions.filter((b) => b.w < MIN || b.h < MIN);
  report.check(
    `revealed row actions (${rowActions.length}) are >= ${MIN}x${MIN}`,
    row > 0 && rowActions.length > 0 && smallRow.length === 0,
    smallRow.map((b) => `${b.label || b.cls} ${b.w}x${b.h}`).join("; "),
  );
} finally {
  await browser.close();
}
report.done();
