/**
 * WCAG 2.1.1 / 4.1.2: chat and context disclosures use native buttons,
 * retain focus, and synchronize their exposed state with visible content.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("disclosure keyboard controls");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "disclosure-keyboard-probe";
    probe.innerHTML = `
      <div class="thinking">
        <button type="button" class="thinking-header" aria-expanded="false"
          aria-controls="probe-thinking" onclick="Psycheros.toggleDisclosure(this)">
          <span class="thinking-toggle" aria-hidden="true">&#9660;</span>
          <span>Thinking</span>
        </button>
        <div class="thinking-content" id="probe-thinking">Details</div>
      </div>
      <div class="generated-image-container">
        <button type="button" class="generated-image-caption-toggle"
          aria-expanded="false" aria-controls="caption-probe"
          onclick="Psycheros.toggleImageCaption('probe')">
          <span aria-hidden="true">▸</span> <span>Show caption</span>
        </button>
        <div class="generated-image-caption" id="caption-probe" hidden>Caption</div>
      </div>`;
    document.getElementById("chat")?.prepend(probe);
  });

  const thinking = page.locator("#disclosure-keyboard-probe .thinking-header");
  await thinking.focus();
  await page.keyboard.press("Enter");
  report.check(
    "Enter expands thinking and exposes state",
    await thinking.getAttribute("aria-expanded") === "true" &&
      await page.locator("#disclosure-keyboard-probe .thinking").evaluate((
        el,
      ) => el.classList.contains("expanded")),
  );
  await page.keyboard.press("Space");
  report.check(
    "Space collapses thinking without losing focus",
    await thinking.getAttribute("aria-expanded") === "false" &&
      await thinking.evaluate((el) => document.activeElement === el),
  );

  const caption = page.locator(
    "#disclosure-keyboard-probe .generated-image-caption-toggle",
  );
  await caption.focus();
  await page.keyboard.press("Enter");
  report.check(
    "Enter shows the caption and exposes state",
    await caption.getAttribute("aria-expanded") === "true" &&
      !await page.locator("#caption-probe").getAttribute("hidden"),
  );
  await page.keyboard.press("Space");
  report.check(
    "Space hides the caption without losing focus",
    await caption.getAttribute("aria-expanded") === "false" &&
      await caption.evaluate((el) => document.activeElement === el),
  );
} finally {
  await browser.close();
}
report.done();
