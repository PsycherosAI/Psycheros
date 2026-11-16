/**
 * WCAG 2.4.3 / 4.1.2: the voice call is a named native modal, keeps focus
 * inside, and restores its opener when dismissed—even with a stale Escape
 * push-to-talk binding.
 */
import {
  activeElement,
  launch,
  makeReport,
  openChat,
} from "../lib/harness.mjs";

const report = makeReport("voice modal");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  const opened = await page.evaluate(async () => {
    const raw = await fetch("/fragments/voice-call/a11y-probe").then((r) =>
      r.text()
    );
    const config = JSON.stringify({
      sttProvider: "browser",
      pttEnabled: true,
      pttKeys: ["Escape"],
    });
    const fragment = raw.replace(
      /<script type="application\/json" id="voice-status-cfg">[\s\S]*?<\/script>/,
      `<script type="application/json" id="voice-status-cfg">${config}</script>`,
    );
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("/fragments/voice-call/")) {
        return Promise.resolve(new Response(fragment, { status: 200 }));
      }
      if (url === "/api/voice/status") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              enabled: true,
              sttProvider: "browser",
              pttEnabled: true,
              pttKeys: ["Escape"],
            }),
            { status: 200 },
          ),
        );
      }
      if (url === "/api/voice/log") {
        return Promise.resolve(new Response("", { status: 204 }));
      }
      return realFetch(input, init);
    };

    class FakeWebSocket {
      static OPEN = 1;
      constructor() {
        this.readyState = FakeWebSocket.OPEN;
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    globalThis.WebSocket = FakeWebSocket;
    globalThis.SpeechRecognition = class {
      start() {}
      stop() {}
    };

    const opener = document.getElementById("action-menu-btn");
    opener.style.display = "flex";
    opener.focus();
    await globalThis.openVoiceChat("a11y-probe", opener);

    const dialog = document.getElementById("voice-overlay");
    const rect = dialog.getBoundingClientRect();
    return {
      tag: dialog.tagName,
      open: dialog.open,
      name: dialog.getAttribute("aria-labelledby"),
      focused: document.activeElement?.id,
      fullScreen: rect.x === 0 && rect.y === 0 &&
        rect.width === innerWidth && rect.height === innerHeight,
    };
  });
  report.check(
    "the named dialog opens full-screen and receives focus",
    opened.tag === "DIALOG" && opened.open &&
      opened.name === "voice-call-title" &&
      opened.focused === "voice-call-title" && opened.fullScreen,
    JSON.stringify(opened),
  );

  const backgroundBlocked = await page.evaluate(() => {
    document.getElementById("action-menu-btn").focus();
    return !!document.activeElement?.closest("#voice-overlay");
  });
  report.check("background controls cannot receive focus", backgroundBlocked);

  let escaped = null;
  for (let i = 0; i < 12 && !escaped; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() =>
      !!document.activeElement?.closest("#voice-overlay")
    );
    if (!inside) escaped = await activeElement(page);
  }
  report.check(
    "Tab stays inside the dialog",
    !escaped,
    escaped ? JSON.stringify(escaped) : "",
  );

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("voice-overlay"));
  await page.waitForFunction(() =>
    document.activeElement?.id === "action-menu-btn"
  );
  report.check(
    "Escape closes and restores focus despite a stale PTT binding",
    true,
  );
} finally {
  await browser.close();
}
report.done();
