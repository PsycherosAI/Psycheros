/**
 * App-wide accessibility guards that are cheaper as source assertions than as
 * browser runs: the focus indicator, the forced-colors fallback, the
 * no-positive-tabindex rule, the off-canvas panel's inert attribute, the rule
 * that a control must not name itself twice with a differing title, and the
 * decorative sidebar scrim. The interactive checks live in ../e2e.
 */
import { assert, assertStringIncludes } from "@std/assert";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

// Every markup source the app ships. A placeholder is not an accessible name
// (WCAG 4.1.2), and a *named* field that also carries a placeholder makes
// Chrome expose the placeholder as a second child AX node, so JAWS voices both
// (Vispero tracks the family: standards-support #651, #652, #632, #679). We
// keep upstream's placeholders for visual parity and accept that duplication;
// what must never happen is a placeholder serving as the only name.
const APP_MARKUP = [
  "../src/server/templates.ts",
  "../src/server/server.ts",
  "../src/server/admin-templates.ts",
  "../src/server/skill-templates.ts",
  "../src/server/routes.ts",
  "../src/pulse/templates.ts",
  "../web/js/psycheros.js",
  "../web/js/workspace.js",
];

// A placeholder-bearing field is named when it carries aria-label/
// aria-labelledby, an id that a for= in the same file points at, or sits inside
// a wrapping <label>. Fields without a placeholder are out of scope here.
async function findPlaceholderOnlyNames(): Promise<string[]> {
  const found: string[] = [];
  for (const rel of APP_MARKUP) {
    const src = await read(rel);
    const targets = new Set(
      [...src.matchAll(/\bfor="([^"]+)"/g)].map((m) => m[1]),
    );
    const wrapped = [...src.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)]
      .map((m) => [m.index, m.index + m[0].length] as const);
    for (const m of src.matchAll(/<(input|textarea)\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/\bplaceholder=/.test(tag)) continue;
      if (/\baria-label(ledby)?=/.test(tag)) continue;
      const id = tag.match(/\bid="([^"]+)"/)?.[1];
      if (id && targets.has(id)) continue;
      if (wrapped.some(([a, b]) => m.index > a && m.index < b)) continue;
      found.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  return found;
}

Deno.test("the app keeps a visible focus indicator", async () => {
  const css = await read("../web/css/base.css");
  const rule = css.match(/:focus-visible\s*\{[^}]*\}/)?.[0] ?? "";
  assert(rule.length > 0, "base.css has no :focus-visible rule");
  assert(
    /outline:\s*(?!none)/.test(rule) || /box-shadow:/.test(rule),
    `focus indicator must be visible, not just outline:none: ${rule}`,
  );
});

Deno.test("focus survives forced-colors mode", async () => {
  const css = await read("../web/css/base.css");
  const block =
    css.match(/@media \(forced-colors: active\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert(block.length > 0, "base.css has no forced-colors fallback");
  assert(
    /outline:\s*(?!none)/.test(block),
    `forced-colors focus needs a real outline, not a shadow: ${block}`,
  );
});

Deno.test("clipped context disclosures keep an inset focus indicator", async () => {
  const css = await read("../web/css/components.css");
  const rule = css.match(
    /\.context-section-header:focus-visible\s*\{[^}]*\}/,
  )?.[0] ?? "";
  assert(/box-shadow:\s*inset/.test(rule), `missing inset focus ring: ${rule}`);
  assert(
    /outline-offset:\s*-/.test(rule),
    `forced-colors outline will be clipped: ${rule}`,
  );
});

Deno.test("Discord actions are reachable from a focused message row", async () => {
  const css = await read("../web/css/discord.css");
  const rule = (selector: string) => {
    const start = css.indexOf(selector + " {");
    assert(start >= 0, `${selector} has no rule`);
    return css.slice(start, css.indexOf("}", start) + 1);
  };

  for (const selector of [".discord-msg-edit-btn", ".discord-msg-action-btn"]) {
    const block = rule(selector);
    assert(
      /visibility:\s*hidden/.test(block) &&
        /pointer-events:\s*none/.test(block),
      `${selector} must stay out of the tab order until its row is focused`,
    );
    assert(
      !/display:\s*none/.test(block),
      `${selector} cannot be display:none or focus can never reach it`,
    );
    assertStringIncludes(css, `.discord-message:focus-within ${selector}`);
  }

  assertStringIncludes(css, ".discord-message:hover .discord-msg-edit-btn");
  assertStringIncludes(css, ".discord-message:hover .discord-msg-action-btn");
  assert(
    /@media \(hover: none\)[\s\S]*\.discord-message .discord-msg-edit-btn[\s\S]*\.discord-message .discord-msg-action-btn[\s\S]*visibility:\s*visible/
      .test(
        css,
      ),
    "touch devices need permanently visible message actions",
  );

  const focus = rule(".discord-message:focus-visible");
  assert(
    /outline:\s*2px solid var\(--c-accent\)/.test(focus) &&
      /outline-offset:\s*-2px/.test(focus),
    `Discord row focus ring must stay inside the row: ${focus}`,
  );
});

Deno.test("Discord message actions resolve their enclosing conversation", async () => {
  const js = await read("../web/js/psycheros.js");
  assert(
    /\.discord-channel-view\[data-conversation-id\]/.test(js),
    "Discord fragments do not use /c/<id>, so the view must supply the conversation id",
  );
});

Deno.test("forced-colors focus outranks the per-component outline:none", async () => {
  // textareas and spin buttons set `outline: none` on themselves, and those
  // rules load after base.css at equal specificity.
  const css = await read("../web/css/base.css");
  const block =
    css.match(/@media \(forced-colors: active\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert(
    /outline:\s*2px solid CanvasText\s*!important/.test(block),
    `forced-colors outline must override component rules: ${block}`,
  );
});

Deno.test("clipped rows and the attach proxy keep an inset focus indicator", async () => {
  const css = await read("../web/css/components.css");
  for (
    const selector of [
      ".conv-item-wrapper .conv-item:focus-visible",
      "label.attach-btn:focus-within",
    ]
  ) {
    const start = css.indexOf(selector + " {");
    assert(start >= 0, `${selector} has no focus rule`);
    const rule = css.slice(start, css.indexOf("}", start) + 1);
    assert(
      /outline-offset:\s*-/.test(rule),
      `${selector} ring will be clipped: ${rule}`,
    );
  }
});

Deno.test("no positive tabindex in the templates", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const positive = [...tmpl.matchAll(/tabindex="[1-9]\d*"/g)].map((m) => m[0]);
  assert(
    positive.length === 0,
    `a positive tabindex breaks visual order: ${positive.join(", ")}`,
  );
});

Deno.test("the off-canvas graph node panel ships inert", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const tag = tmpl.match(/<div id="graph-node-panel"[^>]*>/)?.[0] ?? "";
  assert(tag.length > 0, "graph node panel markup not found");
  assert(/\binert\b/.test(tag), `a closed node panel must be inert: ${tag}`);
});

Deno.test("the transcript announcer carries no aria-atomic", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const tag = tmpl.match(/<div id="transcript-announcer"[^>]*>/)?.[0] ?? "";
  assert(tag.length > 0, "transcript announcer markup not found");
  assert(
    !/aria-atomic/.test(tag),
    `aria-atomic="true" silences JAWS live regions on Firefox (standards-support#876): ${tag}`,
  );
});
Deno.test("no field's placeholder is its only name", async () => {
  const offending = await findPlaceholderOnlyNames();
  assert(
    offending.length === 0,
    `placeholder-only field (no aria-label/aria-labelledby and no for= label) at ${
      offending.join(", ")
    }`,
  );
});

// Every markup source, plus where each status message region lives. role
// "status" already implies aria-live="polite", but JAWS/VoiceOver are more
// reliable when the live region is explicit (standards-support #651 family),
// so both are required, and a status-classed region must not lose its role.
const STATUS_CLASSES = [
  "llm-status",
  "settings-editor-status",
  "settings-prompt-label-status",
];

async function findTags(
  test: (tag: string, classes: string) => boolean,
  files: string[] = APP_MARKUP,
): Promise<string[]> {
  const found: string[] = [];
  const re = /<[a-z][a-z0-9-]*\b[^>]*>/gi;
  for (const rel of files) {
    const src = await read(rel);
    for (const m of src.matchAll(re)) {
      const classes = m[0].match(/\bclass="([^"]*)"/i)?.[1] ?? "";
      if (test(m[0], classes)) {
        found.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  return found;
}

Deno.test("every status region sets aria-live explicitly", async () => {
  const offending = await findTags((tag) =>
    /\brole="status"/.test(tag) && !/\baria-live=/.test(tag)
  );
  assert(
    offending.length === 0,
    `role="status" without aria-live at ${offending.join(", ")}`,
  );
});

Deno.test("status message classes keep their ARIA role", async () => {
  const offending = await findTags((tag, classes) =>
    STATUS_CLASSES.some((c) => classes.split(/\s+/).includes(c)) &&
    !/\brole="status"/.test(tag)
  );
  assert(
    offending.length === 0,
    `status class without role="status" at ${offending.join(", ")}`,
  );
});

// A flex row drops whitespace-only text nodes, so the graph card header would
// voice "Selfme2 conns" as one run. The sr-only separator span restores the
// boundaries; guard both the definition and its use in each header span.
Deno.test("graph card headers keep their speech boundaries", async () => {
  const js = await read("../web/js/graph-view.js");
  assert(
    /const SPEECH_SEP = '<span class="sr-only">/.test(js),
    "graph-view.js lost the sr-only speech separator",
  );
  const spans = [
    ...js.matchAll(/<span class="gv-card-(label|conns)">([\s\S]*?)<\/span>/g),
  ];
  assert(spans.length >= 4, "expected label and conns spans in both headers");
  for (const [, kind, inner] of spans) {
    assert(
      /SPEECH_SEP/.test(inner),
      `gv-card-${kind} span is missing its speech separator: ${inner}`,
    );
  }
});

Deno.test("the graph list and canvas keep complete keyboard routes", async () => {
  const js = await read("../web/js/graph-view.js");
  assert(
    /<button type="button" class="gv-card-header"[^>]*aria-expanded=/.test(js),
    "graph card headers are not native disclosure buttons",
  );
  assert(
    /filteredNodes\.map\(renderNodeCard\)\.join\(''\)/.test(js),
    "the semantic List route does not render every filtered node",
  );
  assert(
    /btn\.setAttribute\('aria-pressed', String\(active\)\)/.test(js),
    "List/Network selection is not synchronized",
  );
  assert(
    /keyboard:\s*\{[\s\S]*?enabled:\s*true,[\s\S]*?bindToWindow:\s*false,[\s\S]*?autoFocus:\s*false/
      .test(js),
    "vis-network keyboard handling is not enabled and focus-scoped",
  );
  assert(
    /surface\.setAttribute\('role', 'group'\)/.test(js),
    "the focusable network surface needs a nameable role",
  );
  assert(
    /document\.getElementById\('graph-search'\)\?\.focus\(\)/.test(js),
    "graph focus needs a fallback when an edited card leaves the filter",
  );
  assert(
    !/class="gv-card(?: gv-card--expanded)?"[^>]*onclick=/.test(js) &&
      /class="gv-card-header"[^>]*onclick="toggleNodeCard/
        .test(js),
    "card expansion must use its semantic header button, not a click-only wrapper",
  );
});

// A leading "+" in a button's content joins its accessible name ("plus New"),
// which NVDA voiced for the sidebar New control. The glyph is
// decorative: hide it from AT with aria-hidden (or give the button an explicit
// aria-label) so the name matches the visible label text (WCAG 2.5.3).
Deno.test("a decorative plus glyph is not part of a button's name", async () => {
  const found: string[] = [];
  for (const rel of APP_MARKUP) {
    const src = await read(rel);
    for (const m of src.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) {
      // The accessible name is the aria-label when present, else the content
      // with aria-hidden subtrees (the decorative glyph) and tags dropped.
      const label = /\baria-label="([^"]*)"/.exec(m[0]);
      const name = label?.[1] ?? m[1]
        .replace(
          /<([a-z][a-z0-9-]*)\b[^>]*\baria-hidden="true"[^>]*>[\s\S]*?<\/\1>/gi,
          "",
        )
        .replace(/<[^>]*>/g, "");
      if (/^\s*\+/.test(name)) {
        found.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assert(
    found.length === 0,
    `button whose name starts with the decorative "+": ${found.join(", ")}`,
  );
});

// The context inspector button toggles a panel but exposed no state, so NVDA
// read the same "Toggle context viewer" before and after opening it.
// aria-expanded must start false and be updated on both paths.
Deno.test("the context viewer toggle exposes its state", async () => {
  const markup = await read("../web/js/psycheros.js");
  const tag =
    markup.match(/<button class="context-toggle action-row"[^>]*>/)?.[0] ?? "";
  assert(tag.length > 0, "context viewer toggle markup not found");
  assert(
    /aria-expanded="/.test(tag) &&
      /aria-controls="context-viewer"/.test(tag),
    `the toggle needs aria-expanded and aria-controls: ${tag}`,
  );
  const js = await read("../web/js/psycheros.js");
  assert(
    /setContextToggleExpanded\(true\)/.test(js) &&
      /setContextToggleExpanded\(false\)/.test(js),
    "the toggle's aria-expanded is never updated on open/close",
  );
});

// The Inspector markup hangs off <body>, away from the drawer row that opens
// it. It has to behave like a modal on its own: named, modal, inert while
// closed, focused on open, and restored to the trigger on close.
Deno.test("the context inspector is a modal dialog that owns focus", async () => {
  const js = await read("../web/js/psycheros.js");
  const tag =
    js.match(/<button class="context-toggle action-row"[^>]*>/)?.[0] ?? "";

  assert(
    /Psycheros\.closeActionDrawer\(\); Psycheros\.toggleContextViewer\(\)/
      .test(tag),
    "the drawer must close before the Inspector records and moves focus",
  );
  assert(
    /viewer\.setAttribute\('role', 'dialog'\)/.test(js) &&
      /viewer\.setAttribute\('aria-modal', 'true'\)/.test(js) &&
      /aria-labelledby', 'context-viewer-title'/.test(js) &&
      /id="context-viewer-title"/.test(js),
    "the Inspector is not exposed as a named modal dialog",
  );
  assert(
    /viewer\.inert = true/.test(js),
    "a closed Inspector stays in the tab order",
  );
  assert(
    /contextViewerOpener = document\.activeElement/.test(js) &&
      /opener\?\.isConnected/.test(js) &&
      /getElementById\('action-menu-btn'\)\?\.focus\(\)/.test(js),
    "the Inspector does not restore focus when it closes",
  );
  assert(
    /querySelector\('\.context-viewer-title'\)\?\.focus\(\)/.test(js),
    "opening the Inspector leaves focus outside the dialog",
  );
  assert(
    /function handleContextViewerKeydown\(event\)/.test(js) &&
      /event\.key === 'Escape'/.test(js) &&
      /event\.key !== 'Tab'/.test(js),
    "the Inspector has no Escape or Tab containment",
  );
});

// Push-to-talk was hold-only: the pointer circle had no keyboard path, the mic
// toggle exposed no state, and nothing announced record start/stop.
// A screen reader or switch user activates a control once,
// so the circle must answer Enter/Space as a toggle driving startPTT/endPTT,
// the toggle must carry aria-pressed, and the transitions must be announced.
Deno.test("the push-to-talk controls are keyboard-operable and expose state", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const mic = tmpl.match(
    /<button class="voice-btn" id="voice-btn-ptt-toggle"[^>]*>/,
  )?.[0] ?? "";
  assert(mic.length > 0, "push-to-talk mic toggle markup not found");
  assert(
    /aria-pressed="false"/.test(mic),
    `the PTT toggle needs aria-pressed starting false: ${mic}`,
  );
  const hold = tmpl.match(
    /<button class="voice-hold-circle" id="voice-hold-btn"[\s\S]*?>/,
  )?.[0] ?? "";
  assert(hold.length > 0, "hold-to-talk circle markup not found");
  assert(
    /onkeydown="handleHoldKey\(event\)"/.test(hold),
    `the hold circle needs a keyboard toggle handler: ${hold}`,
  );
  assert(
    /onclick="handleHoldClick\(event\)"/.test(hold),
    `the hold circle needs a click path for AT activation: ${hold}`,
  );

  const js = await read("../web/js/voice.js");
  assert(
    /globalThis\.handleHoldKey = handleHoldKey;/.test(js),
    "handleHoldKey is not exported for the inline keydown handler",
  );
  assert(
    /globalThis\.handleHoldClick = handleHoldClick;/.test(js),
    "handleHoldClick is not exported for the inline click handler",
  );
  const holdClick = js.slice(
    js.indexOf("function handleHoldClick"),
    js.indexOf("function entityTurnActive"),
  );
  assert(
    holdClick.indexOf("e.detail !== 0") < holdClick.indexOf("startPTT()"),
    "the click path must ignore pointer clicks so the press does not double-toggle",
  );
  const startPTT = js.slice(
    js.indexOf("function startPTT()"),
    js.indexOf("function endPTT()"),
  );
  assert(
    /if \(entityTurnActive\(\)\) return;/.test(startPTT),
    "startPTT must refuse while the entity is processing or speaking",
  );
  const refresh = js.slice(
    js.indexOf("function refreshDisplayState()"),
    js.indexOf("function updateConnectionStatus"),
  );
  assert(
    /setAttribute\('aria-disabled', String\(entityTurn\)\)/.test(refresh) &&
      !/holdBtn\.disabled\s*=/.test(refresh),
    "the hold circle must stay focusable via aria-disabled during the entity turn",
  );
  assert(
    /setAttribute\('aria-pressed', String\(pttEnabled\)\)/.test(js),
    "the PTT toggle's aria-pressed is never updated",
  );
  for (
    const msg of [
      "Push-to-talk on",
      "Push-to-talk off",
      "Recording",
      "Sent",
    ]
  ) {
    assert(
      new RegExp(`announceVoiceStatus\\([^)]*'${msg}'`).test(js),
      `PTT state change "${msg}" is not announced inside the voice dialog`,
    );
  }
});

Deno.test("PTT key capture keeps focus and lets Tab reach Cancel", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const js = await read("../web/js/psycheros.js");

  const hint = tmpl.match(
    /<div id="ptt-capture-hint"[\s\S]*?<\/div>/,
  )?.[0] ?? "";
  assert(hint.length > 0, "PTT capture hint markup not found");
  assert(
    /id="ptt-capture-status" role="status" aria-live="polite"/.test(hint),
    `the capture hint needs a live status region: ${hint}`,
  );
  assert(
    !/display:\s*none/.test(hint),
    "the capture hint must stay rendered so its live region is announced",
  );
  assert(
    /onclick="cancelPTTKeyCapture\(\)" hidden/.test(hint),
    "the Cancel button must stay hidden until capture starts",
  );
  assert(
    /onclick="capturePTTKey\(\)" aria-disabled="false"/.test(tmpl),
    "the Add binding trigger must expose its state",
  );
  const css = await read("../web/css/components.css");
  assert(
    /\.btn\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(css),
    "the .btn display rule must not override the hidden attribute",
  );

  const capture = js.slice(
    js.indexOf("function capturePTTKey()"),
    js.indexOf("function setPTTCaptureStatus"),
  );
  assert(
    !/addBtn\.style\.display = 'none'/.test(capture),
    "capture must not hide the focused Add binding trigger",
  );
  assert(
    /setAttribute\('aria-disabled', 'true'\)/.test(capture),
    "capture must mark the Add binding trigger aria-disabled",
  );
  assert(
    !/hint\.style\.display/.test(capture) &&
      /hint\.style\.marginTop = 'var\(--sp-2\)'/.test(capture) &&
      /cancelBtn\.hidden = false/.test(capture),
    "capture must reveal Cancel without hiding the live region",
  );
  assert(
    /Escape cancels/.test(capture),
    "the capture instructions must name Escape",
  );

  const handler = js.slice(
    js.indexOf("function handlePTTKeyCapture"),
    js.indexOf("function handlePTTMouseCapture"),
  );
  assert(
    /if \(e\.key === 'Tab'\) return;/.test(handler) &&
      handler.indexOf("e.key === 'Tab'") <
        handler.indexOf("addPTTKeyBinding("),
    "Tab must move focus instead of becoming a binding",
  );
  assert(
    /closest\('#ptt-capture-hint'\)/.test(handler),
    "activation keys on the Cancel button must not become bindings",
  );

  const cancel = js.slice(
    js.indexOf("function cancelPTTKeyCapture()"),
    js.indexOf("function handlePTTKeyCapture"),
  );
  assert(
    /addBtn\.setAttribute\('aria-disabled', 'false'\)/.test(cancel) &&
      /addBtn\.focus\(\)/.test(cancel),
    "cancelling capture must re-enable and focus the Add binding trigger",
  );
  assert(
    /cancelBtn\.hidden = true/.test(cancel) &&
      /status\.textContent = ''/.test(cancel),
    "cancelling capture must hide Cancel and clear the status text",
  );
});

Deno.test("leaving Yin Yang mode returns focus to its toggle", async () => {
  const js = await read("../web/js/voice.js");
  const toggle = js.slice(
    js.indexOf("function toggleYinYangMode"),
    js.indexOf("function handleVoiceTextInputKey"),
  );
  const exit = toggle.slice(toggle.indexOf("// Leaving Yin Yang mode"));
  assert(
    /if \(textHadFocus\) btn\?\.focus\(\)/.test(exit),
    "hiding the focused text input must move focus back to the toggle",
  );
});

// Test Effect and the API-key eye buttons were actionable but silent: a
// second click stacked an AudioContext on the first, playback success was
// never confirmed, and the eye icon exposed neither state nor which key it
// belongs to.
Deno.test("voice profile test and key controls expose state and busy", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const toggles = [...tmpl.matchAll(/<button[^>]*llm-toggle-key[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes("toggleVoiceFieldVisibility("));
  assert(
    toggles.length === 7,
    `expected the seven voice API-key toggles, found ${toggles.length}`,
  );
  const labels = new Set<string>();
  for (const tag of toggles) {
    const label = tag.match(/aria-label="([^"]+)"/)?.[1] ?? "";
    labels.add(label);
    assert(
      /aria-pressed="false"/.test(tag) &&
        /^Show .+ API key$/.test(label) &&
        /data-key-label="[^"]+ API key"/.test(tag) &&
        /toggleVoiceFieldVisibility\('[^']+', this\)/.test(tag),
      `voice API-key toggle needs initial state, a key-specific name, and its own button: ${tag}`,
    );
  }
  assert(
    labels.size === toggles.length,
    `each voice key toggle must name its own key: ${[...labels].join(", ")}`,
  );

  const effect =
    tmpl.match(/<button[^>]*onclick="testVoiceEffect\([^)]*\)"[^>]*>/)
      ?.[0] ?? "";
  assert(
    /onclick="testVoiceEffect\(this\)"/.test(effect),
    "Test Effect must pass its own button so it can announce and restore focus",
  );

  const app = await read("../web/js/psycheros.js");
  const toggle = app.slice(
    app.indexOf("function toggleVoiceFieldVisibility("),
    app.indexOf("function gatherVoiceProfile("),
  );
  assert(
    /setAttribute\('aria-pressed', show \? 'true' : 'false'\)/.test(toggle) &&
      /var label = \(show \? 'Hide ' : 'Show '\) \+ noun;/.test(toggle) &&
      /setAttribute\('aria-label', label\)/.test(toggle),
    "the key toggle must flip aria-pressed and the accessible name with the field type",
  );

  const js = await read("../web/js/voice.js");
  const start = js.indexOf("async function testVoiceEffect(");
  const effectTest = js.slice(start, js.indexOf("// =====", start));
  assert(
    /if \(voiceEffectTestBusy\) return;/.test(effectTest) &&
      /setAttribute\('aria-busy', 'true'\)/.test(effectTest) &&
      /setAttribute\('aria-disabled', 'true'\)/.test(effectTest) &&
      /announceStatus\('Testing ' \+ effectPhrase/.test(effectTest) &&
      /announceStatus\('Finished testing ' \+ effectLabel/.test(effectTest) &&
      /btn\.focus\(\)/.test(effectTest),
    "Test Effect must refuse overlap, expose busy state, announce start and result, and restore focus",
  );
});

// The profile Test TTS result only existed as a toast, which lands in a
// region that is inserted and removed on a timer, and the success message
// waited on playback that never resolves in a remote session.
Deno.test("Test TTS reports its result in a persistent status region", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const status = tmpl.match(
    /<span id="voice-test-status"[^>]*><\/span>/,
  )?.[0] ?? "";
  assert(
    /class="voice-test-status"/.test(status) &&
      /role="status"/.test(status) &&
      /aria-live="polite"/.test(status),
    `the Test TTS result needs a persistent live region: ${status}`,
  );

  const js = await read("../web/js/psycheros.js");
  const announce = js.slice(
    js.indexOf("function announceTtsTest("),
    js.indexOf("async function testTTSConnection("),
  );
  assert(
    /getElementById\('voice-test-status'\)/.test(announce),
    "announceTtsTest must fall back to the profile status region",
  );

  const test = js.slice(
    js.indexOf("async function testTTSConnection("),
    js.indexOf("function onVoiceTTSProviderChange("),
  );
  const okAt = test.indexOf("'TTS test OK ('");
  assert(
    okAt >= 0 && okAt < test.indexOf("audio.play()"),
    "the success result must be announced before playback is attempted",
  );
  assert(
    !/audio\.play\(\)\.then/.test(test),
    "the success result must not wait on playback to resolve",
  );
});

// The main LLM profile form had the same eye-button gap: title only, no
// pressed state, and no accessible name for the key.
Deno.test("the LLM API-key toggle exposes state and names its key", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const tag = tmpl.match(
    /<button[^>]*toggleApiKeyVisibility\([^)]*\)[^>]*>/,
  )?.[0] ?? "";
  assert(
    /aria-pressed="false"/.test(tag) &&
      /aria-label="Show LLM API key"/.test(tag) &&
      /title="Show LLM API key"/.test(tag) &&
      /data-key-label="LLM API key"/.test(tag) &&
      /toggleApiKeyVisibility\(this\)/.test(tag),
    `the LLM key toggle needs initial state and a key-specific name: ${tag}`,
  );
  const js = await read("../web/js/psycheros.js");
  const handler = js.slice(
    js.indexOf("function toggleApiKeyVisibility("),
    js.indexOf("function onProviderChange("),
  );
  assert(
    /toggleVoiceFieldVisibility\('llm-api-key', button\)/.test(handler),
    "the LLM key toggle must reuse the shared stateful field toggle",
  );
});

// The Flux overlay is a view, not a dialog: it needs a name for the region a
// screen reader lands in, and closing it must return focus to the Flux ON
// trigger (or the composer) instead of dropping to body.
Deno.test("the Flux view is named and closure returns focus", async () => {
  const tmpl = await read("../src/server/templates.ts");
  const overlay = tmpl.match(/<div class="flux-overlay"[^>]*>/)?.[0] ?? "";
  assert(
    /role="region"/.test(overlay) &&
      /aria-labelledby="flux-overlay-title"/.test(overlay),
    `the Flux overlay needs a named region: ${overlay}`,
  );
  assert(
    /<h2[^>]*id="flux-overlay-title"[^>]*>Flux<\/h2>/.test(tmpl),
    "the Flux view needs a real heading carrying its name",
  );

  const app = await read("../web/js/psycheros.js");
  const start = app.slice(
    app.indexOf("async function startFluxOverlay()"),
    app.indexOf("async function startVoiceCall()"),
  );
  assert(
    start.indexOf("document.activeElement") <
      start.indexOf("startFluxOverlayFn(convId, opener)"),
    "the Flux trigger must be captured before the overlay mounts",
  );

  const js = await read("../web/js/flux.js");
  const restore = js.slice(
    js.indexOf("function restoreFluxFocus()"),
    js.indexOf("function cleanup()"),
  );
  assert(
    /opener\.isConnected/.test(restore) &&
      /querySelector\('\.state-flux'\)/.test(restore) &&
      /getElementById\('message-input'\)/.test(restore),
    "closing Flux must fall back from the opener to Flux ON, then the composer",
  );
  const cleanup = js.slice(
    js.indexOf("function cleanup()"),
    js.indexOf("// Controls"),
  );
  assert(
    /moveFocus: false/.test(cleanup) && /restoreFluxFocus/.test(cleanup),
    "cleanup must keep the composer from stealing focus before the restore",
  );
});

Deno.test("the workspace dropdown uses the semantics it implements", async () => {
  const js = await read("../web/js/workspace.js");
  assert(
    !/setAttribute\("role", "menu"\)/.test(js),
    "the dropdown must not claim menu semantics without arrow-key handling",
  );
  assert(
    /createElement\("button"\)[\s\S]{0,160}className = "query-row"/.test(js),
    "pending query rows need native button semantics",
  );
  assert(
    /workspaceListKeydown[\s\S]{0,200}"Escape"/.test(js) &&
      /restoreFocus/.test(js),
    "Escape must close the dropdown and restore focus to its opener",
  );
});

Deno.test("the query toast names its answer field", async () => {
  const js = await read("../web/js/workspace.js");
  const start = js.indexOf('input.className = "toast-input"');
  assert(start >= 0, "the query toast input was not found");
  const field = js.slice(start, start + 400);
  assert(
    /aria-label/.test(field),
    "the answer field cannot rely on its placeholder for a name",
  );
});

Deno.test("the voice dialog owns focus, shortcuts, and teardown", async () => {
  const js = await read("../web/js/voice.js");
  const app = await read("../web/js/psycheros.js");
  const css = await read("../web/css/voice.css");

  const startCall = app.slice(
    app.indexOf("async function startVoiceCall()"),
    app.indexOf("function announceTtsTest("),
  );
  assert(
    startCall.indexOf("getElementById('action-menu-btn')") <
        startCall.indexOf("await fetch('/api/voice/status')") &&
      /openVoiceChat\(convId, opener\)/.test(startCall),
    "the Start call control must be captured before the status request",
  );

  assert(
    /openVoiceChat\(conversationId, opener = document\.activeElement\)/.test(
      js,
    ) &&
      /voiceCallOpener\s*=\s*opener/.test(js),
    "opening a call must remember its trigger",
  );
  assert(
    /\.showModal\(\)/.test(js) &&
      /getElementById\('voice-call-title'\)\?\.focus\(\)/.test(js),
    "opening a call must activate the native modal and move focus into it",
  );
  assert(
    /addEventListener\('cancel',[\s\S]*?endVoiceChat\(\)/.test(js),
    "the dialog cancel event must use the normal voice teardown",
  );
  assert(
    /addEventListener\('keydown', trapVoiceDialogFocus\)/.test(js),
    "the dialog must keep focus from falling through to the document body",
  );
  assert(
    /overlay\.close\(\)/.test(js) && /voiceCallOpener\?\.focus\(\)/.test(js),
    "closing a call must close the dialog and restore its opener",
  );
  assert(
    /closest\?\.\('button, input, textarea, select, a\[href\], \[contenteditable\]'\)/
      .test(js),
    "the global PTT shortcut must ignore native interactive controls",
  );
  assert(
    js.indexOf("if (e.code === 'Escape') return;") <
      js.indexOf("pttKeys.includes(e.code)"),
    "Escape must reach the dialog cancel event before PTT matching",
  );
  assert(
    /function handlePTTKeyCapture[\s\S]*?e\.code === 'Escape'[\s\S]*?cancelPTTKeyCapture\(\)/
      .test(app),
    "Escape must cancel key capture instead of becoming a PTT binding",
  );
  assert(
    !/toggleBtn\.blur\(\)|btn\.blur\(\)/.test(js),
    "mode toggles must not discard focus",
  );
  assert(
    /const call = chip\?\.closest\('#voice-overlay'\)/.test(js) &&
      /call\?\.isConnected && toolName/.test(js),
    "a delayed tool completion must not announce into a later call",
  );
  assert(
    /if \(moveFocus\) focusInputWhenReady\(\)/.test(app),
    "background refresh must be able to preserve restored dialog focus",
  );
  assert(
    /\.voice-overlay:not\(\[open\]\)/.test(css) &&
      /\.voice-overlay::backdrop/.test(css),
    "dialog CSS must suppress the closed element and neutralize its backdrop",
  );
});

Deno.test("no control names itself twice with a differing title", async () => {
  const found: string[] = [];
  for (const rel of APP_MARKUP) {
    const src = await read(rel);
    for (const m of src.matchAll(/<[a-zA-Z][^>]*>/g)) {
      const label = m[0].match(/aria-label="([^"]*)"/)?.[1];
      const title = m[0].match(/\stitle="([^"]*)"/)?.[1];
      if (label && title && label !== title) {
        found.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assert(found.length === 0, `differing aria-label and title on: ${found}`);
});

// Server-rendered markup, authored as TS template literals, plus the launcher
// dashboard. web/js/*.js is excluded: its markup lives inside JS string
// literals, where a source-level tag scan cannot separate tags from prose.
const TEMPLATE_MARKUP = [
  "../src/server/templates.ts",
  "../src/server/server.ts",
  "../src/server/admin-templates.ts",
  "../src/server/skill-templates.ts",
  "../src/server/routes.ts",
  "../src/pulse/templates.ts",
  "../../launcher/dashboard.ts",
];

// An <a> without an href is not a link: it takes no Enter activation and its
// target is not announced, so as a navigation control it is a dead tab stop.
Deno.test("every link carries an href", async () => {
  const offending = await findTags(
    (tag) => /^<a\b/i.test(tag) && !/\bhref\s*=/.test(tag),
    TEMPLATE_MARKUP,
  );
  assert(
    offending.length === 0,
    `anchor with no href: ${offending.join(", ")}`,
  );
});

// A click handler on a plain div/span is invisible to a keyboard or switch
// user unless the element also takes focus and announces itself.
Deno.test("interactive divs and spans keep keyboard semantics", async () => {
  const offending = await findTags(
    (tag) =>
      /^<(div|span)\b/i.test(tag) &&
      /\bonclick\s*=/.test(tag) &&
      !/\brole\s*=/.test(tag) &&
      !/\btabindex\s*=/.test(tag) &&
      !/aria-hidden="true"/.test(tag),
    TEMPLATE_MARKUP,
  );
  assert(
    offending.length === 0,
    `click handler on a non-control needs role+tabindex or a native element: ${
      offending.join(", ")
    }`,
  );
});

// A <label> that neither carries for= nor wraps a control names nothing, so it
// is only a visual heading in label clothing.
Deno.test("every label names a control", async () => {
  for (const rel of TEMPLATE_MARKUP) {
    const src = await read(rel);
    const bare = [...src.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)]
      .filter((m) =>
        !/\bfor\s*=/.test(m[1]) && !/<(input|select|textarea)\b/i.test(m[2])
      )
      .map((m) => src.slice(0, m.index).split("\n").length);
    assert(
      bare.length === 0,
      `unassociated <label> (no for=, no wrapped control) at ${rel}: ${
        bare.join(", ") || "none"
      }`,
    );
  }
});

Deno.test("the sidebar scrim stays out of the accessibility tree", async () => {
  const app = await read("../src/server/templates.ts");
  const tag = app.match(/<div class="sidebar-overlay"[^>]*>/)?.[0] ?? "";
  assert(tag.length > 0, "the sidebar overlay vanished");
  assert(/aria-hidden="true"/.test(tag), tag);
});

Deno.test("the background gallery is keyboard-selectable and shows its state", async () => {
  const app = await read("../src/server/templates.ts");
  const css = await read("../web/css/settings.css");

  assert(
    !/class="bg-gallery-item[^"]*"\s+onclick=/.test(app),
    "the gallery item wrapper must not keep a click-only onclick",
  );
  assert(
    /<button type="button" class="bg-gallery-select" aria-pressed="\\?\$\{[^}]*\}" aria-label="[^"]*" onclick="selectBackground/
      .test(app),
    "each gallery item needs a selection button that exposes aria-pressed",
  );
  assert(
    /el\.querySelector\('\.bg-gallery-select'\)\?\.setAttribute\('aria-pressed'/
      .test(app),
    "selecting or clearing a background must keep aria-pressed in sync",
  );
  assert(
    /getAttribute\('src'\) === url/.test(app),
    "selection must compare the serialized src; img.src is absolute",
  );
  assert(
    /\.bg-gallery-item:focus-within \.delete-btn/.test(css),
    "the delete button must be visible while the item has keyboard focus",
  );
});

Deno.test("settings status regions stay rendered while empty", async () => {
  const css = await read("../web/css/settings.css");
  // The rule's own comment explains why display:none was removed; strip
  // comments before checking so prose cannot fail the assertion.
  const base = (css.match(/\.settings-status\s*\{([^}]*)\}/)?.[1] ?? "")
    .replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );

  assert(base.length > 0, "the settings status rule vanished");
  assert(
    !/display:\s*none/.test(base),
    "a live region hidden with display:none is not announced when its message arrives",
  );
  assert(
    /\.settings-status\.visible\s*\{[^}]*margin-top/.test(css),
    "the visible status box must keep its spacing",
  );
});

Deno.test("the TTS test control and row editing keep keyboard focus", async () => {
  const templates = await read("../src/server/templates.ts");
  const app = await read("../web/js/psycheros.js");

  assert(
    !/id="test-tts-btn"/.test(templates),
    "the profile and voice-call Test TTS buttons must not share an id",
  );
  assertStringIncludes(templates, 'onclick="testTTSConnection(this)"');
  assertStringIncludes(templates, 'id="profile-test-tts-btn"');
  assertStringIncludes(templates, 'id="voice-test-tts-btn"');
  assertStringIncludes(templates, 'onclick="removePronunciationEntry(this)"');
  assertStringIncludes(
    templates,
    'aria-label="Remove pronunciation entry"',
  );
  assertStringIncludes(templates, 'onclick="removeSTTCorrectionEntry(this)"');
  assertStringIncludes(templates, 'aria-label="Remove STT correction"');

  const tts = app.slice(
    app.indexOf("async function testTTSConnection(button)"),
    app.indexOf("globalThis.testTTSConnection"),
  );
  assert(tts.length > 0, "testTTSConnection must accept its button element");
  assert(
    !/\.disabled\s*=\s*true/.test(tts),
    "disabling the focused Test TTS button drops keyboard focus to the body",
  );
  assertStringIncludes(tts, 'btn.setAttribute("aria-busy", "true")');
  assertStringIncludes(tts, 'btn.setAttribute("aria-disabled", "true")');
  assertStringIncludes(app, "function announceTtsTest(");
  assertStringIncludes(app, "#voice-overlay");
  assertStringIncludes(app, "#voice-announcer");
  assertStringIncludes(
    app,
    "row.querySelector('input[type=\"text\"]')?.focus()",
  );
  assertStringIncludes(app, "function removeRowAndRestoreFocus(");
});

Deno.test("the gallery lightbox is a named modal dialog that owns focus", async () => {
  const js = await read("../web/js/psycheros.js");

  assert(
    /overlay\.setAttribute\('role', 'dialog'\)/.test(js) &&
      /overlay\.setAttribute\('aria-modal', 'true'\)/.test(js) &&
      /aria-labelledby', 'gallery-lightbox-title'/.test(js) &&
      /id = 'gallery-lightbox-title'/.test(js),
    "the lightbox is not exposed as a named modal dialog",
  );
  assert(
    /app\.inert = true/.test(js) &&
      /app\.inert = galleryLightboxAppWasInert/.test(js),
    "the lightbox does not inert the page behind it",
  );
  assert(
    /galleryLightboxOpener = opener instanceof HTMLElement/.test(js) &&
      /opener && opener\.isConnected/.test(js),
    "the lightbox does not restore focus to the thumbnail",
  );
  assert(
    /function handleLightboxKeydown\(e\)/.test(js) &&
      /e\.key === 'Escape'/.test(js) &&
      /e\.key !== 'Tab'/.test(js),
    "the lightbox has no Escape or Tab containment",
  );
  assert(
    /overlay\.focus\(\)/.test(js),
    "opening the lightbox leaves focus outside the dialog",
  );
  assert(
    /<button type="button" class="gallery-thumb-btn"/.test(js) &&
      /aria-label="Open image '/.test(js),
    "the client-rendered thumbnail is not a named button",
  );
});
