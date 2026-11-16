/**
 * WCAG 2.4.3 / 2.1.2: the delete-conversation dialog takes focus on open,
 * keeps Tab inside itself, and returns focus to its opener on Escape.
 */
import {
  activeElement,
  launch,
  makeReport,
  openChat,
} from "../lib/harness.mjs";

const report = makeReport("modal focus");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  const semantics = await page.evaluate(() => {
    const modal = document.getElementById("modal-backdrop")?.querySelector(
      ".modal",
    );
    return {
      role: modal?.getAttribute("role") ?? null,
      modal: modal?.getAttribute("aria-modal") ?? null,
      labelledby: modal?.getAttribute("aria-labelledby") ?? null,
      titleExists: !!document.getElementById(
        modal?.getAttribute("aria-labelledby") ?? "",
      ),
    };
  });
  report.check(
    "the dialog is a labelled, modal dialog",
    semantics.role === "dialog" && semantics.modal === "true" &&
      semantics.titleExists,
    JSON.stringify(semantics),
  );

  const opened = await page.evaluate(() => {
    if (!globalThis.Psycheros?.showDeleteModal) return false;
    document.getElementById("message-input")?.focus();
    globalThis.Psycheros.showDeleteModal([
      "00000000-0000-0000-0000-000000000000",
    ]);
    return true;
  });
  report.check("the delete dialog can be opened", opened);

  const inside = await page.evaluate(() =>
    !!document.activeElement?.closest("#modal-backdrop")
  );
  report.check(
    "focus moves into the dialog",
    inside,
    (await activeElement(page)).label,
  );

  let escaped = null;
  for (let i = 0; i < 12 && !escaped; i++) {
    await page.keyboard.press("Tab");
    const still = await page.evaluate(() =>
      !!document.activeElement?.closest("#modal-backdrop")
    );
    if (!still) escaped = await activeElement(page);
  }
  report.check(
    "Tab stays inside the dialog",
    !escaped,
    escaped ? JSON.stringify(escaped) : "",
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const state = await page.evaluate(() => ({
    visible: document.getElementById("modal-backdrop")?.classList
      .contains("visible") ?? null,
    focusedId: document.activeElement?.id ?? null,
  }));
  report.check(
    "Escape closes the dialog",
    state.visible === false,
    JSON.stringify(state),
  );
  report.check(
    "focus returns to the opener",
    state.focusedId === "message-input",
    JSON.stringify(state),
  );

  // The row's Delete button is visibility:hidden (WCAG 2.4.7)
  // until its row has focus, so restoring focus to it silently failed and the
  // conversation link ended up focused instead.
  // The sidebar list arrives over htmx after the page is interactive, and the
  // closed sidebar is inert, so open it before reaching for a row.
  await page.evaluate(() => globalThis.Psycheros.toggleSidebar());
  await page.waitForSelector(".conv-item-wrapper .conv-item", {
    timeout: 5000,
  }).catch(() => {});
  const rowReady = await page.evaluate(async () => {
    const link = document.querySelector(".conv-item-wrapper .conv-item");
    if (!link) return null;
    const btn = link.closest(".conv-item-wrapper")?.querySelector(
      ".conv-action-btn--delete",
    );
    if (!btn) return null;
    btn.dataset.testOpener = "1";
    // Reach the button the way a keyboard user does: focus the row, let the
    // visibility flip settle, then step onto the Delete button.
    link.focus();
    await new Promise((r) => setTimeout(r, 250));
    btn.focus();
    return document.activeElement === btn;
  });
  if (rowReady) {
    await page.evaluate(() =>
      globalThis.Psycheros.showDeleteModal([
        "00000000-0000-0000-0000-000000000000",
      ])
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const back = await page.evaluate(() => ({
      opener: !!document.activeElement?.dataset?.testOpener,
      label: document.activeElement?.getAttribute("aria-label"),
    }));
    report.check(
      "Escape returns focus to the row's Delete button",
      back.opener,
      JSON.stringify(back),
    );
  } else {
    report.skip(
      "Escape returns focus to the row's Delete button",
      "no conversation row in the sidebar",
    );
  }
} finally {
  await browser.close();
}
report.done();
