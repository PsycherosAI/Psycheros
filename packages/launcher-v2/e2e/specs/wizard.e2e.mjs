// Wizard E2E — exercises the first-run wizard form on a fresh data dir.
//
// The wizard is the very first thing a non-technical user sees, so its
// stability matters disproportionately. This spec verifies: the form
// inputs render with expected defaults, the timezone select gets
// populated from Intl.supportedValuesOf, and form values can be set
// from the WebDriver client (the input/select layer of the IPC↔UI
// boundary).
//
// We DON'T actually submit the form here — submission kicks off the
// real bootstrap (git clone + warm Deno cache), which takes minutes
// and depends on network. The smoke layer covers "wizard rendered";
// this layer covers "form is interactive and pre-populated correctly";
// future tests can submit + mock the bootstrap if a regression in
// that path becomes interesting.

import { after, before, describe, it } from "mocha";
import { strict as assert } from "node:assert";
import {
  killLauncher,
  spawnLauncher,
  waitForWebDriver,
} from "../lib/launcher.mjs";
import { connect } from "../lib/connect.mjs";

describe("wizard: first-run form is interactive and pre-populated", function () {
  this.timeout(60000);

  let launcher;
  let browser;

  before(async () => {
    launcher = spawnLauncher();
    await waitForWebDriver();
    browser = await connect();
    // Wait for the wizard to be visible before any assertions — gates on
    // first-run.js having resolved needs_first_run=true on a fresh dir.
    await browser.$("#card-wizard").then((el) =>
      el.waitForDisplayed({ timeout: 10000 })
    );
  });

  after(async () => {
    if (browser) await browser.deleteSession().catch(() => {});
    await killLauncher(launcher);
  });

  it("renders entity-name input with the 'Assistant' default", async () => {
    const input = await browser.$("#wf-entity");
    const value = await input.getValue();
    assert.equal(value, "Assistant");
  });

  it("renders user-name input with the 'You' default", async () => {
    const input = await browser.$("#wf-user");
    const value = await input.getValue();
    assert.equal(value, "You");
  });

  it("populates the timezone select with IANA zones", async () => {
    // first-run.js populates this from Intl.supportedValuesOf('timeZone'),
    // which returns ~400 entries on a modern WKWebView. Anything under
    // 10 means the population didn't run.
    const optionCount = await browser.execute(() => {
      const sel = document.getElementById("wf-tz");
      return sel ? sel.options.length : 0;
    });
    assert.ok(
      optionCount >= 10,
      `expected at least 10 timezone options, got ${optionCount}`,
    );

    // And the detected zone should be pre-selected — first-run.js calls
    // Intl.DateTimeFormat().resolvedOptions().timeZone and sets that.
    const selected = await browser.execute(() => {
      const sel = document.getElementById("wf-tz");
      return sel?.value || null;
    });
    assert.ok(selected, "timezone select had no value pre-selected");
    assert.ok(
      selected.includes("/") || selected === "UTC",
      `expected an IANA zone or UTC, got ${selected}`,
    );
  });

  it("accepts text input on the entity-name field", async () => {
    const input = await browser.$("#wf-entity");
    await input.click();
    // Clear by selecting-all (Cmd+A on macOS, the launcher's only
    // current platform) then typing.
    await input.setValue("Lumi");
    const value = await input.getValue();
    assert.equal(value, "Lumi");
  });

  it("names the typed confirmation field from its visible instruction", async () => {
    const association = await browser.execute(() => {
      const input = document.getElementById("typed-confirm-modal-input");
      const label = document.querySelector(
        'label[for="typed-confirm-modal-input"]',
      );
      return {
        labelId: label?.id,
        labelText: label?.textContent?.trim(),
      };
    });

    assert.equal(association.labelId, "typed-confirm-modal-instruction");
    assert.match(association.labelText, /Type\s+CONFIRM\s+below/);
  });

  it("keeps a persistent alert available for card errors", async () => {
    const alert = await browser.execute(() => {
      const el = document.getElementById("launcher-error-announcer");
      return el && {
        role: el.getAttribute("role"),
        atomic: el.getAttribute("aria-atomic"),
        hiddenByCard: Boolean(el.closest("[hidden]")),
      };
    });

    assert.deepEqual(alert, {
      role: "alert",
      atomic: "true",
      hiddenByCard: false,
    });
  });
});
