/**
 * WCAG 2.4.3 / 4.1.2: the voice call is a named native modal, keeps focus
 * inside, and restores its opener when dismissed—even with a stale Escape
 * push-to-talk binding.
 */
import { readFileSync } from "node:fs";
import {
  activeElement,
  launch,
  makeReport,
  openChat,
} from "../lib/harness.mjs";

// The real /fragments/voice-call route 403s unless voice chat is enabled in
// the test data. This spec covers behavior, so it mounts a checked-in fixture
// instead; templates_a11y_test.ts keeps the fixture's ids in sync with
// renderVoiceCallView.
const FIXTURE = readFileSync(
  new URL("../fixtures/voice-call.html", import.meta.url),
  "utf8",
);

const report = makeReport("voice modal");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  const opened = await page.evaluate(async (fixture) => {
    const config = JSON.stringify({
      sttProvider: "browser",
      pttEnabled: true,
      pttKeys: ["Escape"],
    });
    const fragment = fixture.replace(
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

    const sockets = [];
    class FakeWebSocket {
      static OPEN = 1;
      constructor() {
        this.readyState = FakeWebSocket.OPEN;
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    globalThis.__voiceSocket = () => sockets[sockets.length - 1];
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
  }, FIXTURE);
  report.check(
    "the named dialog opens full-screen and receives focus",
    opened.tag === "DIALOG" && opened.open &&
      opened.name === "voice-call-title" &&
      opened.focused === "voice-call-title" && opened.fullScreen,
    JSON.stringify(opened),
  );

  const liveRegions = await page.evaluate(() => {
    const transcript = document.getElementById("voice-transcript");
    const announcer = document.getElementById("voice-announcer");
    return {
      transcriptLive: transcript?.getAttribute("aria-live"),
      transcriptRole: transcript?.getAttribute("role"),
      announcerLive: announcer?.getAttribute("aria-live"),
      announcerRole: announcer?.getAttribute("role"),
    };
  });
  report.check(
    "the transcript stays visual while the status channels announce",
    liveRegions.transcriptLive === null &&
      liveRegions.transcriptRole === null &&
      liveRegions.announcerLive === "polite" &&
      liveRegions.announcerRole === "status",
    JSON.stringify(liveRegions),
  );

  // The entity reply is spoken by TTS; a live transcript would repeat it.
  const transcriptUpdate = await page.evaluate(() => {
    globalThis.__voiceSocket().onmessage({
      data: JSON.stringify({
        type: "transcript",
        role: "assistant",
        text: "spoken by TTS",
      }),
    });
    const transcript = document.getElementById("voice-transcript");
    return {
      text: transcript?.textContent,
      live: transcript?.getAttribute("aria-live"),
      role: transcript?.getAttribute("role"),
    };
  });
  report.check(
    "an assistant transcript renders visually without live semantics",
    transcriptUpdate.text?.includes("spoken by TTS") &&
      transcriptUpdate.live === null && transcriptUpdate.role === null,
    JSON.stringify(transcriptUpdate),
  );

  const backgroundBlocked = await page.evaluate(() => {
    document.getElementById("action-menu-btn").focus();
    return !!document.activeElement?.closest("#voice-overlay");
  });
  report.check("background controls cannot receive focus", backgroundBlocked);

  const pttClick = await page.evaluate(() => {
    const btn = document.getElementById("voice-hold-btn");
    btn.focus();
    // Element.click() has detail 0, like an assistive-technology activation.
    btn.click();
    const started = {
      active: btn.classList.contains("voice-hold-circle--active"),
      label: btn.getAttribute("aria-label"),
    };
    btn.click();
    const stopped = {
      active: btn.classList.contains("voice-hold-circle--active"),
      label: btn.getAttribute("aria-label"),
    };
    return { started, stopped };
  });
  report.check(
    "an AT click starts and stops push-to-talk",
    pttClick.started.active && /Recording/.test(pttClick.started.label) &&
      !pttClick.stopped.active,
    JSON.stringify(pttClick),
  );

  const pointerClick = await page.evaluate(() => {
    const btn = document.getElementById("voice-hold-btn");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    return btn.classList.contains("voice-hold-circle--active");
  });
  report.check(
    "a pointer click does not double-toggle after mouseup",
    pointerClick === false,
  );

  const turnFocus = await page.evaluate(() => {
    const btn = document.getElementById("voice-hold-btn");
    btn.focus();
    globalThis.__voiceSocket().onmessage({
      data: JSON.stringify({ type: "state", state: "processing" }),
    });
    const processing = {
      focused: document.activeElement === btn,
      ariaDisabled: btn.getAttribute("aria-disabled"),
    };
    globalThis.__voiceSocket().onmessage({
      data: JSON.stringify({ type: "state", state: "idle" }),
    });
    const idle = {
      focused: document.activeElement === btn,
      ariaDisabled: btn.getAttribute("aria-disabled"),
    };
    return { processing, idle };
  });
  report.check(
    "the entity turn keeps focus on the hold button via aria-disabled",
    turnFocus.processing.focused &&
      turnFocus.processing.ariaDisabled === "true" &&
      turnFocus.idle.focused && turnFocus.idle.ariaDisabled === "false",
    JSON.stringify(turnFocus),
  );

  const yinYang = await page.evaluate(async () => {
    const toggle = document.getElementById("voice-btn-yinyang");
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const entered = document.activeElement?.id;
    toggle.click();
    return {
      entered,
      exited: document.activeElement?.id,
      pressed: toggle.getAttribute("aria-pressed"),
    };
  });
  report.check(
    "leaving text mode returns focus to the Yin Yang toggle",
    yinYang.entered === "voice-text-input" &&
      yinYang.exited === "voice-btn-yinyang" &&
      yinYang.pressed === "false",
    JSON.stringify(yinYang),
  );

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
