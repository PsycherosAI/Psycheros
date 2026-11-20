/**
 * Accessibility contract tests for the chat view templates.
 *
 * Guards the chat-view screen-reader contract: conversation
 * list items must be keyboard reachable and free of interactive content
 * nested inside a link, and the chat view must expose a heading, a live
 * region that only announces what the app appends, and labelled controls.
 * Adjacent inline spans in a flex header must not be announced as a single
 * run.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderAdminEntityData } from "../src/server/admin-templates.ts";
import {
  renderAppShell,
  renderAssistantMessage,
  renderChatView,
  renderConversationItem,
  renderCorePromptsSettings,
  renderDiscordChannelView,
  renderEmptyState,
  renderEntityCoreHub,
  renderFluxOverlayView,
  renderFluxSettings,
  renderFluxSpacePage,
  renderGeneralSettings,
  renderInputArea,
  renderMemoriesView,
  renderModelSettingsShell,
  renderSidebar,
  renderThinkingSection,
  renderToolCard,
  renderUserMessage,
  renderVisionGalleryTab,
  renderVisionSettings,
  renderVoiceCallView,
} from "../src/server/templates.ts";
import { getDefaultFluxSettings } from "../../entity-flux/src/mod.ts";
import { getDefaultImageGenSettings } from "../src/llm/image-gen-settings.ts";
import { renderPulseSettings } from "../src/pulse/templates.ts";
import type { Conversation, Message, PulseStats } from "../src/types.ts";
import type { VoiceProfile } from "../src/llm/voice-settings.ts";

function makeConversation(): Conversation {
  return {
    id: "conv-1",
    title: "Test conversation",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    sourceType: "web",
  };
}

const VOICE_PROFILE = {
  providerSettings: { stt: { provider: "browser", browser: {} } },
  endOfTurnSilence: 1.5,
  phraseDebounceMs: 1200,
  sttDebug: false,
  voiceEffect: "none",
} as VoiceProfile;

/** The text a screen reader gets: tags stripped, whitespace collapsed. */
function spokenText(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

Deno.test("conversation item is focusable and holds no interactive content", () => {
  const html = renderConversationItem(makeConversation(), false, false);

  assertStringIncludes(html, 'href="/c/conv-1"');
  assertStringIncludes(html, 'class="conv-select-checkbox"');

  const anchor = html.match(/<a class="conv-item[\s\S]*?<\/a>/)?.[0] ?? "";
  assert(anchor.length > 0, "conversation item anchor not found");
  assertEquals(
    /<(button|input)\b/.test(anchor),
    false,
    "interactive content nested inside the conversation link",
  );
});

Deno.test("conversation row leaves the swap to the app, not to htmx", () => {
  const html = renderConversationItem(makeConversation(), false, false);
  const anchor = html.match(/<a class="conv-item[\s\S]*?<\/a>/)?.[0] ?? "";

  assertStringIncludes(anchor, 'href="/c/conv-1"');
  assertEquals(
    /hx-(get|target|swap|push-url)=/.test(anchor),
    false,
    "hx-get on the conversation anchor makes every click swap #chat twice",
  );
});

Deno.test("the New conversation button is named and keeps the plus silent", () => {
  const html = renderSidebar([makeConversation()]);
  const button = html.match(
    /<button\b[^>]*onclick="Psycheros\.newConversation\(\)"[^>]*>[\s\S]*?<\/button>/,
  )?.[0] ?? "";
  assert(button.length > 0, "New conversation button not found in the sidebar");

  // The name lives on the button, so the split spans cannot concatenate into
  // "Newconversation" (NVDA run 2026-11-16 on the series tip).
  assertStringIncludes(button, 'aria-label="New conversation"');

  // The decorative plus must stay out of the name.
  assert(
    /<span[^>]*aria-hidden="true"[^>]*>\s*\+\s*<\/span>/.test(button),
    "the decorative plus glyph is not aria-hidden",
  );

  // Label in name: the text a screen reader reads from the markup still says
  // "New", and that is a prefix of the aria-label.
  const visible = spokenText(
    button.replace(/<span[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, ""),
  );
  assertEquals(visible, "New");
  assert(
    "new conversation".startsWith(visible.toLowerCase()),
    `visible text ${JSON.stringify(visible)} is not in the accessible name`,
  );
});

Deno.test("chat view exposes a heading and a muted live region", () => {
  const html = renderChatView([], undefined, undefined, false);

  assertStringIncludes(html, '<h1 class="sr-only">Conversation</h1>');
  assertStringIncludes(html, 'role="log"');
  // Muted on render and never armed, so the history inside is not announced as
  // a whole; new replies go through #transcript-announcer (announceTranscript).
  assertStringIncludes(html, 'aria-live="off"');
});

Deno.test("Discord message actions are named controls on focusable rows", () => {
  const messages: Message[] = [
    {
      id: "discord-user",
      role: "user",
      content: "Hello from Discord",
      createdAt: new Date("2026-01-01T12:14:00Z"),
    },
    {
      id: "discord-entity",
      role: "assistant",
      content: "Hello back",
      createdAt: new Date("2026-01-01T12:15:00Z"),
    },
    {
      id: "discord-tool",
      role: "tool",
      content: "Tool result",
      createdAt: new Date("2026-01-01T12:16:00Z"),
    },
    {
      id: "discord-system",
      role: "system",
      content: "System notice",
      createdAt: new Date("2026-01-01T12:17:00Z"),
    },
  ];
  const html = renderDiscordChannelView(
    { ...makeConversation(), sourceType: "discord" },
    messages,
    "Entity",
  );

  const row = (id: string) =>
    html.match(
      new RegExp(
        `<div class="discord-message[^"]*"[^>]*data-message-id="${id}"[\\s\\S]*?<\\/div>`,
      ),
    )?.[0] ?? "";
  const userRow = row("discord-user");
  const entityRow = row("discord-entity");
  const toolRow = row("discord-tool");
  const systemRow = row("discord-system");

  assertStringIncludes(userRow, 'role="group"');
  assertStringIncludes(userRow, 'tabindex="0"');
  assertStringIncludes(userRow, 'aria-label="Message from Discord at ');
  assertStringIncludes(entityRow, 'aria-label="Message from Entity at ');
  assertStringIncludes(toolRow, 'class="discord-message discord-msg-tool"');
  assertEquals(toolRow.includes('tabindex="0"'), false);
  assertEquals(systemRow.includes('tabindex="0"'), false);

  const buttons = userRow.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  assertEquals(
    buttons.length,
    3,
    "Discord user row should expose three actions",
  );
  for (
    const [index, label] of [
      "Edit message",
      "Delete message",
      "Mark as corrupted",
    ].entries()
  ) {
    const button = buttons[index] ?? "";
    assertStringIncludes(button, 'type="button"');
    assertStringIncludes(button, `aria-label="${label}"`);
    assertStringIncludes(button, `title="${label}"`);
  }
});

Deno.test("empty state has a heading and a muted live region", () => {
  const html = renderEmptyState();

  assertStringIncludes(html, '<h1 class="empty-title">Psycheros</h1>');
  assertStringIncludes(html, 'role="log"');
  assertStringIncludes(html, 'aria-live="off"');
});

Deno.test("thinking and tool disclosures are native controls with state", () => {
  const thinking = renderThinkingSection("Private reasoning");
  const thinkingButton = thinking.match(
    /<button\b[^>]*class="thinking-header"[^>]*>/,
  )?.[0] ?? "";
  const thinkingTarget = thinkingButton.match(/aria-controls="([^"]+)"/)?.[1];
  assertStringIncludes(thinkingButton, 'type="button"');
  assertStringIncludes(thinkingButton, 'aria-expanded="false"');
  assert(
    !!thinkingTarget && thinking.includes(`id="${thinkingTarget}"`),
    `thinking disclosure target is missing: ${thinkingButton}`,
  );

  const tool = renderToolCard({
    id: "tool-1",
    type: "function",
    function: { name: "search", arguments: '{"query":"test"}' },
  });
  const toolButton =
    tool.match(/<button\b[^>]*class="tool-header"[^>]*>/)?.[0] ??
      "";
  const toolTarget = toolButton.match(/aria-controls="([^"]+)"/)?.[1];
  assertStringIncludes(toolButton, 'type="button"');
  assertStringIncludes(toolButton, 'aria-expanded="false"');
  assert(
    !!toolTarget && tool.includes(`id="${toolTarget}"`),
    `tool disclosure target is missing: ${toolButton}`,
  );
});

Deno.test("dynamic disclosures remain native and synchronize state", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );
  const templates = await Deno.readTextFile(
    new URL("../src/server/templates.ts", import.meta.url),
  );
  for (
    const className of [
      "thinking-header",
      "tool-header",
      "generated-image-caption-toggle",
      "context-section-header",
    ]
  ) {
    assert(
      !new RegExp(`<div class="${className}"[^>]*onclick=`).test(js),
      `${className} regressed to a click-only div`,
    );
  }
  assert(
    /function setDisclosureExpanded\(button, expanded\)/.test(js) &&
      /button\.setAttribute\('aria-expanded', String\(expanded\)\)/.test(js),
    "dynamic disclosures do not synchronize aria-expanded",
  );
  assert(
    /function toggleDisclosure\(button\)/.test(js) &&
      /toggleDisclosure,/.test(js),
    "the shared disclosure behavior is not exported to inline controls",
  );
  assert(
    templates.includes('nextDisclosureId("rendered-thinking-content")') &&
      js.includes("nextDisclosureId('thinking-content')"),
    "server and live thinking disclosures need distinct ID namespaces",
  );
});

Deno.test("voice calls render as a named modal with local status semantics", () => {
  const shell = renderAppShell();
  const html = renderVoiceCallView("conv-1", VOICE_PROFILE, ["Space"], false);

  assertStringIncludes(shell, 'id="action-menu-btn"');
  assertStringIncludes(shell, 'aria-controls="action-drawer"');
  assertStringIncludes(
    html,
    '<dialog class="voice-overlay" id="voice-overlay" aria-labelledby="voice-call-title">',
  );
  assertStringIncludes(
    html,
    '<h2 class="sr-only" id="voice-call-title" tabindex="-1">Voice call</h2>',
  );
  assertStringIncludes(
    html,
    'id="voice-status-text" role="status" aria-live="polite"',
  );
  assertStringIncludes(
    html,
    'id="voice-announcer" class="sr-only" role="status" aria-live="polite"',
  );
  assertStringIncludes(
    html,
    'id="voice-btn-yinyang" onclick="toggleYinYangMode()" aria-pressed="false"',
  );
});

// The Actions kebab sits in the header, so its drawer must follow it in DOM
// order rather than trail the whole conversation. Otherwise Tab after the
// trigger walks the sidebar, log, and composer before reaching the menu.
Deno.test("app-shell disclosures follow their triggers in DOM order", () => {
  const shell = renderAppShell();
  const subBar = shell.indexOf('<div id="state-sub-bar"');
  const drawer = shell.indexOf('<nav id="action-drawer"');
  const chat = shell.indexOf('<div class="chat" id="chat">');
  const trigger = shell.indexOf('aria-controls="action-drawer"');

  assert(subBar > 0 && drawer > 0 && chat > 0, "app-shell regions missing");
  assert(
    subBar < drawer,
    "the action drawer must follow the state sub-bar it hangs from",
  );
  assert(
    drawer < chat,
    "the action drawer trails the conversation, so Tab misses it",
  );
  assert(
    subBar < chat,
    "the state sub-bar trails the conversation, so Tab misses it",
  );
  assert(
    trigger > 0 && trigger < drawer,
    "the Actions trigger must precede the drawer it controls",
  );
});

Deno.test("the e2e call fixture mirrors the rendered dialog controls", async () => {
  const html = renderVoiceCallView("conv-1", VOICE_PROFILE, ["Space"], false);
  const fixture = await Deno.readTextFile(
    new URL("../e2e/fixtures/voice-call.html", import.meta.url),
  );
  const ids = (markup: string) =>
    [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]).sort();
  assertEquals(
    ids(fixture),
    ids(html),
    "e2e/fixtures/voice-call.html drifted from renderVoiceCallView",
  );
});

Deno.test("the voice transcript does not speak over the TTS reply", () => {
  const html = renderVoiceCallView("conv-1", VOICE_PROFILE, ["Space"], false);
  const transcript = html.match(
    /<div[^>]*\bid="voice-transcript"[^>]*>/,
  )?.[0] ?? "";
  assert(transcript, "voice-transcript container is missing");
  assert(
    !/aria-live/.test(transcript),
    "the transcript blurb must stay visual so screen readers do not repeat the TTS reply",
  );
  assertStringIncludes(
    html,
    'id="voice-announcer" class="sr-only" role="status" aria-live="polite"',
  );
});

Deno.test("Flux timelines are named logs with a single status announcer", () => {
  const overlay = renderFluxOverlayView(
    "conv-1",
    "Entity",
    "User",
    "Test conversation",
    { state: "running" },
  );
  const page = renderFluxSpacePage({ entityName: "Entity", userName: "User" });
  for (
    const [surface, html] of [["overlay", overlay], ["page", page]] as const
  ) {
    const timeline = html.match(
      /<div[^>]*\bid="flux-timeline"[^>]*>/,
    )?.[0] ?? "";
    assert(timeline, `${surface}: flux-timeline container is missing`);
    assertStringIncludes(timeline, 'role="log"');
    assertStringIncludes(timeline, 'aria-live="off"');
    assert(
      /aria-label="[^"]*timeline"/.test(timeline),
      `${surface}: the timeline needs an accessible name`,
    );
    assertStringIncludes(
      html,
      'id="flux-announcer" class="sr-only" role="status" aria-live="polite"',
    );
  }
  assertStringIncludes(
    page,
    'id="flux-toast" role="status" aria-live="polite"',
  );
});

Deno.test("Flux disclosure headers are native buttons", async () => {
  const files = [
    new URL("../web/js/flux.js", import.meta.url),
    new URL("../src/server/templates.ts", import.meta.url),
  ];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    assert(
      !/<div[^>]*class="[^"]*\b(?:tool|thinking)-header\b/.test(source),
      `${file.pathname}: tool/thinking headers must be native buttons`,
    );
    assert(
      !/className\s*=\s*['"][^'"]*\b(?:tool|thinking)-header\b/.test(source),
      `${file.pathname}: tool/thinking headers must not be built as divs`,
    );
  }
});

Deno.test("Flux edit controls stay reachable and named", async () => {
  const template = await Deno.readTextFile(
    new URL("../src/server/templates.ts", import.meta.url),
  );
  const fluxJs = await Deno.readTextFile(
    new URL("../web/js/flux.js", import.meta.url),
  );
  const fluxCss = await Deno.readTextFile(
    new URL("../web/css/flux.css", import.meta.url),
  );

  // A pencil glyph plus title is not an accessible name, and display:none
  // removes the control from the tab order entirely.
  const standaloneButtons = [
    ...template.matchAll(/className = 'flux-edit-btn'/g),
  ];
  assert(
    standaloneButtons.length >= 3,
    `expected the Flux Space edit buttons, found ${standaloneButtons.length}`,
  );
  for (const match of standaloneButtons) {
    const block = template.slice(match.index, match.index + 400);
    assert(
      /setAttribute\(\s*'aria-label'/.test(block),
      "a Flux Space edit button has no aria-label",
    );
  }

  assert(
    /\.flux-entry:focus-within \.flux-edit-btn/.test(template),
    "Flux Space edit buttons do not become visible on keyboard focus",
  );

  const overlayButton = fluxJs.match(
    /className = 'msg-edit-btn'[\s\S]{0,600}?btn\.onclick/,
  )?.[0] ?? "";
  assert(overlayButton.length > 0, "overlay edit button construction missing");
  assert(
    /setAttribute\(\s*'aria-label'/.test(overlayButton),
    "the overlay edit button has no aria-label",
  );
  assert(
    /<svg aria-hidden="true"/.test(overlayButton),
    "the overlay edit icon is exposed to the accessibility tree",
  );
  assert(
    /\.flux-entry:focus-within \.msg-edit-btn/.test(fluxCss),
    "overlay edit buttons do not become visible on keyboard focus",
  );
});

Deno.test("the e2e Flux fixture mirrors the rendered view controls", async () => {
  const html = renderFluxOverlayView(
    "conv-1",
    "Entity",
    "User",
    "Test conversation",
    { state: "running" },
  );
  const fixture = await Deno.readTextFile(
    new URL("../e2e/fixtures/flux-overlay.html", import.meta.url),
  );
  const ids = (markup: string) =>
    [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]).sort();
  assertEquals(
    ids(fixture),
    ids(html),
    "e2e/fixtures/flux-overlay.html drifted from renderFluxOverlayView",
  );
});

Deno.test("the transcript is never a live region", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );

  // #messages carries the whole conversation, so arming it as a live region
  // makes VoiceOver read the history from the top. It stays muted; new replies
  // are announced through #transcript-announcer instead.
  assertEquals(
    /setAttribute\(\s*['"]aria-live['"]/.test(js),
    false,
    "psycheros.js must not arm #messages as a live region",
  );
  assertEquals(
    /id="messages"[^>]*aria-live="polite"/.test(js),
    false,
    "client-built transcripts must not be live regions",
  );
});

Deno.test("new replies are announced through a dedicated status region", async () => {
  const tmpl = await Deno.readTextFile(
    new URL("../src/server/templates.ts", import.meta.url),
  );
  assertStringIncludes(
    tmpl,
    'id="transcript-announcer" class="sr-only" role="status" aria-live="polite"',
  );

  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );
  assertStringIncludes(js, "getElementById('transcript-announcer')");
  assertStringIncludes(js, "announceTranscript(turnStream.currentBubble());");
});

Deno.test("lazy-load and re-index statuses use the shared announcer", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );
  assertStringIncludes(js, "function announceStatus(text)");
  assertStringIncludes(js, "globalThis.announceStatus = announceStatus;");
  assertStringIncludes(
    js,
    "announceStatus(`Loaded ${nodes.length} earlier messages`)",
  );

  const banner = await Deno.readTextFile(
    new URL("../web/js/reindex-banner.js", import.meta.url),
  );
  assertStringIncludes(banner, "globalThis.announceStatus");
});

Deno.test("transient status regions are live, persistent indicators are not", async () => {
  const tmpl = await Deno.readTextFile(
    new URL("../src/server/templates.ts", import.meta.url),
  );
  const pulse = await Deno.readTextFile(
    new URL("../src/pulse/templates.ts", import.meta.url),
  );
  const src = tmpl + pulse;

  // Save/test confirmation regions ("Saving.../Saved/Failed/Test OK") are
  // status messages (WCAG 4.1.3) and must carry live semantics. Each is
  // rendered empty and filled on user action, so role=status announces it.
  for (
    const cls of [
      "settings-status",
      "llm-status",
      "settings-editor-status",
      "settings-prompt-label-status",
    ]
  ) {
    assertEquals(
      new RegExp(`class="${cls}"(?! role="status")`).test(src),
      false,
      `a ${cls} region is missing role="status"`,
    );
  }
  assertStringIncludes(src, 'id="instructions-save-status" role="status"');
  assertStringIncludes(src, 'id="embedding-save-status"');
  assertStringIncludes(
    src,
    'id="embedding-download-status" class="theme-section-desc" role="status"',
  );

  // Persistent state indicators update in place and would spam a live region.
  for (const id of ["device-bridge-status", "voice-status"]) {
    const tag = src.match(new RegExp(`id="${id}"[^>]*>`))?.[0] ?? "";
    assert(tag.length > 0, `${id} not found`);
    assertEquals(
      /role="(status|alert|log)"|aria-live=/.test(tag),
      false,
      `${id} is a persistent indicator and should not be a live region`,
    );
  }
});

Deno.test("webhook save path is wired to an announced status region", async () => {
  const tmpl = await Deno.readTextFile(
    new URL("../src/server/templates.ts", import.meta.url),
  );
  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );

  assertStringIncludes(tmpl, 'onclick="saveEventRules()"');
  assertStringIncludes(
    tmpl,
    'id="event-rules-status" class="settings-status" role="status" aria-live="polite"',
  );
  assertStringIncludes(js, "function saveEventRules()");
  assertStringIncludes(js, "getElementById('event-rules-status')");
});

Deno.test("author and timestamp share one element in the message header", () => {
  const createdAt = new Date("2026-01-02T18:37:00Z");
  const cases: Record<string, string> = {
    user: renderUserMessage("hi", "m-1", undefined, createdAt, "Chris"),
    assistant: renderAssistantMessage({
      id: "m-2",
      role: "assistant",
      content: "hello",
      createdAt,
    }),
  };

  for (const [label, html] of Object.entries(cases)) {
    // WebKit exposes each flex item in .msg-header as its own VoiceOver stop,
    // so the author and timestamp must live in one wrapper.
    assertEquals(
      (html.match(/class="msg-meta"/g) ?? []).length,
      1,
      `${label}: expected a single msg-meta wrapper`,
    );
    assertEquals(
      (html.match(/class="msg-author"/g) ?? []).length,
      1,
      `${label}: author must appear once, inside the wrapper`,
    );
    const metaStart = html.indexOf('<span class="msg-meta">');
    assert(
      /^<span class="msg-meta"><span class="msg-(author|timestamp)"/.test(
        html.slice(metaStart),
      ),
      `${label}: wrapper must open with the author or the timestamp`,
    );
    const nextButton = ["msg-edit-btn", "msg-action-btn"]
      .map((cls) => html.indexOf(`class="${cls}"`, metaStart))
      .filter((i) => i > -1)
      .sort((a, b) => a - b)[0] ?? html.length;
    const meta = html.slice(metaStart, nextButton);
    assert(meta.includes("msg-author"), `${label}: author outside the wrapper`);
    assert(
      meta.includes("msg-timestamp"),
      `${label}: timestamp outside the wrapper`,
    );
  }
});

Deno.test("message input and send button have accessible names", () => {
  const html = renderInputArea();

  assertStringIncludes(html, 'aria-label="Message"');
  assertStringIncludes(html, 'aria-label="Send message"');
  assertStringIncludes(html, 'aria-label="Attach image"');
  assert(
    !html.includes('for="message-input"'),
    "composer must not use a label element: the sr-only label is read as its own text node before the textbox, so the name is voiced twice in a browse read (NVDA run 2026-09-28, 'Message Message edit multi line')",
  );
  assertStringIncludes(
    html,
    'placeholder="Type your message..."',
    "composer keeps upstream's visible placeholder for visual parity; the name comes from aria-label, so the field is still named (WCAG 4.1.2) even though a labelled field with a placeholder exposes a second AX child node",
  );
});

Deno.test("conversation row separates the title from the date in speech", () => {
  const html = renderConversationItem(makeConversation(), false, false);
  const anchor = html.match(/<a class="conv-item[\s\S]*?<\/a>/)?.[0] ?? "";

  assert(
    /Test conversation\s*,/.test(spokenText(anchor)),
    `title and date run together: ${spokenText(anchor)}`,
  );
});

Deno.test("message headers separate the author from the timestamp in speech", () => {
  const createdAt = new Date("2026-01-02T18:37:00Z");

  const user = renderUserMessage("hi", "m-1", undefined, createdAt, "Chris");
  assert(
    /,\s*Chris/.test(spokenText(user)),
    `user header runs together: ${spokenText(user)}`,
  );

  const assistant = renderAssistantMessage({
    id: "m-2",
    role: "assistant",
    content: "hello",
    createdAt,
  });
  assert(
    /Assistant\s*,/.test(spokenText(assistant)),
    `assistant header runs together: ${spokenText(assistant)}`,
  );
});

Deno.test("tombstoned and corrupted messages are not live regions", async () => {
  const tmpl = await Deno.readTextFile(
    new URL("../src/server/templates.ts", import.meta.url),
  );
  // Both blocks are re-rendered on every transcript swap, so a live role would
  // replay the whole history. Their buttons are the accessible handles; the
  // real state change is announced from JS instead.
  assert(
    !/class="message tombstone"[^>]*role=/.test(tmpl),
    "tombstone must not carry a live role",
  );
  assert(
    !/class="message glitched"[^>]*role=/.test(tmpl),
    "glitched must not carry a live role",
  );
});

Deno.test("message state changes, copies, and repeats are announced", async () => {
  const js = await Deno.readTextFile(
    new URL("../web/js/psycheros.js", import.meta.url),
  );
  for (
    const phrase of [
      "announceStatus('Message deleted')",
      "announceStatus('Message restored')",
      "announceStatus('Message flagged as corrupted')",
      "announceStatus('Glitched flag cleared')",
      "showToast('Copied ' + filename)",
      "announceStatus('Skills held: ' + skills.join(', '))",
    ]
  ) {
    assertStringIncludes(js, phrase);
  }
  // The held-skills poll runs every 5s: only rewrite when the set changed.
  assertStringIncludes(js, "if (key !== lastHeldSkills)");
  // Repeating identical status text must clear first so the SR re-announces it.
  assertStringIncludes(js, "if (announcer.textContent === text)");
  assertStringIncludes(js, "requestAnimationFrame(() => {");
});

Deno.test("gallery thumbnails are named buttons, not click-only images", () => {
  const html = renderVisionGalleryTab({
    totalSize: 2048,
    generatedCount: 1,
    userCount: 0,
    total: 1,
    hasMore: false,
    images: [{
      filename: "sunset.png",
      url: "/generated-images/sunset.png",
      category: "generated",
      size: 2048,
      createdAt: "2026-01-01T00:00:00Z",
      prompt: "a sunset",
    }],
  });

  assert(
    !/<img[^>]*class="gallery-thumb"[^>]*onclick=/.test(html),
    "an image with onclick is not focusable and has no role",
  );
  assertStringIncludes(
    html,
    '<button type="button" class="gallery-thumb-btn" aria-label="Open image sunset.png"',
  );
  assert(
    /<button[^>]*class="gallery-thumb-btn"[\s\S]*?<img[^>]*class="gallery-thumb"[^>]*alt=""[^>]*>/
      .test(html),
    "the thumbnail image is decorative inside its named button",
  );
});

Deno.test("the Flux Space page exposes a heading, main, and named timeline", () => {
  const html = renderFluxSpacePage();

  assertEquals(html.match(/<h1\b/g)?.length ?? 0, 1);
  assertStringIncludes(html, '<h1 id="flux-space-title">Flux Space</h1>');
  assert(
    /<main aria-labelledby="flux-space-title">/.test(html),
    "the timeline and input need a main landmark named by the page heading",
  );
  assertStringIncludes(
    html,
    'role="log" aria-live="off" aria-label="Flux Space timeline"',
  );
});

Deno.test("Flux settings expose tab state, panels, and section headings", () => {
  const html = renderFluxSettings(getDefaultFluxSettings(), false);

  assertStringIncludes(
    html,
    '<div class="settings-tabs" role="tablist" aria-label="Flux settings">',
  );
  for (const name of ["general", "hookups", "sensory"]) {
    const tab = html.match(
      new RegExp(`<button[^>]*role="tab"[^>]*data-flux-tab="${name}"[^>]*>`),
    )?.[0] ?? "";
    assert(tab.length > 0, `no tab button for ${name}`);
    assertStringIncludes(tab, `aria-controls="flux-tab-${name}"`);
    assertStringIncludes(tab, `id="flux-tab-btn-${name}"`);
    const selected = name === "general";
    assertStringIncludes(tab, `aria-selected="${selected}"`);
    assertStringIncludes(tab, `tabindex="${selected ? 0 : -1}"`);
    assert(
      new RegExp(
        `<div id="flux-tab-${name}" role="tabpanel" aria-labelledby="flux-tab-btn-${name}"`,
      ).test(html),
      `no panel for ${name}`,
    );
  }

  assertEquals(html.match(/<h1\b/g)?.length ?? 0, 1);
  const sections = html.match(/<h2 class="theme-section-title">/g)?.length ?? 0;
  assert(sections >= 8, `expected Flux section headings, found ${sections}`);
  assertEquals(
    html.match(/<div class="theme-section-title">/g)?.length ?? 0,
    0,
    "section and hookup titles must not stay divs",
  );
  for (const job of ["noticing", "musing", "reverie", "compaction"]) {
    assertStringIncludes(
      html,
      `<h3 class="theme-section-title" style="font-size:0.95em;">${job}</h3>`,
    );
  }
});

/** Every settings tablist needs the same contract: named list, one current
 * tab linked to its panel, roving tabindex, and the shared key handler. */
function assertSettingsTablist(
  html: string,
  opts: {
    label: string;
    activeId: string;
    panelId: string | string[];
    count: number;
  },
) {
  const list =
    html.match(/<div class="settings-tabs" role="tablist"[^>]*>/)?.[0] ??
      "";
  assertStringIncludes(list, `aria-label="${opts.label}"`);

  const tabs: string[] = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
  assertEquals(tabs.length, opts.count, `${opts.label}: tab count`);
  const panelFor = (index: number) =>
    typeof opts.panelId === "string" ? opts.panelId : opts.panelId[index];
  tabs.forEach((tab, index) => {
    assertStringIncludes(tab, `aria-controls="${panelFor(index)}"`);
    assertStringIncludes(tab, 'onkeydown="settingsTablistKeydown(event)"');
    assert(
      /tabindex="(0|-1)"/.test(tab),
      `${opts.label}: tab needs a roving tabindex`,
    );
  });
  const selected = tabs.filter((t) => t.includes('aria-selected="true"'));
  assertEquals(selected.length, 1, `${opts.label}: one selected tab`);
  assertStringIncludes(selected[0], `id="${opts.activeId}"`);
  assertEquals(
    tabs.filter((t) => t.includes('tabindex="0"')).length,
    1,
    `${opts.label}: only the selected tab is in the tab order`,
  );

  const panel = html.match(
    new RegExp(`<div[^>]*id="${panelFor(tabs.indexOf(selected[0]))}"[^>]*>`),
  )?.[0] ?? "";
  assertStringIncludes(panel, 'role="tabpanel"');
  assertStringIncludes(panel, `aria-labelledby="${opts.activeId}"`);
}

Deno.test("non-Flux settings tablists expose selection, panels, and keys", () => {
  assertSettingsTablist(
    renderGeneralSettings({ entityName: "E", userName: "U", timezone: "UTC" }),
    {
      label: "General settings",
      activeId: "general-tab-btn-general",
      panelId: ["general-tab-general", "general-tab-theme"],
      count: 2,
    },
  );
  assertSettingsTablist(renderCorePromptsSettings("self"), {
    label: "Core prompt directories",
    activeId: "tab-self",
    panelId: "settings-content",
    count: 4,
  });
  assertSettingsTablist(renderMemoriesView("daily"), {
    label: "Memory views",
    activeId: "memtab-daily",
    panelId: "settings-content",
    count: 6,
  });
  assertSettingsTablist(renderEntityCoreHub("overview"), {
    label: "Entity Core sections",
    activeId: "ectab-overview",
    panelId: "settings-content",
    count: 6,
  });
  assertSettingsTablist(
    renderModelSettingsShell("llm", "<p>profiles</p>", 2),
    {
      label: "Model settings",
      activeId: "model-tab-llm",
      panelId: "settings-content",
      count: 2,
    },
  );
  assertSettingsTablist(renderVisionSettings(getDefaultImageGenSettings()), {
    label: "Vision settings",
    activeId: "visiontab-generators",
    panelId: "settings-content",
    count: 3,
  });
  const noStats: PulseStats = {
    successCount: 0,
    errorCount: 0,
    lastRunAt: null,
    lastCompletedAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
  };
  assertSettingsTablist(renderPulseSettings([], () => noStats), {
    label: "Pulse settings",
    activeId: "pulse-tab-prompts",
    panelId: ["pulse-prompts", "pulse-log"],
    count: 2,
  });
});

Deno.test("admin imports expose a progressbar and a persistent status region", () => {
  const html = renderAdminEntityData();
  const flows = [
    {
      name: "entity data",
      progressId: "admin-entity-import-progress",
      label: "Entity data import progress",
      statusId: "admin-entity-import-status",
    },
    {
      name: "conversation restore",
      progressId: "admin-restore-conv-progress",
      label: "Conversation restore progress",
      statusId: "admin-restore-conv-status",
    },
    {
      name: "chat",
      progressId: "admin-migration-chat-progress",
      label: "Chat import progress",
      statusId: "admin-migration-chat-status",
    },
    {
      name: "knowledge graph",
      progressId: "admin-migration-graph-progress",
      label: "Knowledge graph import progress",
      statusId: "admin-migration-graph-status",
    },
  ];
  for (const flow of flows) {
    const start = html.indexOf(`id="${flow.progressId}"`);
    assert(start >= 0, `${flow.name}: no progress block`);
    const block = html.slice(start);
    const barStart = block.indexOf('<div class="import-progress-bar"');
    assert(barStart >= 0, `${flow.name}: no progress bar`);
    const bar = block.slice(barStart, block.indexOf(">", barStart) + 1);
    assert(
      bar.includes('role="progressbar"'),
      `${flow.name}: progress fill needs progressbar semantics`,
    );
    assertStringIncludes(bar, `aria-label="${flow.label}"`);
    assertStringIncludes(bar, 'aria-valuemin="0"');
    assertStringIncludes(bar, 'aria-valuemax="100"');
    assertStringIncludes(bar, 'aria-valuenow="0"');
    assertStringIncludes(
      html,
      `<div class="sr-only" id="${flow.statusId}" role="status" aria-live="polite"></div>`,
    );
    // The status region must survive the progress block collapsing at the
    // end of the run, so it lives outside that display:none container.
    const progressBlock = html.slice(
      html.indexOf(`id="${flow.progressId}"`),
      html.indexOf(`id="${flow.statusId}"`),
    );
    assertEquals(
      progressBlock.includes(`id="${flow.statusId}"`),
      false,
      `${flow.name}: status region must not sit inside the hidden progress block`,
    );
  }
  // The two memory imports have no bar but are equally silent otherwise.
  for (
    const id of ["admin-migration-sig-status", "admin-migration-daily-status"]
  ) {
    assertStringIncludes(
      html,
      `<div class="sr-only" id="${id}" role="status" aria-live="polite"></div>`,
    );
  }
});
