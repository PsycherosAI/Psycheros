/**
 * WCAG 2.4.1 (Bypass Blocks): the skip link is the first tab stop and moves
 * focus into the main landmark.
 */
import {
  activeElement,
  launch,
  makeReport,
  openChat,
} from "../lib/harness.mjs";

const report = makeReport("skip link");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  // The app focuses #message-input on load; anchor sequential focus at the top
  // of the document so the first Tab lands on the skip link.
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press("Tab");
  const first = await activeElement(page);
  report.check(
    "first Tab reaches the skip link",
    first.cls.includes("skip-link"),
    JSON.stringify(first),
  );

  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.activeElement?.id ?? null);
  report.check("Enter moves focus to #main", after === "main", String(after));
} finally {
  await browser.close();
}
report.done();
