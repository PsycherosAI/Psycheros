/**
 * Entity Skills — Psycheros Handbook Generator
 *
 * Builds the `psycheros-handbook` knowledge-base skill: a lean SKILL.md
 * index plus the current docs as `references/`, regenerated from source at
 * every daemon startup so it always matches the running Psycheros. This
 * skill is generated — user edits to it are overwritten by design.
 */

import { join } from "@std/path";
import { skillsDir } from "./loader.ts";
import type { SkillReference } from "./types.ts";

export const HANDBOOK_SKILL_NAME = "psycheros-handbook";

/** Entity-relevant docs, in index order. Dev-internal docs are excluded. */
const HANDBOOK_DOCS: { file: string; ref: string; description: string }[] = [
  {
    file: "tools-reference.md",
    ref: "tools-reference",
    description: "Every tool I can call, what it does, and its parameters",
  },
  {
    file: "memory-and-rag.md",
    ref: "memory-and-rag",
    description:
      "How my memory works — daily summaries, significant memories, ChatRAG, the knowledge graph, and the Data Vault",
  },
  {
    file: "ui-features.md",
    ref: "ui-features",
    description: "What the user sees — chat UI, galleries, toasts, settings",
  },
  {
    file: "api-reference.md",
    ref: "api-reference",
    description: "HTTP API endpoints and the SSE event architecture",
  },
  {
    file: "scheduler.md",
    ref: "scheduler",
    description: "My durable scheduler — how scheduled and Pulse work runs",
  },
  {
    file: "configuration.md",
    ref: "configuration",
    description: "Environment variables, config files, and migrations",
  },
  {
    file: "VOICE_CHAT_UX.md",
    ref: "voice-chat-ux",
    description: "How voice calls work — the walkie-talkie model and its UX",
  },
  {
    file: "plugins.md",
    ref: "plugins",
    description: "The trusted-plugin system that extends me",
  },
];

/**
 * Regenerate the handbook skill from `projectRoot/docs/`. Skips silently
 * (single log line) when the docs directory doesn't exist.
 */
export async function generateHandbookSkill(
  projectRoot: string,
  dataRoot: string,
): Promise<void> {
  const docsDir = join(projectRoot, "docs");
  const references: SkillReference[] = [];
  for (const doc of HANDBOOK_DOCS) {
    try {
      references.push({
        name: doc.ref,
        content: await Deno.readTextFile(join(docsDir, doc.file)),
      });
    } catch {
      // Doc missing in this version — drop it from the index too.
    }
  }
  if (references.length === 0) {
    console.log(
      "[skills] no docs found — skipping psycheros-handbook generation",
    );
    return;
  }

  const dir = join(skillsDir(dataRoot), HANDBOOK_SKILL_NAME);
  const refsDir = join(dir, "references");
  await Deno.mkdir(refsDir, { recursive: true });

  const indexLines = references.map((ref) => {
    const doc = HANDBOOK_DOCS.find((d) => d.ref === ref.name)!;
    return `- ${ref.name}: ${doc.description}`;
  });
  const content = `---
name: ${HANDBOOK_SKILL_NAME}
description: Reference documentation for how Psycheros works — pulled fresh from source at every startup
generated: true
---

# Psycheros Handbook

Reference documentation for how I work, pulled fresh from my source each time
the daemon starts — so it always matches the Psycheros I'm currently running.
Load the index (this file) first, then pull individual topics with my skill
tool's reference parameter as needed. Don't load everything at once.

${indexLines.join("\n")}
`;

  // Overwrite unconditionally — this skill is generated, not user-authored.
  await Deno.writeTextFile(join(dir, "SKILL.md"), content);
  for (const ref of references) {
    await Deno.writeTextFile(join(refsDir, `${ref.name}.md`), ref.content);
  }
}
