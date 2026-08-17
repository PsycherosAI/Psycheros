/**
 * Skill editor fragment templates — shared by routes for
 * /fragments/settings/skills/new and /fragments/settings/skills/edit/:name.
 */

import { escapeHtml } from "./templates.ts";

export interface SkillEditorData {
  /** Null for a new skill. */
  name: string | null;
  description: string;
  body: string;
  generated?: boolean;
}

export function renderSkillEditor(skill: SkillEditorData): string {
  const nameField = skill.name === null
    ? `<input type="text" id="skill-editor-name" placeholder="my-skill-name" style="width:100%;padding:var(--sp-2);border-radius:var(--radius-sm);border:1px solid var(--c-border);background:var(--c-bg);color:var(--c-fg);" />`
    : `<input type="text" id="skill-editor-name" value="${
      escapeHtml(skill.name)
    }" disabled style="width:100%;padding:var(--sp-2);border-radius:var(--radius-sm);border:1px solid var(--c-border);background:var(--c-bg-hover);color:var(--c-fg-muted);" />`;

  const generatedNote = skill.generated
    ? `<p class="settings-desc" style="color:var(--c-warning,#e6a817);">This skill is auto-generated — regenerated from source at every daemon startup. Edits will be overwritten.</p>`
    : "";

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn" href="/fragments/settings/tools" hx-get="/fragments/settings/tools" hx-target="#chat" hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Tools
      </a>
      <div>
        <h1 class="settings-title">${
    skill.name === null ? "New Skill" : "Edit Skill"
  }</h1>
        <p class="settings-desc">${
    skill.name === null
      ? "Create a markdown procedure file the entity can load on demand"
      : escapeHtml(skill.name)
  }</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    ${generatedNote}
    <div style="display:flex;flex-direction:column;gap:var(--sp-3);">
      <div>
        <label style="display:block;font-size:var(--font-size-sm);color:var(--c-fg-muted);margin-bottom:var(--sp-1);">Name (lowercase letters, digits, hyphens)</label>
        ${nameField}
      </div>
      <div>
        <label style="display:block;font-size:var(--font-size-sm);color:var(--c-fg-muted);margin-bottom:var(--sp-1);">Description (one line — shown in the entity's context index)</label>
        <input type="text" id="skill-editor-description" value="${
    escapeHtml(skill.description)
  }" placeholder="What this skill is for" style="width:100%;padding:var(--sp-2);border-radius:var(--radius-sm);border:1px solid var(--c-border);background:var(--c-bg);color:var(--c-fg);" />
      </div>
      <div>
        <label style="display:block;font-size:var(--font-size-sm);color:var(--c-fg-muted);margin-bottom:var(--sp-1);">Body (markdown — what the entity sees when it loads this skill)</label>
        <textarea id="skill-editor-body" rows="18" placeholder="# Skill procedure…" style="width:100%;font-family:var(--font-mono,monospace);font-size:var(--font-size-sm);padding:var(--sp-2);border-radius:var(--radius-sm);border:1px solid var(--c-border);background:var(--c-bg);color:var(--c-fg);min-height:240px;">${
    escapeHtml(skill.body)
  }</textarea>
      </div>
      <div style="display:flex;gap:var(--sp-2);">
        <button class="btn btn--primary" onclick="psycherosSkillsSave()">Save Skill</button>
        <button class="btn btn--ghost" onclick="psycherosSkillsCancel()">Cancel</button>
      </div>
    </div>
    <div id="skills-editor-status" class="llm-status" style="display:none;"></div>
  </div>
</div>`;
}
