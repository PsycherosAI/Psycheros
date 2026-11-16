/**
 * WCAG 4.1.3: starting, progressing, completing, and failing an admin import
 * announces through one polite status region, and the visual fill exposes a
 * real progressbar value.
 *
 * The import endpoints are mocked with streaming NDJSON so the specs stay
 * hermetic: no entity-core restart and no real .db file is involved.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("Admin import status");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  // The admin hub ships /js/admin.js; the entity-data fragment needs it.
  await page.evaluate(() =>
    htmx.ajax("GET", "/fragments/admin", {
      target: "#chat",
      swap: "innerHTML",
    })
  );
  await page.waitForFunction(
    () => typeof globalThis.adminImportChats === "function",
    null,
    {
      timeout: 15000,
    },
  );
  await page.evaluate(() =>
    htmx.ajax("GET", "/fragments/admin/entity-data", {
      target: "#chat",
      swap: "innerHTML",
    })
  );
  await page.waitForSelector("#admin-migration-chat-files", { timeout: 15000 });

  const chat = await page.evaluate(async () => {
    globalThis.alert = () => {};
    globalThis.confirm = () => true;
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const streamResponse = (events) =>
      new Response(
        new ReadableStream({
          start(controller) {
            let index = 0;
            const push = () => {
              if (index >= events.length) {
                controller.close();
                return;
              }
              controller.enqueue(
                encoder.encode(JSON.stringify(events[index++]) + "\n"),
              );
              setTimeout(push, 60);
            };
            setTimeout(push, 60);
          },
        }),
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    const chatEvents = [
      {
        phase: "db",
        total: 4,
        conversations_processed: 1,
        status: "Importing conversations",
      },
      {
        phase: "db",
        total: 4,
        conversations_processed: 2,
        status: "Importing conversations",
      },
      {
        phase: "db",
        done: true,
        total: 4,
        conversations_created: 2,
        messages_imported: 9,
      },
      {
        phase: "embed",
        total: 2,
        current: 1,
        status: "Embedding messages",
        elapsed: "1s",
      },
      {
        phase: "embed",
        total: 2,
        current: 2,
        status: "Embedding messages",
        elapsed: "2s",
      },
      {
        phase: "done",
        conversations_created: 2,
        messages_imported: 9,
        messages_embedded: 9,
        duration: "3s",
      },
    ];
    globalThis.fetch = (url, options) =>
      String(url).includes("/api/admin/data-migration/chats")
        ? Promise.resolve(streamResponse(chatEvents))
        : originalFetch(url, options);

    const bar = document.querySelector(
      "#admin-migration-chat-progress [role='progressbar']",
    );
    const values = [];
    new MutationObserver(() => {
      values.push(bar.getAttribute("aria-valuenow"));
    }).observe(bar, {
      attributes: true,
      attributeFilter: ["aria-valuenow"],
    });
    const statusEl = document.getElementById("admin-migration-chat-status");
    const log = [];
    new MutationObserver(() => log.push(statusEl.textContent)).observe(
      statusEl,
      { childList: true, characterData: true, subtree: true },
    );

    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "chats.db"));
    document.getElementById("admin-migration-chat-files").files =
      transfer.files;
    await globalThis.adminImportChats();

    const output = document.getElementById("admin-migration-chat-output");
    return {
      log,
      values,
      bar: {
        role: bar.getAttribute("role"),
        label: bar.getAttribute("aria-label"),
        min: bar.getAttribute("aria-valuemin"),
        max: bar.getAttribute("aria-valuemax"),
      },
      statusVisible: statusEl.offsetParent !== null,
      outputVisible: output.style.display !== "none",
      outputText: output.textContent.trim(),
    };
  });

  report.check(
    "the chat import fill is a named progressbar with 0-100 values",
    chat.bar.role === "progressbar" &&
      chat.bar.label === "Chat import progress" &&
      chat.bar.min === "0" &&
      chat.bar.max === "100",
    JSON.stringify(chat.bar),
  );
  report.check(
    "progressbar value tracks the streamed phase and finishes at 100",
    chat.values.includes("50") && chat.values.at(-1) === "100",
    JSON.stringify(chat.values),
  );
  report.check(
    "one polite region announces start, each phase and completion once",
    JSON.stringify(chat.log) ===
      JSON.stringify([
        "Chat import started.",
        "Importing conversations",
        "Embedding messages",
        "Chat import complete.",
      ]),
    JSON.stringify(chat.log),
  );
  report.check(
    "the status region stays exposed and the final results are visible",
    chat.statusVisible && chat.outputVisible &&
      chat.outputText.includes("Chat import complete.") &&
      chat.outputText.includes("Messages imported: 9"),
    chat.outputText.replace(/\s+/g, " ").slice(0, 120),
  );

  const graph = await page.evaluate(async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const events = [
      { phase: "restart", status: "Stopping entity-core..." },
      { phase: "restart", status: "Starting entity-core..." },
      { phase: "db", total: 6, nodes_processed: 3, status: "Importing nodes" },
      { phase: "db", total: 6, nodes_processed: 6, status: "Importing nodes" },
      {
        phase: "db",
        done: true,
        nodes_imported: 4,
        edges_imported: 2,
      },
      {
        phase: "embed",
        total: 2,
        current: 1,
        status: "Embedding nodes",
        elapsed: "1s",
      },
      {
        phase: "embed",
        total: 2,
        current: 2,
        status: "Embedding nodes",
        elapsed: "2s",
      },
      {
        phase: "done",
        nodes_imported: 4,
        edges_imported: 2,
        nodes_embedded: 4,
        duration: "4s",
      },
    ];
    globalThis.fetch = (url, options) =>
      String(url).includes("/api/admin/data-migration/graph")
        ? Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                let index = 0;
                const push = () => {
                  if (index >= events.length) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(
                    encoder.encode(JSON.stringify(events[index++]) + "\n"),
                  );
                  setTimeout(push, 60);
                };
                setTimeout(push, 60);
              },
            }),
            { status: 200 },
          ),
        )
        : originalFetch(url, options);

    const statusEl = document.getElementById("admin-migration-graph-status");
    const log = [];
    new MutationObserver(() => log.push(statusEl.textContent)).observe(
      statusEl,
      { childList: true, characterData: true, subtree: true },
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "graph.db"));
    document.getElementById("admin-migration-graph-files").files =
      transfer.files;
    await globalThis.adminImportGraph();

    const output = document.getElementById("admin-migration-graph-output");
    return {
      log,
      outputVisible: output.style.display !== "none",
      outputText: output.textContent.trim(),
      overlayHidden:
        document.getElementById("admin-migration-graph-overlay").style
          .display === "none",
    };
  });

  report.check(
    "the graph import announces restart, import, embedding and completion",
    JSON.stringify(graph.log) ===
      JSON.stringify([
        "Knowledge graph import started.",
        "Stopping entity-core...",
        "Importing nodes",
        "Embedding nodes",
        "Knowledge graph import complete.",
      ]),
    JSON.stringify(graph.log),
  );
  report.check(
    "the graph result is visible and the blocking overlay ends hidden",
    graph.outputVisible &&
      graph.outputText.includes("Knowledge graph import complete.") &&
      graph.overlayHidden,
    graph.outputText.replace(/\s+/g, " ").slice(0, 120),
  );
} finally {
  await browser.close();
}
report.done();
