/**
 * WCAG 4.1.2 / 2.1.1 / 2.4.3: the workspace dropdown only claims semantics it
 * implements, its rows are real links and buttons (the Cancel button is not
 * nested inside the session link), Escape closes it and returns focus to the
 * opener, and the pending-question toast names its answer field.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("Workspace dropdown");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);
  const convId = await page.evaluate(() =>
    location.pathname.split("/").filter(Boolean).pop() || "conv-test"
  );

  await page.evaluate((conv) => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const json = (body) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/workspace/sessions") {
        return json({
          sessions: [{
            id: "session-1",
            conversationId: conv,
            status: "running",
            goal: "Test workspace goal",
            mode: "sync",
          }],
        });
      }
      if (url === "/api/workspace/queries") {
        return json({
          pending: [{
            id: "query-1",
            sessionId: "session-1",
            question: "Which branch should I use?",
          }],
        });
      }
      return realFetch(input, init);
    };
  }, convId);

  const opened = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const trigger = document.createElement("button");
    trigger.id = "workspace-test-trigger";
    trigger.className = "state-seg";
    trigger.textContent = "Workspace (1)";
    document.body.appendChild(trigger);
    trigger.focus();
    await Psycheros.openWorkspaceList();
    for (
      let i = 0;
      i < 80 && !document.querySelector(".workspace-list-dropdown");
      i++
    ) {
      await sleep(50);
    }
    const dropdown = document.querySelector(".workspace-list-dropdown");
    const queryRow = dropdown?.querySelector(".query-row");
    const sessionRow = dropdown?.querySelector(".session-row");
    const link = sessionRow?.querySelector("a[href]");
    const cancel = sessionRow?.querySelector(".session-cancel-btn");
    return {
      mounted: !!dropdown,
      role: dropdown?.getAttribute("role") ?? "",
      label: dropdown?.getAttribute("aria-label") ?? "",
      queryTag: queryRow?.tagName ?? "",
      queryType: queryRow?.getAttribute("type") ?? "",
      link: !!link,
      cancelSibling: !!cancel && cancel.parentElement === sessionRow,
      cancelInLink: !!link?.querySelector("button"),
      focusedQuery: document.activeElement === queryRow,
    };
  });

  report.check(
    "the dropdown is a named group instead of a menu it does not implement",
    opened.mounted && opened.role === "group" &&
      opened.label === "Workspace sessions and questions",
    JSON.stringify(opened),
  );
  report.check(
    "queries are native buttons and Cancel sits outside the session link",
    opened.queryTag === "BUTTON" && opened.queryType === "button" &&
      opened.link && opened.cancelSibling && !opened.cancelInLink,
    JSON.stringify(opened),
  );
  report.check(
    "opening moves focus to the first actionable row",
    opened.focusedQuery,
    JSON.stringify({ focusedQuery: opened.focusedQuery }),
  );

  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector(".workspace-list-dropdown"),
    null,
    { timeout: 5000 },
  );
  const escaped = await page.evaluate(() => ({
    focused: document.activeElement?.id ?? "",
    open: !!document.querySelector(".workspace-list-dropdown"),
  }));
  report.check(
    "Escape closes the dropdown and returns focus to the opener",
    !escaped.open && escaped.focused === "workspace-test-trigger",
    JSON.stringify(escaped),
  );

  await page.evaluate(async () => {
    await Psycheros.openWorkspaceList();
    for (
      let i = 0;
      i < 80 && !document.querySelector(".query-row");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    document.querySelector(".query-row").click();
  });
  await page.waitForSelector(".workspace-query-toast .toast-input", {
    timeout: 5000,
  });
  const toast = await page.evaluate(() => {
    const input = document.querySelector(
      ".workspace-query-toast .toast-input",
    );
    return {
      label: input?.getAttribute("aria-label") ?? "",
      placeholder: input?.placeholder ?? "",
      focused: document.activeElement === input,
      toast: !!document.querySelector(".workspace-query-toast"),
    };
  });
  report.check(
    "the pending-question toast gives its answer field a real name",
    toast.toast && toast.label.length > 0 && toast.focused,
    JSON.stringify(toast),
  );
} finally {
  await browser.close();
}
report.done();
