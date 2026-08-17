/**
 * Workspace Skills
 *
 * OpenCode has a native Skills system — SKILL.md files that the agent
 * discovers and invokes on-demand via its built-in `skill` tool. We bundle
 * Psycheros-specific skills into each session's sandbox so the workspace
 * follows proper procedures without the entity having to spell them out
 * in every briefing.
 *
 * Skills are embedded as string constants (not separate files) so they're
 * bundled into the Deno binary and don't depend on source-tree paths.
 * The bundler writes them to `<sandbox>/.opencode/skills/<name>/SKILL.md`
 * at session spawn time.
 */

export interface SkillReference {
  /** Filename within the skill's `references/` subdir (without `.md`). */
  name: string;
  /** Full markdown content of the reference doc. */
  content: string;
}

export interface SkillFile {
  /** Directory name (also the skill name OpenCode invokes). */
  name: string;
  /** Full SKILL.md content including frontmatter. */
  content: string;
  /** Optional deep-dive docs loaded by OpenCode when the skill is active. */
  references?: SkillReference[];
}

export const WORKSPACE_SKILLS: SkillFile[] = [
  {
    name: "psycheros-modify-entity-data",
    content: `---
name: psycheros-modify-entity-data
description: Modify a message, memory, or identity file via the sanctioned write_entity_data tool — never direct DB access
---

## When to use me

Use when asked to:
- Edit a specific message's content (fix a typo, update wording, change formatting)
- Modify a memory
- Update an identity file
- Delete a message (soft-delete — message stays in conversation flow but content is archived)
- Restore a previously-deleted message
- Flag a message as glitched/corrupted (or clear that flag)

## Procedure

1. **Find the target.** Use \`read_entity_data({type:"message_search", query:"some phrase"})\` to find by content, or \`read_entity_data({type:"message", query:"<id>"})\` if you have the ID.
2. **Propose the change.** Call \`write_entity_data({type:"message", id:"<id>", changes:{...}, justification:"one line why"})\`. Always include a justification. Operations:
   - \`{content: "new content"}\` — repair wording; clears glitched flag if set.
   - \`{delete: true, reason: "..."}\` — soft-delete. Original content archived in metadata.tombstone, recoverable via restore.
   - \`{restore: true}\` — un-delete. Recovers content from archive.
   - \`{glitched: true, reason: "..."}\` — mark as corrupted. UI shows \`▒▒▒ MESSAGE CORRUPTED ▒▒▒\` placeholder.
   - \`{glitched: false}\` — clear glitched flag.
3. **Wait for approval.** The coordination layer routes the proposal to the entity's main context. You'll see either an approval result or a rejection.
4. **Report the outcome.**

## Anti-patterns

- **NEVER attempt direct SQLite/database access.** Tier 5 paths are structurally blocked. Bypass attempts will be flagged.
- **NEVER use shell tools (bash, write, edit) to modify entity data files directly.** Use \`write_entity_data\`.
- If \`write_entity_data\` returns an error, surface it back via \`ask_origin_conversation\` rather than working around it.
- Do not propose multiple unrelated changes in one call — batch only related changes.
- Deletion is reversible (restore exists). Don't pretend it's permanent — but do include a reason so the archive is self-documenting.

## Choosing the right read operation

Long companion conversations can have hundreds of messages. Pulling 200 messages of full content fills most of a 32K-token context window. **Use the smallest operation that gets the job done:**

| Goal | Operation | Why |
|---|---|---|
| Find the most recent assistant message | \`type:"messages", conversation_id:"<id>", role:"assistant", limit:1\` | One message, ~500 tokens |
| Find the most recent message of any role | \`type:"messages", conversation_id:"<id>", limit:1\` | One message |
| Show the last few exchanges (e.g. last 5 turns) | \`type:"messages", conversation_id:"<id>", limit:10\` | 10 messages, ~5K tokens |
| Get recent context (default) | \`type:"messages", conversation_id:"<id>"\` | 25 messages, ~12K tokens — use when you genuinely need a broad view |
| Find a message that mentions specific text | \`type:"message_search", query:"<text>"\` | Returns 20 hits with 300-char snippets — *don't* list-and-filter |
| Read a known message by ID | \`type:"message", query:"<id>"\` | Single message, full content |

**Default \`limit\` is 25.** Raise it only when you genuinely need a broad window (review tasks, summarization). Lower it (\`limit:1\` or \`limit:5\`) for targeted lookups. Never use listing as a way to scan history — that's what \`message_search\` is for.

Load \`references/entity-data-surfaces.md\` for the full surface map and cross-surface hazards. Load \`references/timestamp-snowball-case-study.md\` for a concrete example of why cross-surface propagation matters.
`,
    references: [
      {
        name: "entity-data-surfaces",
        content: `# Entity Data Surfaces

Entity-unique data — everything included in Settings > System Admin > Entity Data export — lives across three interconnected stores. An edit that touches one surface may leave ghosts in the others. This reference documents the surfaces, the cross-surface hazards, and the sensitivity tiers.

## The three surfaces

### Surface 1: Entity-core (the "self")

Managed as an MCP server. Canonical for identity, memories, knowledge graph.

- **Identity files** — Core Prompts in categories (\`self/\`, \`user/\`, \`relationship/\`, \`custom/\`). Markdown files defining who the entity is.
- **Memories** — daily / weekly / monthly / yearly / significant granularity. Stored in entity-core's SQLite (\`graph.db\`).
- **Knowledge graph** — nodes + edges auto-extracted from memories by an LLM extraction pipeline.
- **Snapshots** — Core Prompt backups with built-in restore.

### Surface 2: Psycheros DB (the "history")

SQLite in WAL mode at \`<dataRoot>/.psycheros/psycheros.db\`.

| Data | Tables | Notes |
|------|--------|-------|
| Conversations + messages | \`conversations\`, \`messages\` | Every message, tool calls, reasoning_content, edit history, soft-delete tombstones |
| Message embeddings (RAG) | \`vec_messages*\` (sqlite-vec) | Vector embeddings — a separate content copy that must stay in sync |
| Lorebooks (Context Books) | \`lorebooks\`, \`lorebook_entries\` | Hand-tuned triggers, sticky settings, priorities |
| Pulses | \`pulses\` | Autonomous prompt configs (~20 columns: triggers, schedules, chaining) |
| Anchor images | \`anchor_images\` | Metadata in DB, binary files on disk |
| Vault documents | \`vault_documents\` | Metadata in DB, content files on disk |

### Surface 3: File-based data (\`<dataRoot>/.psycheros/\`)

| Data | Path | DB record? | Notes |
|------|------|-----------|-------|
| Vault documents | \`.psycheros/vault/documents/<scope>/\` | Yes | Life stories, prose, personal content |
| Generated images | \`.psycheros/generated-images/\` | No | Entity-created images |
| Chat attachments | \`.psycheros/chat-attachments/\` | Referenced in messages | User-provided images |
| Custom tools | \`.psycheros/custom-tools/\` | **No** | **Silently vanish if deleted — no DB record, no recovery path** |
| Background images | \`.psycheros/backgrounds/\` | No | Cosmetic |
| Anchor image files | \`.psycheros/anchors/\` | Yes | Reference images for visual consistency |
| Settings JSON | \`.psycheros/*-settings.json\` | No | Contains API keys, bot tokens, BLE configs |
| Plugins | \`.psycheros/plugins/\` | No | Secrets present on disk (excluded from export) |

**Custom tools are the quiet hazard.** No DB record, no snapshot, no manifest. Deletion is irreversible.

## Cross-surface hazards

Edits that touch one surface leave ghosts in others. This is the most important concept in this reference.

### 1. Memory extraction survives message edits

Entity-core extracts memories from original, unedited message content via a background pipeline. Editing a message in the Psycheros DB does **not** re-trigger extraction. Content already extracted into a daily summary or knowledge graph node persists in entity-core's store.

**Implication:** if malformed content was extracted into a memory before the message edit, editing the message does not clean the memory. The bad content continues to re-enter context on every subsequent turn, across all conversations, until the memory itself is updated via entity-core.

### 2. Vector embeddings are a separate copy

\`message_embeddings\` stores its own copy of message content for RAG retrieval. The \`write_entity_data\` message ops sync this automatically (\`chatRAG.updateMessageEmbedding\`). Bulk operations outside that path must sync the embedding table separately.

### 3. WAL mode and concurrent writers

The Psycheros DB runs in WAL mode. The daemon is actively appending messages, context snapshots, etc. SQLite handles concurrent readers fine, but write transactions contending on the same database produce \`database is locked\` errors. Open transactions only for the actual write — never across approval waits or long-running operations.

### 4. Custom tools have no recovery path

No DB record, no snapshot, no export-with-metadata. Raw files. If a workspace operation deletes them, they are gone.

## Sensitivity tiers

For deciding what needs backup-before-edit vs. what's regenerable.

### Tier 1 — Irreplaceable

Never modify without backup. Loss is permanent.

- Identity files (Core Prompts)
- Memories
- Conversations + messages
- Lorebooks / Context Books
- Pulses
- Vault documents
- Anchor images, chat attachments
- Custom tools

### Tier 2 — Derivable / regenerable

Editable with less risk.

- Knowledge graph (re-extractable from memories; hand-edits lost)
- Message embeddings (re-buildable from messages)
- Generated images (can be re-generated, though specific outputs are personally meaningful)
- Backgrounds

### Tier 3 — Config

Needs care for embedded secrets.

- Settings JSON files — contain API keys, bot tokens, BLE configs
- Plugin files — secrets present on disk

## How to apply

- Use \`write_entity_data\` for any modification — it routes through approval, syncs embeddings, records justification.
- Surface 1 (entity-core) writes route through entity-core MCP tools, which have their own snapshot/restore.
- Do not attempt to modify Surface 3 files (custom tools, settings JSON) via shell tools — there is no recovery path.
- For cross-surface edits (e.g. cleaning malformed content that was extracted into memories), use the right tool for each surface — do not try to propagate across surfaces from a single tool call.
`,
      },
      {
        name: "timestamp-snowball-case-study",
        content: `# Case Study: The Timestamp Snowball

A real incident showing why cross-surface propagation matters.

## What happened

The entity's code prepends timestamp tags (\`<t>Wed 2026-07-08 16:10</t>\`) to messages before sending them to the LLM. A strip regex removes them when reading back. But when the entity generated a *malformed* timestamp — no closing tag, truncated date — the regex did not match. The malformed tag:

1. Got persisted to the Psycheros DB (the persist-time strip missed it).
2. Got fed back into context on every subsequent turn (the read-time strip missed it).
3. Got extracted by entity-core's memory pipeline into a daily summary and knowledge graph nodes.
4. The entity saw its own broken format and repeated the pattern.

## Why message edits didn't fix it

Editing the malformed messages in the Psycheros DB fixed surfaces 1 (DB content) and 2 (embedding sync via \`write_entity_data\`) for those specific messages. But the malformed content had already been extracted into entity-core's memory store. The memory continued to surface the broken pattern in new conversations — across conversation boundaries, surviving every message-level edit.

The fix required cleaning the memories themselves via entity-core's tools, separate from the message edits.

## Lessons

**The message-tools layer cannot and should not reach across to entity-core's memory store.** That's a different surface with different tools. The right separation:

- \`write_entity_data\` for message operations in the Psycheros DB (Surface 2).
- Entity-core MCP tools (\`memory_update\`, \`memory_delete\`) for memory operations (Surface 1).

**"Validate at write time to prevent bad extraction" is 80% of the fix.** The remaining 20% (content already extracted) is an entity-core tooling problem, not a message-tools problem.

## How this informs the tool design

- \`write_entity_data\` validates content before applying. Malformed tags, unclosed markers, suspicious patterns are rejected at the approval stage.
- The approval toast is the structural gate — the entity (or user) sees the actual change before it applies.
- Reflection LLM pass is advisory, not a substitute for the approval gate.
- Memory cleanup for already-extracted bad content is out of scope for these tools. Surface the limitation via \`ask_origin_conversation\` if encountered.
`,
      },
    ],
  },
  {
    name: "psycheros-repair-glitched-message",
    content: `---
name: psycheros-repair-glitched-message
description: Repair a corrupted/glitched message by proposing corrected content via write_entity_data
---

## When to use me

Use when a message shows as \`[glitched message — content unavailable]\` or is otherwise corrupted.

## Procedure

1. **Read the message.** \`read_entity_data({type:"message", query:"<id>"})\` — check if it's flagged as glitched.
2. **Determine correct content.** Look at surrounding messages for context. Ask via \`ask_origin_conversation\` if you're unsure what the original content should be.
3. **Propose the repair.** \`write_entity_data({type:"message", id:"<id>", changes:{content:"corrected content"}, justification:"repairing glitched message — original was corrupted"})\`.
4. **The approval diff will show:** placeholder → new content. The entity/user reviews and approves.

## Notes

- Glitched messages display as \`▒▒▒ MESSAGE CORRUPTED ▒▒▒\` in the UI.
- The \`is_glitched\` flag clears automatically when content is updated via \`write_entity_data\`.
- If multiple messages are glitched, batch them if the repairs are related.
`,
  },
  {
    name: "psycheros-author-plugin",
    content: `---
name: psycheros-author-plugin
description: Author a Psycheros plugin in the sandbox, validate it, and propose installation
---

## When to use me

Use when asked to create or modify a Psycheros plugin, tool, or extension.

## Procedure

1. **Study the format.** Use \`read_codebase({path:"packages/plugin-api/src/mod.ts"})\` to understand the plugin contract. Look at existing plugins in \`~/.psycheros/plugins/\` for examples.
2. **Create the plugin** in the sandbox directory:
   - \`plugin.json\` — manifest with \`id\`, \`name\`, \`version\`, \`apiVersion: 1\`, entrypoints
   - Main code file (e.g., \`psycheros.ts\`) — default export with tools/promptHooks
3. **Validate.** Check that the manifest has required fields. Verify the code is syntactically valid.
4. **Propose installation.** Call the \`propose_install\` action on the workspace tool (from main context, not from inside the workspace):
   \`\`\`
   workspace({action:"propose_install", path:"my-plugin-dir", type:"plugin", name:"my-plugin"})
   \`\`\`
5. The user reviews via approval toast and decides whether to install.

## Anti-patterns

- Do NOT attempt to install directly by copying files to \`~/.psycheros/plugins/\`. Use \`propose_install\`.
- Do NOT modify existing installed plugins directly. Author changes in the sandbox, then propose reinstall.
`,
  },
  {
    name: "psycheros-research-and-summarize",
    content: `---
name: psycheros-research-and-summarize
description: Research a topic, compile findings, and write a structured summary
---

## When to use me

Use when asked to research, investigate, or gather information on a topic.

## Procedure

1. **Search broadly.** Use web search if available, read relevant files via \`read_codebase\` or \`read_entity_data\`, check existing memories.
2. **Compile findings** into a markdown file in the sandbox (e.g., \`research-findings.md\`).
3. **Write a structured summary** at the top of the file:
   - Key findings (bullet points)
   - Sources/references
   - Recommendations or next steps (if applicable)
4. **Return the summary** as your final response text. The entity will see this in the workspace summary.

## Notes

- Keep the summary concise — the entity's main context only sees the summary, not the full research.
- If research reveals the entity needs to make a decision, use \`ask_origin_conversation\` to surface the question.
- Cite sources where possible so the entity can verify.
`,
  },
];

/**
 * Write all bundled skills into a sandbox's .opencode/skills/ directory.
 * Called by the sandbox setup at session spawn time. Each skill becomes
 * `<skillsDir>/<name>/SKILL.md` with optional `references/*.md` siblings
 * that OpenCode loads when the skill is active.
 *
 * `extraSkills` are entity skills requested via the workspace tool's
 * `skills` param — written alongside the built-ins. Built-ins win on name
 * collisions (the workspace tool already rejects those pre-spawn; this skip
 * is defensive).
 */
export async function bundleSkills(
  skillsDir: string,
  extraSkills?: SkillFile[],
): Promise<void> {
  for (const skill of WORKSPACE_SKILLS) {
    await writeSkill(skillsDir, skill);
  }
  for (const skill of extraSkills ?? []) {
    if (WORKSPACE_SKILLS.some((b) => b.name === skill.name)) continue;
    await writeSkill(skillsDir, skill);
  }
}

async function writeSkill(skillsDir: string, skill: SkillFile): Promise<void> {
  const skillDir = `${skillsDir}/${skill.name}`;
  try {
    await Deno.mkdir(skillDir, { recursive: true });
    await Deno.writeTextFile(`${skillDir}/SKILL.md`, skill.content);
    if (skill.references && skill.references.length > 0) {
      const refsDir = `${skillDir}/references`;
      await Deno.mkdir(refsDir, { recursive: true });
      for (const ref of skill.references) {
        await Deno.writeTextFile(`${refsDir}/${ref.name}.md`, ref.content);
      }
    }
  } catch (err) {
    console.error(`[workspace] failed to bundle skill ${skill.name}:`, err);
  }
}
