/**
 * WCAG 2.1.2 / 2.4.3: the What's New splash is a labelled modal, traps Tab,
 * closes on Escape, restores its opener, and leaves the app inert-free.
 */
import {
  activeElement,
  launch,
  makeReport,
  openChat,
} from "../lib/harness.mjs";

const report = makeReport("what's new modal");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);
  await page.waitForFunction(() => !!globalThis.WhatsNew, null, {
    timeout: 10000,
  });

  const opened = await page.evaluate(async () => {
    const opener = document.getElementById("message-input");
    opener.focus();
    await globalThis.WhatsNew.open();

    const overlay = document.querySelector(".whats-new-overlay");
    const labelledBy = overlay?.getAttribute("aria-labelledby") ?? "";
    const title = labelledBy ? document.getElementById(labelledBy) : null;
    const background = [...document.body.children].filter((el) =>
      el !== overlay && el.tagName !== "SCRIPT"
    );
    return {
      role: overlay?.getAttribute("role") ?? null,
      modal: overlay?.getAttribute("aria-modal") ?? null,
      title: title?.textContent ?? null,
      focused: document.activeElement?.textContent?.trim() ?? null,
      inside: !!overlay?.contains(document.activeElement),
      inertBackground: background.length > 0 &&
        background.every((el) => el.inert),
      overflow: document.body.style.overflow,
    };
  });
  report.check(
    "the splash is a labelled modal and takes focus",
    opened.role === "dialog" && opened.modal === "true" &&
      opened.title === "What's New" && opened.inside &&
      opened.focused === "Continue" && opened.inertBackground &&
      opened.overflow === "hidden",
    JSON.stringify(opened),
  );

  let escaped = null;
  for (let i = 0; i < 8 && !escaped; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() =>
      !!document.activeElement?.closest(".whats-new-overlay")
    );
    if (!inside) escaped = await activeElement(page);
  }
  report.check(
    "Tab stays inside the splash",
    !escaped,
    escaped ? JSON.stringify(escaped) : "",
  );

  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    !document.querySelector(".whats-new-overlay")
  );
  const closed = await page.evaluate(() => ({
    focused: document.activeElement?.id ?? null,
    inertLeft: [...document.body.children].some((el) => el.inert),
    overflow: document.body.style.overflow,
  }));
  report.check(
    "Escape closes, restores focus, and un-inerts the app",
    closed.focused === "message-input" && !closed.inertLeft &&
      closed.overflow === "",
    JSON.stringify(closed),
  );
} finally {
  await browser.close();
}
report.done();
