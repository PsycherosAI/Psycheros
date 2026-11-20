/**
 * Accessibility contract tests for the in-app dialogs and the sidebar.
 *
 * The graph dialogs used to hide with opacity only, which left a closed form
 * in the tab order and in the accessibility tree; the sidebar is translated
 * off-screen rather than removed. These tests pin the markup that fixes both,
 * plus the label/required wiring the dialogs need to be usable by voice. The
 * chat delete dialog is built in JS, so its contract is pinned against the
 * source rather than a rendered template.
 */
import { assert, assertStringIncludes } from "@std/assert";
import {
  renderEntityCoreGraph,
  renderHeader,
  renderSidebar,
} from "../src/server/templates.ts";

const GRAPH_MODALS = [
  ["graph-create-modal", "graph-create-title"],
  ["graph-edit-modal", "graph-edit-title"],
  ["graph-edge-modal", "graph-edge-title"],
  ["graph-delete-modal", "graph-delete-title"],
];

const EMPTY_STATS = {
  totalNodes: 0,
  totalEdges: 0,
  nodesByType: {},
  edgesByType: {},
  vectorSearchAvailable: false,
};

Deno.test("graph dialogs are labelled dialogs with an existing title", () => {
  const html = renderEntityCoreGraph(EMPTY_STATS);

  for (const [id, titleId] of GRAPH_MODALS) {
    assertStringIncludes(html, `id="${id}"`);
    assert(
      new RegExp(`id="${id}"[^>]*role="dialog"`).test(html),
      `${id} is missing role=dialog`,
    );
    assert(
      new RegExp(`id="${id}"[^>]*aria-modal="true"`).test(html),
      `${id} is missing aria-modal`,
    );
    assert(
      new RegExp(`id="${id}"[^>]*aria-labelledby="${titleId}"`).test(html),
      `${id} is not labelled by ${titleId}`,
    );
    assertStringIncludes(html, `id="${titleId}"`);
  }
});

Deno.test("graph dialog fields are marked required without starting invalid", () => {
  const html = renderEntityCoreGraph(EMPTY_STATS);

  assert(
    !/\srequired[\s/>]/.test(html),
    "a required attribute makes Chrome report the empty field as invalid " +
      "before the user has typed anything",
  );
  for (
    const id of [
      "node-type",
      "node-label",
      "edit-node-type",
      "edit-node-label",
      "edge-type",
    ]
  ) {
    assert(
      new RegExp(`id="${id}"[^>]*aria-required="true"`).test(html),
      `${id} should be required without being invalid on render`,
    );
  }
});

Deno.test("graph dialog pickers have their From/To label associated", () => {
  const html = renderEntityCoreGraph(EMPTY_STATS);

  assertStringIncludes(html, '<label for="edge-from-search">From</label>');
  assertStringIncludes(html, '<label for="edge-to-search">To</label>');
  assertStringIncludes(html, 'id="edge-from-search"');
  assertStringIncludes(html, 'id="edge-to-search"');
});

Deno.test("graph view controls expose selection and a nonvisual route", () => {
  const html = renderEntityCoreGraph(EMPTY_STATS);

  assertStringIncludes(
    html,
    'id="gv-view-toggle" role="group" aria-label="Knowledge graph view"',
  );
  assert(
    /data-view="list"[^>]*aria-pressed="true"[^>]*aria-controls="gv-list-view"/
      .test(html),
    "List must expose its selected state and controlled view",
  );
  assert(
    /data-view="graph"[^>]*aria-pressed="false"[^>]*aria-controls="gv-graph-view"/
      .test(html),
    "Network must expose its selected state and controlled view",
  );
  assertStringIncludes(html, 'id="graph-network-help" class="sr-only"');
  assert(
    /id="graph-container"[^>]*aria-label="Knowledge graph network"[^>]*aria-describedby="graph-network-help"/
      .test(html),
    "the network must be named and reference its keyboard/nonvisual help",
  );
});

Deno.test("sidebar ships inert so a hidden panel is not tabbable", () => {
  const html = renderSidebar([]);

  assert(/<aside[^>]*id="sidebar"[^>]*\binert\b/.test(html));
});

Deno.test("sidebar toggle reports what it controls and its state", () => {
  const html = renderHeader();

  assertStringIncludes(html, 'aria-controls="sidebar"');
  assertStringIncludes(html, 'aria-expanded="false"');
});

Deno.test("chat delete dialog is modal and labelled, and moves focus", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );

  assert(
    js.includes(
      'role="dialog" aria-modal="true" aria-labelledby="modal-title"',
    ),
    "the delete dialog should be a labelled aria-modal dialog",
  );
  assertStringIncludes(js, 'id="modal-title"');
  assertStringIncludes(
    js,
    "backdrop?.querySelector('.modal-actions button')?.focus();",
  );
  assertStringIncludes(js, "const opener = deleteModalOpener;");
  assertStringIncludes(js, "if (!opener?.isConnected) return;");
  // A row action is hidden until its row is focused and a visibility flip is a
  // frame late, so the opener must be pinned visible while the dialog is open
  // or the focus handover silently fails.
  assertStringIncludes(js, "deleteModalOpener.style.visibility = 'visible'");
  assertStringIncludes(
    js,
    "querySelector('.conv-item')?.focus();",
  );
  assert(
    js.lastIndexOf("focusInputWhenReady();") >
      js.indexOf("if (wasCurrentDeleted)"),
    "deleting the active conversation leaves the empty state with no focused " +
      "control unless the composer takes focus",
  );
});

Deno.test("toast live region is inserted before it is filled", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );

  const inserted = js.indexOf("document.body.appendChild(toast)");
  const filled = js.indexOf("toast.textContent = message");
  assert(inserted > 0, "showToast should append the toast to the body");
  assert(
    filled > inserted,
    "a status region that arrives already populated is not announced; " +
      "insert it empty and set the text afterwards",
  );
});

Deno.test("a closed graph dialog is inert, not visibility:hidden", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/graph-view.js", import.meta.url),
  );
  const css = await Deno.readTextFile(
    new URL("../web/css/graph.css", import.meta.url),
  );

  assertStringIncludes(js, "modal.inert = !open;");
  assert(
    !/\.gv-modal\s*\{[^}]*visibility: hidden/.test(css),
    "a child inherits a visibility flip two to four frames late, so focus() " +
      "into a just-opened dialog is a silent no-op; inert is read straight " +
      "off the DOM",
  );
});

Deno.test("graph toasts are announced and a delete keeps focus in the view", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/graph-view.js", import.meta.url),
  );

  assertStringIncludes(js, "toast.setAttribute('role', 'status');");
  assert(
    js.indexOf("container.appendChild(toast)") <
      js.indexOf("toast.textContent = msg"),
    "the graph toast is a second implementation of the app toast; it needs " +
      "the same insert-empty-then-fill contract or it is never announced",
  );
  assert(
    !js.includes("globalThis.showToast ="),
    "assigning showToast on globalThis shadowed the app's role=status toast " +
      "for reindex-banner.js and the discord inline handler",
  );
  assertStringIncludes(js, "document.getElementById('gv-add-node')?.focus();");
});

Deno.test("graph mutations restore focus after replacing their card", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/graph-view.js", import.meta.url),
  );

  assertStringIncludes(js, "function focusNodeHeader(nodeId)");
  assertStringIncludes(js, "focusNodeHeader(fromId);");
  assertStringIncludes(js, "focusNodeHeader(nodeId);");
});

Deno.test("What's New is a modal with Escape, a focus trap, restore, and inert background", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/whats-new.js", import.meta.url),
  );

  assertStringIncludes(
    js,
    'overlay.setAttribute("aria-labelledby", "whats-new-title")',
  );
  assertStringIncludes(js, 'title.id = "whats-new-title"');
  assertStringIncludes(js, "function handleOverlayKeydown(");
  assertStringIncludes(js, 'event.key === "Escape"');
  assertStringIncludes(js, 'event.key !== "Tab"');
  assertStringIncludes(js, "child.inert = true");
  assertStringIncludes(js, "inert = false");
  assertStringIncludes(js, "opener.focus()");
  assertStringIncludes(js, 'document.getElementById("main")');
});
