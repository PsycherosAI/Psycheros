/**
 * WCAG 2.1.2 / 2.4.3: PTT key capture must not trap the keyboard. The Add
 * trigger keeps focus, the hint announces itself and names Escape, Tab
 * reaches Cancel, and cancelling returns focus to the trigger.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("PTT key capture");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  await page.evaluate(() => {
    htmx.ajax("GET", "/fragments/settings/voice", {
      target: "#chat",
      swap: "innerHTML",
    });
  });
  await page.waitForSelector("#ptt-add-key-btn", { timeout: 10000 });

  // Keep the settings writes local; this spec only exercises capture.
  await page.evaluate(() => {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/voice/settings") {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, pttKeys: ["Space"] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return realFetch(input, init);
    };
  });

  const started = await page.evaluate(() => {
    const btn = document.getElementById("ptt-add-key-btn");
    btn.focus();
    btn.click();
    const hint = document.getElementById("ptt-capture-hint");
    return {
      focused: document.activeElement === btn,
      ariaDisabled: btn.getAttribute("aria-disabled"),
      hintRendered: getComputedStyle(hint).display !== "none",
      cancelShown: !hint.querySelector("button").hidden,
    };
  });
  await page.waitForFunction(() =>
    document.getElementById("ptt-capture-status").textContent.includes(
      "Escape cancels",
    )
  );
  report.check(
    "capture starts without losing focus or hiding the trigger",
    started.focused && started.ariaDisabled === "true" &&
      started.hintRendered && started.cancelShown,
    JSON.stringify(started),
  );

  const announced = await page.evaluate(() =>
    document.getElementById("ptt-capture-status").textContent
  );
  report.check(
    "the hint announces the capture and names Escape",
    /Escape cancels/.test(announced),
    announced,
  );

  await page.keyboard.press("Tab");
  const tabbed = await page.evaluate(() => ({
    inHint: !!document.activeElement?.closest("#ptt-capture-hint"),
    text: document.activeElement?.textContent?.trim(),
  }));
  report.check(
    "Tab moves focus to the Cancel button instead of binding Tab",
    tabbed.inHint && tabbed.text === "Cancel",
    JSON.stringify(tabbed),
  );

  await page.keyboard.press("Enter");
  const cancelled = await page.evaluate(() => ({
    hintRendered: getComputedStyle(
      document.getElementById("ptt-capture-hint"),
    ).display !== "none",
    cancelHidden:
      document.getElementById("ptt-capture-hint").querySelector("button")
        .hidden,
    status: document.getElementById("ptt-capture-status").textContent,
    focused: document.activeElement?.id,
    ariaDisabled: document.getElementById("ptt-add-key-btn").getAttribute(
      "aria-disabled",
    ),
  }));
  report.check(
    "Enter on Cancel cancels capture and returns focus to Add",
    cancelled.hintRendered && cancelled.cancelHidden &&
      cancelled.status === "" && cancelled.focused === "ptt-add-key-btn" &&
      cancelled.ariaDisabled === "false",
    JSON.stringify(cancelled),
  );

  await page.evaluate(() => document.getElementById("ptt-add-key-btn").click());
  await page.keyboard.press("Escape");
  const escaped = await page.evaluate(() => ({
    hintRendered: getComputedStyle(
      document.getElementById("ptt-capture-hint"),
    ).display !== "none",
    cancelHidden:
      document.getElementById("ptt-capture-hint").querySelector("button")
        .hidden,
    focused: document.activeElement?.id,
  }));
  report.check(
    "Escape cancels capture and returns focus to Add",
    escaped.hintRendered && escaped.cancelHidden &&
      escaped.focused === "ptt-add-key-btn",
    JSON.stringify(escaped),
  );
} finally {
  await browser.close();
}
report.done();
