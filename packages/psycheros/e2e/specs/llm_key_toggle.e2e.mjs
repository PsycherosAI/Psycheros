/**
 * WCAG 4.1.2 / 2.1.1: the LLM profile API-key eye button names the key it
 * reveals, exposes pressed state, and Enter flips both directions.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("LLM key toggle");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  await page.evaluate(() => {
    htmx.ajax("GET", "/fragments/settings/llm/new", {
      target: "#chat",
      swap: "innerHTML",
    });
  });
  await page.waitForSelector("#llm-api-key", { timeout: 10000 });

  const read = () =>
    page.evaluate(() => {
      const input = document.getElementById("llm-api-key");
      const btn = input.parentElement.querySelector("button");
      return {
        focused: document.activeElement === btn,
        label: btn.getAttribute("aria-label"),
        pressed: btn.getAttribute("aria-pressed"),
        title: btn.getAttribute("title"),
        type: btn.getAttribute("type"),
        inputType: input.type,
      };
    });

  await page.evaluate(() => {
    document
      .getElementById("llm-api-key")
      .parentElement.querySelector("button")
      .focus();
  });
  const before = await read();
  await page.keyboard.press("Enter");
  const shown = await read();
  await page.keyboard.press("Enter");
  const hidden = await read();

  report.check(
    "the toggle starts hidden, focused, and named for the LLM key",
    before.focused && before.label === "Show LLM API key" &&
      before.pressed === "false" && before.title === before.label &&
      before.type === "button" && before.inputType === "password",
    JSON.stringify(before),
  );
  report.check(
    "Enter reveals the key and updates pressed state and name",
    shown.focused && shown.label === "Hide LLM API key" &&
      shown.pressed === "true" && shown.inputType === "text" &&
      shown.title === shown.label,
    JSON.stringify(shown),
  );
  report.check(
    "Enter again re-hides the key and restores the name",
    hidden.focused && hidden.label === "Show LLM API key" &&
      hidden.pressed === "false" && hidden.inputType === "password" &&
      hidden.title === hidden.label,
    JSON.stringify(hidden),
  );
} finally {
  await browser.close();
}
report.done();
