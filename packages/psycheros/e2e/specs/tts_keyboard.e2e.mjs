/**
 * WCAG 2.4.3 / 4.1.3: Test TTS keeps keyboard focus and announces its
 * result, and adding or removing pronunciation and correction rows leaves
 * focus on a meaningful control.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("tts keyboard");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  await page.evaluate(() => {
    htmx.ajax("GET", "/fragments/settings/voice/new", {
      target: "#chat",
      swap: "innerHTML",
    });
  });
  await page.waitForSelector("#profile-test-tts-btn", { timeout: 10000 });

  await page.evaluate(() => {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.__realFetch = realFetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/voice/test-tts") {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({ error: "provider unreachable" }),
                {
                  status: 502,
                  headers: { "Content-Type": "application/json" },
                },
              ),
            );
          }, 250);
        });
      }
      return realFetch(input, init);
    };
    document.getElementById("profile-test-tts-btn").focus();
  });
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.getElementById("voice-test-status").textContent ===
        "Testing TTS connection",
    null,
    { timeout: 5000 },
  );

  const busy = await page.evaluate(() => {
    const btn = document.getElementById("profile-test-tts-btn");
    return {
      focused: document.activeElement === btn,
      busy: btn.getAttribute("aria-busy"),
      disabled: btn.hasAttribute("disabled"),
    };
  });
  report.check(
    "the focused Test TTS button stays focusable while busy",
    busy.focused && busy.busy === "true" && !busy.disabled,
    JSON.stringify(busy),
  );

  await page.waitForFunction(
    () =>
      document.getElementById("voice-test-status").textContent.includes(
        "provider unreachable",
      ),
    null,
    { timeout: 5000 },
  );
  const result = await page.evaluate(() => {
    const btn = document.getElementById("profile-test-tts-btn");
    return {
      focused: document.activeElement === btn,
      busy: btn.getAttribute("aria-busy"),
      status: document.getElementById("voice-test-status")?.textContent ?? "",
    };
  });
  report.check(
    "the failure is announced and focus stays on the button",
    result.focused && result.busy === null &&
      result.status.includes("TTS test failed: provider unreachable"),
    JSON.stringify(result),
  );

  const added = await page.evaluate(() => {
    document.getElementById("add-pronunciation-btn").click();
    const list = document.getElementById("pronunciation-list");
    return {
      count: list.querySelectorAll(".pronunciation-row").length,
      focused: document.activeElement?.getAttribute("aria-label"),
      remove: list.querySelector(".pronunciation-row button")
        ?.getAttribute("aria-label"),
    };
  });
  report.check(
    "adding a pronunciation row focuses its first field",
    added.count === 1 && added.focused === "Written form" &&
      added.remove === "Remove pronunciation entry",
    JSON.stringify(added),
  );

  await page.evaluate(() => {
    document.querySelector("#pronunciation-list .pronunciation-row button")
      .focus();
  });
  await page.keyboard.press("Enter");
  const removedLast = await page.evaluate(() => ({
    count: document.querySelectorAll("#pronunciation-list .pronunciation-row")
      .length,
    focused: document.activeElement?.id ?? "",
  }));
  report.check(
    "removing the last row returns focus to Add Entry",
    removedLast.count === 0 && removedLast.focused === "add-pronunciation-btn",
    JSON.stringify(removedLast),
  );

  await page.evaluate(() => {
    globalThis.addPronunciationEntry();
    globalThis.addPronunciationEntry();
    document.querySelector("#pronunciation-list .pronunciation-row button")
      .focus();
  });
  await page.keyboard.press("Enter");
  const removedFirst = await page.evaluate(() => ({
    count: document.querySelectorAll("#pronunciation-list .pronunciation-row")
      .length,
    label: document.activeElement?.getAttribute("aria-label"),
    onButton: document.activeElement?.tagName === "BUTTON",
  }));
  report.check(
    "removing a row moves focus to the next row's Remove button",
    removedFirst.count === 1 && removedFirst.onButton &&
      removedFirst.label === "Remove pronunciation entry",
    JSON.stringify(removedFirst),
  );

  const stt = await page.evaluate(() => {
    document.getElementById("add-stt-correction-btn").click();
    return {
      count:
        document.querySelectorAll("#stt-corrections-list .stt-correction-row")
          .length,
      focused: document.activeElement?.getAttribute("aria-label"),
    };
  });
  report.check(
    "adding a correction row focuses its first field",
    stt.count === 1 && stt.focused === "Misheard form",
    JSON.stringify(stt),
  );

  const announcer = await page.evaluate(async () => {
    const overlay = document.createElement("div");
    overlay.id = "voice-overlay";
    overlay.innerHTML =
      '<button id="fake-tts">Test TTS</button><div id="voice-announcer" role="status" aria-live="polite"></div>';
    document.body.appendChild(overlay);
    await globalThis.testTTSConnection(overlay.querySelector("#fake-tts"));
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    const text = overlay.querySelector("#voice-announcer").textContent;
    overlay.remove();
    return text;
  });
  report.check(
    "inside the voice dialog the result is announced in the dialog",
    announcer.includes("TTS test failed: provider unreachable"),
    announcer,
  );

  // Test Effect: the focused button stays operable-looking but busy, a second
  // activation cannot stack another run, and failure/completion are announced.
  await page.evaluate(() => {
    document.getElementById("voice-test-effect-btn").focus();
  });
  await page.keyboard.press("Enter");
  const effectBusy = await page.evaluate(() => {
    const btn = document.getElementById("voice-test-effect-btn");
    return {
      focused: document.activeElement === btn,
      busy: btn.getAttribute("aria-busy"),
      disabled: btn.getAttribute("aria-disabled"),
    };
  });
  report.check(
    "Test Effect stays focusable and exposes busy while it runs",
    effectBusy.focused && effectBusy.busy === "true" &&
      effectBusy.disabled === "true",
    JSON.stringify(effectBusy),
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".toast")].some((toast) =>
        toast.textContent.includes("Test failed")
      ),
    null,
    { timeout: 5000 },
  );
  const effectFailed = await page.evaluate(() => {
    const btn = document.getElementById("voice-test-effect-btn");
    return {
      focused: document.activeElement === btn,
      busy: btn.getAttribute("aria-busy"),
      disabled: btn.getAttribute("aria-disabled"),
      toast: document.querySelector(".toast")?.textContent ?? "",
    };
  });
  report.check(
    "a failed Test Effect run clears busy, keeps focus, and announces the failure",
    effectFailed.focused && effectFailed.busy === null &&
      effectFailed.disabled === null &&
      effectFailed.toast.includes("Test failed"),
    JSON.stringify(effectFailed),
  );

  const effectStarted = await page.evaluate(() => {
    globalThis.__fakeAudioContexts = 0;
    const realFetch = globalThis.__realFetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/voice/test-tts") {
        return Promise.resolve(
          new Response(new Uint8Array([0, 0, 0, 0]), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
        );
      }
      return realFetch(input, init);
    };
    globalThis.AudioContext = class FakeAudioContext {
      constructor() {
        globalThis.__fakeAudioContexts++;
        this.state = "running";
        this.destination = {};
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      decodeAudioData() {
        return Promise.resolve({ duration: 0.05 });
      }
      createBufferSource() {
        const source = {
          buffer: null,
          onended: null,
          connect() {},
          start() {
            setTimeout(() => source.onended?.(), 80);
          },
        };
        return source;
      }
      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
    };
    const btn = document.getElementById("voice-test-effect-btn");
    btn.focus();
    globalThis.testVoiceEffect(btn);
    // A second activation before playback ends must be ignored.
    globalThis.testVoiceEffect(btn);
    return { busy: btn.getAttribute("aria-busy") };
  });
  report.check(
    "Test Effect marks itself busy before the audio is ready",
    effectStarted.busy === "true",
    JSON.stringify(effectStarted),
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".toast")].some((toast) =>
        toast.textContent.includes("Finished testing")
      ),
    null,
    { timeout: 5000 },
  );
  const effectDone = await page.evaluate(() => {
    const btn = document.getElementById("voice-test-effect-btn");
    return {
      focused: document.activeElement === btn,
      busy: btn.getAttribute("aria-busy"),
      contexts: globalThis.__fakeAudioContexts,
      toast: document.querySelector(".toast")?.textContent ?? "",
      announced: document.getElementById("transcript-announcer")
        ?.textContent ?? "",
    };
  });
  report.check(
    "a successful Test Effect run refuses overlap, announces completion, and clears busy",
    effectDone.focused && effectDone.busy === null &&
      effectDone.contexts === 1 &&
      effectDone.toast.includes("Finished testing") &&
      effectDone.announced === "Finished testing no effect",
    JSON.stringify(effectDone),
  );

  // API-key eye buttons: the icon needs a pressed state and a name that says
  // which key it belongs to.
  await page.evaluate(() => {
    const tts = document.getElementById("voice-tts-provider");
    tts.value = "minimax";
    globalThis.onVoiceTTSProviderChange();
    const stt = document.getElementById("voice-stt-provider");
    stt.value = "deepgram";
    globalThis.onVoiceSTTProviderChange();
  });
  const keyState = await page.evaluate(() => {
    const input = document.getElementById("stt-deepgram-api-key");
    const btn = input.parentElement.querySelector("button");
    btn.focus();
    return {
      focused: document.activeElement === btn,
      label: btn.getAttribute("aria-label"),
      pressed: btn.getAttribute("aria-pressed"),
      title: btn.getAttribute("title"),
      type: input.type,
      other: document.getElementById("tts-minimax-api-key")
        .parentElement.querySelector("button").getAttribute("aria-label"),
    };
  });
  await page.keyboard.press("Enter");
  const keyShown = await page.evaluate(() => {
    const input = document.getElementById("stt-deepgram-api-key");
    const btn = input.parentElement.querySelector("button");
    return {
      focused: document.activeElement === btn,
      label: btn.getAttribute("aria-label"),
      pressed: btn.getAttribute("aria-pressed"),
      title: btn.getAttribute("title"),
      type: input.type,
    };
  });
  await page.keyboard.press("Enter");
  const keyHidden = await page.evaluate(() => {
    const input = document.getElementById("stt-deepgram-api-key");
    const btn = input.parentElement.querySelector("button");
    return {
      label: btn.getAttribute("aria-label"),
      pressed: btn.getAttribute("aria-pressed"),
      type: input.type,
    };
  });
  report.check(
    "the key eye toggle names its own key and flips pressed state with the field type",
    keyState.focused && keyState.label === "Show Deepgram API key" &&
      keyState.pressed === "false" && keyState.type === "password" &&
      keyState.title === keyState.label &&
      keyState.other === "Show Minimax API key" &&
      keyShown.focused && keyShown.label === "Hide Deepgram API key" &&
      keyShown.pressed === "true" && keyShown.type === "text" &&
      keyShown.title === keyShown.label &&
      keyHidden.label === "Show Deepgram API key" &&
      keyHidden.pressed === "false" && keyHidden.type === "password",
    JSON.stringify({ keyState, keyShown, keyHidden }),
  );
} finally {
  await browser.close();
}
report.done();
