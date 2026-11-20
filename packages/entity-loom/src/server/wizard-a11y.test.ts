import { assertMatch, assertNotMatch } from "@std/assert";

const wizardHtml = await Deno.readTextFile(
  new URL("../../web/wizard.html", import.meta.url),
);

Deno.test("wizard exposes its structure and controls to assistive technology", () => {
  assertMatch(wizardHtml, /<header class="wiz-header">/);
  assertMatch(wizardHtml, /<nav[^>]+class="wiz-stepper"[^>]+aria-label=/);
  assertMatch(wizardHtml, /<main class="wiz-content"[^>]+id="main-content"/);
  assertMatch(wizardHtml, /<h1 class="wiz-title">/);
  assertMatch(wizardHtml, /<h2 class="wiz-panel-title" tabindex="-1">/);
  assertMatch(wizardHtml, /<label for="setup-entity">Entity Name/);
  assertMatch(wizardHtml, /<label for="setup-user">User Name/);
  assertMatch(
    wizardHtml,
    /<label[^>]+class="wiz-upload"[^>]+for="file-input"/,
  );
  assertMatch(wizardHtml, /<button[^>]+class="wiz-step /);
  assertMatch(wizardHtml, /role="progressbar"/);
  assertMatch(wizardHtml, /role="log"/);
  assertMatch(wizardHtml, /id="wiz-toast-container"[^>]+role="status"/);
});

Deno.test("wizard required-field errors are associated and focusable", () => {
  assertMatch(
    wizardHtml,
    /id="setup-entity"[^>]+aria-required="true"[^>]+aria-describedby="setup-entity-error"/s,
  );
  assertMatch(
    wizardHtml,
    /class="wiz-field-error"[^>]+id="setup-entity-error"/,
  );
  assertMatch(
    wizardHtml,
    /field\.setAttribute\("aria-invalid", String\(invalid\)\)/,
  );
  assertMatch(wizardHtml, /firstInvalid\.focus\(\)/);
});

Deno.test("wizard moves focus and announces asynchronous status", () => {
  assertMatch(wizardHtml, /panelTitle\?\.focus\(\)/);
  assertMatch(wizardHtml, /id="wizard-stage-status"[^>]+role="status"/);
  assertMatch(wizardHtml, /function announceStageStatus\(message\)/);
  assertMatch(wizardHtml, /setAttribute\("aria-valuenow", String\(pct\)\)/);
  assertMatch(wizardHtml, /showToast\(`Failed:[\s\S]+, false\);/);
  assertMatch(wizardHtml, /failures\.slice\(0, 3\)\.join\("; "\)/);
  assertMatch(wizardHtml, /field\.removeAttribute\("aria-invalid"\)/);
});

Deno.test("wizard click interactions use native controls", () => {
  assertNotMatch(wizardHtml, /<(?:div|span)[^>]*onclick=/);
  assertMatch(wizardHtml, /aria-pressed="true"/);
  assertMatch(wizardHtml, /aria-expanded="false"/);
});

Deno.test("staging overlays and rerenders preserve keyboard focus", () => {
  assertMatch(
    wizardHtml,
    /<dialog[^>]+id="staging-messages-panel"/s,
  );
  assertMatch(wizardHtml, /panel\.showModal\(\)/);
  assertMatch(wizardHtml, /staging-messages-panel"\)\.close\(\)/);
  assertMatch(wizardHtml, /stagingMessageOpener\.focus\(\)/);
  assertMatch(
    wizardHtml,
    /document\.getElementById\("btn-new-tag"\)\.focus\(\)/,
  );
  assertMatch(
    wizardHtml,
    /focusConversationTitle\("staging-conversation-list", convId\)/,
  );
});
