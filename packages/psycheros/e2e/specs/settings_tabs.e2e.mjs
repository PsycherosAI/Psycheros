/**
 * WCAG 4.1.2 / 1.3.1 / 2.1.1: the non-Flux settings tablists expose which
 * view is current, link each tab to its panel, and support arrow keys,
 * including the htmx views that swap their panel body.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("Settings tablists");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  const load = async (path, readySelector) => {
    await page.evaluate((url) => {
      htmx.ajax("GET", url, { target: "#chat", swap: "innerHTML" });
    }, path);
    await page.waitForSelector(readySelector, { timeout: 15000 });
  };

  const state = () =>
    page.evaluate(() => {
      const list = document.querySelector('#chat [role="tablist"]');
      const tabs = Array.from(list?.querySelectorAll('[role="tab"]') ?? []);
      const active = tabs.find((t) =>
        t.getAttribute("aria-selected") === "true"
      );
      const panelId = active?.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      return {
        label: list?.getAttribute("aria-label"),
        tabs: tabs.map((t) => ({
          id: t.id,
          selected: t.getAttribute("aria-selected"),
          tabindex: t.tabIndex,
          controls: t.getAttribute("aria-controls"),
          focused: document.activeElement === t,
          visible: t.offsetParent !== null,
        })),
        panel: panel && {
          id: panel.id,
          role: panel.getAttribute("role"),
          labelledby: panel.getAttribute("aria-labelledby"),
          hidden: panel.style.display === "none",
        },
      };
    });

  const selectedIds = (s) =>
    s.tabs.filter((t) => t.selected === "true").map((t) => t.id);
  const focusId = (s) => s.tabs.find((t) => t.focused)?.id ?? null;

  // General settings: local panel switch, no htmx navigation.
  await load("/fragments/settings/general", "#general-tab-btn-general");
  const general = await state();
  report.check(
    "General settings names its tablist and selects one tab",
    general.label === "General settings" && general.tabs.length === 2 &&
      selectedIds(general).join() === "general-tab-btn-general" &&
      general.tabs[1].tabindex === -1,
    JSON.stringify(general),
  );
  await page.evaluate(() => {
    document.getElementById("general-tab-btn-general").focus();
  });
  await page.keyboard.press("ArrowRight");
  const generalTheme = await state();
  report.check(
    "ArrowRight switches General settings to Theme and moves focus",
    selectedIds(generalTheme).join() === "general-tab-btn-theme" &&
      focusId(generalTheme) === "general-tab-btn-theme" &&
      generalTheme.panel.id === "general-tab-theme" &&
      generalTheme.panel.role === "tabpanel" &&
      generalTheme.panel.labelledby === "general-tab-btn-theme" &&
      !generalTheme.panel.hidden,
    JSON.stringify(generalTheme),
  );

  // Core Prompts: each tab is an htmx navigation that swaps the panel body.
  await load("/fragments/settings/core-prompts", "#tab-self");
  await page.waitForFunction(
    () =>
      !document.getElementById("settings-content")?.textContent?.includes(
        "Loading",
      ),
    null,
    { timeout: 15000 },
  );
  // The load trigger replaces the tab buttons through out-of-band swaps;
  // wait for htmx to settle so the focus and click land on live nodes.
  await page.waitForTimeout(600);
  const prompts = await state();
  report.check(
    "Core Prompts links each tab to the shared panel",
    prompts.label === "Core prompt directories" && prompts.tabs.length === 4 &&
      prompts.tabs.every((t) => t.controls === "settings-content") &&
      prompts.panel.role === "tabpanel" &&
      prompts.panel.labelledby === "tab-self",
    JSON.stringify(prompts),
  );
  await page.evaluate(() => {
    document.getElementById("tab-self").focus();
  });
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector("#settings-content")?.getAttribute(
        "aria-labelledby",
      ) === "tab-user",
    null,
    { timeout: 15000 },
  );
  const promptsUser = await state();
  report.check(
    "ArrowRight navigates Core Prompts, relabels the panel, and restores focus",
    selectedIds(promptsUser).join() === "tab-user" &&
      promptsUser.tabs[0].tabindex === -1 &&
      promptsUser.tabs[1].tabindex === 0 &&
      promptsUser.panel.labelledby === "tab-user" &&
      focusId(promptsUser) === "tab-user",
    JSON.stringify(promptsUser),
  );

  // Workspace: second local-panel tablist with its own switch function.
  await load("/fragments/settings/workspace", "#workspace-tab-btn-general");
  const workspace = await state();
  report.check(
    "Workspace names its tablist and selects General",
    workspace.label === "Workspace settings" && workspace.tabs.length === 2 &&
      selectedIds(workspace).join() === "workspace-tab-btn-general" &&
      workspace.panel.labelledby === "workspace-tab-btn-general",
    JSON.stringify(workspace),
  );
  await page.evaluate(() => {
    document.getElementById("workspace-tab-btn-general").focus();
  });
  await page.keyboard.press("ArrowRight");
  const workspaceSessions = await state();
  report.check(
    "ArrowRight shows Workspace Sessions and relabels its panel",
    selectedIds(workspaceSessions).join() === "workspace-tab-btn-sessions" &&
      focusId(workspaceSessions) === "workspace-tab-btn-sessions" &&
      workspaceSessions.panel.id === "workspace-tab-sessions" &&
      workspaceSessions.panel.labelledby === "workspace-tab-btn-sessions" &&
      !workspaceSessions.panel.hidden,
    JSON.stringify(workspaceSessions),
  );

  // Pulse: legacy switchTab view with its own per-tab panels.
  await load("/fragments/settings/pulse", "#pulse-tab-prompts");
  const pulse = await state();
  report.check(
    "Pulse names its tablist and links each tab to its own panel",
    pulse.label === "Pulse settings" && pulse.tabs.length === 2 &&
      selectedIds(pulse).join() === "pulse-tab-prompts" &&
      pulse.tabs[1].tabindex === -1 &&
      pulse.tabs[0].controls === "pulse-prompts" &&
      pulse.tabs[1].controls === "pulse-log" &&
      pulse.panel.role === "tabpanel" &&
      pulse.panel.labelledby === "pulse-tab-prompts" &&
      !pulse.panel.hidden,
    JSON.stringify(pulse),
  );
  await page.evaluate(() => {
    document.getElementById("pulse-tab-prompts").focus();
  });
  await page.keyboard.press("ArrowRight");
  const pulseLog = await state();
  report.check(
    "ArrowRight shows the Pulse Execution Log and relabels its panel",
    selectedIds(pulseLog).join() === "pulse-tab-log" &&
      focusId(pulseLog) === "pulse-tab-log" &&
      pulseLog.panel.id === "pulse-log" &&
      pulseLog.panel.labelledby === "pulse-tab-log" &&
      !pulseLog.panel.hidden,
    JSON.stringify(pulseLog),
  );
} finally {
  await browser.close();
}
report.done();
