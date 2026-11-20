/**
 * WCAG 2.1.1 / 2.4.3 / 4.1.2: gallery thumbnails are named buttons, and the
 * lightbox is a modal dialog that takes focus, contains Tab, and returns focus
 * to the thumbnail that opened it.
 */
import { Buffer } from "node:buffer";
import {
  activeElement,
  launch,
  makeReport,
  openChat,
} from "../lib/harness.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const IMAGE = {
  filename: "e2e-sample.png",
  url: "/generated-images/e2e-sample.png",
  category: "generated",
  size: 2048,
  createdAt: "2026-01-01T00:00:00Z",
  prompt: "sample",
};

const report = makeReport("gallery lightbox");
const browser = await launch();
try {
  const page = await browser.newPage();

  // The gallery is empty in most dev data roots, so feed the real card
  // builder one image instead of depending on stored files.
  await page.route("**/api/gallery/images**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ images: [IMAGE], hasMore: false }),
    }));
  for (
    const pattern of [
      "**/generated-images/thumbs/e2e-sample.png.webp",
      "**/generated-images/e2e-sample.png",
    ]
  ) {
    await page.route(
      pattern,
      (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
    );
  }

  await openChat(page);
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "gallery-container";
    host.innerHTML = '<div class="gallery-grid"></div>';
    document.body.appendChild(host);
    globalThis.loadMoreGallery();
  });
  await page.waitForSelector(".gallery-thumb-btn", { timeout: 10000 });

  const thumb = await page.evaluate(() => {
    const btn = document.querySelector(".gallery-thumb-btn");
    const img = btn?.querySelector("img");
    return {
      tag: btn?.tagName ?? null,
      label: btn?.getAttribute("aria-label") ?? null,
      alt: img?.getAttribute("alt") ?? null,
      imgOnclick: img?.hasAttribute("onclick") ?? null,
    };
  });
  report.check(
    "the thumbnail is a named button wrapping a decorative image",
    thumb.tag === "BUTTON" &&
      thumb.label === "Open image e2e-sample.png" &&
      thumb.alt === "" &&
      thumb.imgOnclick === false,
    JSON.stringify(thumb),
  );

  await page.evaluate(() =>
    document.querySelector(".gallery-thumb-btn").focus()
  );
  await page.keyboard.press("Enter");
  await page.waitForSelector("#gallery-lightbox", { timeout: 5000 });

  const opened = await page.evaluate(() => {
    const dialog = document.getElementById("gallery-lightbox");
    return {
      role: dialog?.getAttribute("role") ?? null,
      modal: dialog?.getAttribute("aria-modal") ?? null,
      labelledby: dialog?.getAttribute("aria-labelledby") ?? null,
      title: document.getElementById("gallery-lightbox-title")?.textContent ??
        null,
      closeLabel: document.querySelector(".gallery-lightbox-close")
        ?.getAttribute("aria-label") ?? null,
      focusInside: !!document.activeElement?.closest("#gallery-lightbox"),
      appInert: document.querySelector(".app")?.inert ?? null,
    };
  });
  report.check(
    "the lightbox is a named modal dialog",
    opened.role === "dialog" &&
      opened.modal === "true" &&
      opened.labelledby === "gallery-lightbox-title" &&
      opened.title === "e2e-sample.png" &&
      opened.closeLabel === "Close image",
    JSON.stringify(opened),
  );
  report.check("focus moves into the dialog", opened.focusInside);
  report.check("the page behind the dialog is inert", opened.appInert === true);

  let escaped = null;
  for (let i = 0; i < 4 && !escaped; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() =>
      !!document.activeElement?.closest("#gallery-lightbox")
    );
    if (!inside) escaped = await activeElement(page);
  }
  report.check(
    "Tab stays inside the dialog",
    !escaped,
    escaped ? JSON.stringify(escaped) : "",
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const dismissed = await page.evaluate(() => ({
    exists: !!document.getElementById("gallery-lightbox"),
    appInert: document.querySelector(".app")?.inert ?? null,
    focusBack:
      document.activeElement?.classList.contains("gallery-thumb-btn") ??
        false,
  }));
  report.check("Escape closes the dialog", !dismissed.exists);
  report.check("the page is interactive again", dismissed.appInert === false);
  report.check("focus returns to the thumbnail", dismissed.focusBack);

  await page.keyboard.press("Enter");
  await page.waitForSelector("#gallery-lightbox", { timeout: 5000 });
  await page.click(".gallery-lightbox-close");
  await page.waitForTimeout(150);
  const closed = await page.evaluate(() => ({
    exists: !!document.getElementById("gallery-lightbox"),
    focusBack:
      document.activeElement?.classList.contains("gallery-thumb-btn") ??
        false,
  }));
  report.check("the close button dismisses the dialog", !closed.exists);
  report.check("focus returns after the close button", closed.focusBack);
} finally {
  await browser.close();
}
report.done();
