/**
 * Accessibility contract tests for the standalone graph preview
 * (ACCESSIBILITY-AUDIT.md findings 6, 7 and 8).
 *
 * Node cards were click-only divs, the network was a keyboard-disabled canvas
 * with no name, and the four dialogs had no role, no focus handling and no
 * Escape. The page is a static file, so the contract is pinned against its
 * source rather than a rendered template.
 */
import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";

const graphHtml = await Deno.readTextFile(
  new URL("../../web/graph.html", import.meta.url),
);

const DIALOGS = [
  ["graph-create-modal", "graph-create-title"],
  ["graph-edit-modal", "graph-edit-title"],
  ["graph-edge-modal", "graph-edge-title"],
  ["graph-delete-modal", "graph-delete-title"],
];

Deno.test("graph node cards are native disclosure buttons", () => {
  assertNotMatch(
    graphHtml,
    /<div class="gv-card-header"/,
    "a click-only div cannot be reached or expanded by keyboard",
  );
  assertMatch(
    graphHtml,
    /<button type="button" class="gv-card-header" aria-expanded="false" aria-controls="\$\{detailId\}"/,
  );
  assertMatch(
    graphHtml,
    /<button type="button" class="gv-card-header" aria-expanded="true" aria-controls="\$\{detailId\}"/,
  );
  assertMatch(graphHtml, /function focusNodeHeader\(nodeId\)/);
  assertMatch(
    graphHtml,
    /renderListView\(\);\n\s*focusNodeHeader\(nodeId\);/,
    "expanding or collapsing a card must hand focus back to its header",
  );
});

Deno.test("graph list expands the selected node while keeping every node rendered", () => {
  const source = graphHtml.match(
    /^( *)function renderListView\(\) \{[\s\S]*?\n\1\}/m,
  )?.[0];
  assertMatch(source ?? "", /function renderListView/);
  const container = { innerHTML: "" };
  const render = new Function(
    "document",
    "filteredNodes",
    "expandedNodeId",
    "renderNodeCard",
    "renderNodeDetail",
    `${source}; renderListView();`,
  );
  const nodes = Array.from({ length: 100 }, (_, id) => ({ id }));
  for (const expanded of [null, 99, null]) {
    const collapsed: number[] = [];
    const details: number[] = [];
    render(
      { getElementById: () => container },
      nodes,
      expanded,
      (node: { id: number }) => {
        collapsed.push(node.id);
        return "card";
      },
      (node: { id: number }) => {
        details.push(node.id);
        return "detail";
      },
    );
    assertEquals(collapsed.length + details.length, 100);
    assertEquals(details, expanded === null ? [] : [99]);
    assertEquals(collapsed.includes(99), expanded === null);
  }
});

Deno.test("graph network is named, keyboard-driven and described", () => {
  assertMatch(
    graphHtml,
    /keyboard:\s*\{\s*enabled:\s*true,\s*bindToWindow:\s*false,\s*autoFocus:\s*false,\s*\}/,
    "vis-network keyboard handling must be enabled and focus-scoped",
  );
  assertMatch(graphHtml, /surface\.setAttribute\("role", "group"\)/);
  assertMatch(graphHtml, /id="graph-network-help" class="sr-only"/);
  assertMatch(
    graphHtml,
    /id="graph-container"[^>]*role="region"[^>]*aria-label="Knowledge graph network"[^>]*aria-describedby="graph-network-help"/,
    "the network surface needs a name and a nonvisual route",
  );
  assertMatch(
    graphHtml,
    /data-view="list"[^>]*aria-pressed="true"[^>]*aria-controls="gv-list-view"/s,
  );
  assertMatch(
    graphHtml,
    /data-view="graph"[^>]*aria-pressed="false"[^>]*aria-controls="gv-graph-view"/s,
  );
  assertMatch(
    graphHtml,
    /btn\.setAttribute\(\s*"aria-pressed",/,
    "List/Network selection state is not synchronized",
  );
});

Deno.test("graph dialogs are named and inert while closed", () => {
  for (const [id, titleId] of DIALOGS) {
    assertMatch(graphHtml, new RegExp(`id="${id}"[^>]*role="dialog"`));
    assertMatch(graphHtml, new RegExp(`id="${id}"[^>]*aria-modal="true"`));
    assertMatch(
      graphHtml,
      new RegExp(`id="${id}"[^>]*aria-labelledby="${titleId}"`),
    );
    assertMatch(
      graphHtml,
      new RegExp(`id="${id}"[^>]*\\binert\\b`),
      `${id} must ship inert so a closed form stays out of the tab order`,
    );
    assertMatch(graphHtml, new RegExp(`id="${titleId}"`));
  }
});

Deno.test("graph dialogs move focus, trap Tab, close on Escape and restore", () => {
  assertMatch(
    graphHtml,
    /function syncModalState\(modal\)\s*\{[\s\S]*?modal\.inert = !open;/,
  );
  assertMatch(
    graphHtml,
    /modal\.querySelector\(MODAL_FOCUSABLE\)\?\.focus\(\)/,
    "opening a dialog must move focus into it",
  );
  assertMatch(
    graphHtml,
    /if \(focusOutsideModal\?\.isConnected\) focusOutsideModal\.focus\(\)/,
    "closing a dialog must hand focus back to what opened it",
  );
  assertMatch(
    graphHtml,
    /if \(e\.key === "Escape"\)\s*\{\s*e\.preventDefault\(\);\s*modal\.classList\.remove\("gv-modal-open"\);/,
  );
  assertMatch(graphHtml, /if \(e\.key !== "Tab"\) return;/);
  assertMatch(
    graphHtml,
    /id="graph-node-panel"[^>]*\binert\b/,
    "the off-canvas node panel keeps its buttons tabbable while closed",
  );
});
