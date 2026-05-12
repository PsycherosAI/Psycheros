---
title: "Memory Architecture Redesign"
---

Status: In progress Started: 2026-04-02

## Problem Statement

The current memory system has several issues:

1. **Generated tags waste tokens and create sync noise** —
   `<!-- Generated: ... -->` comments in daily memory files are included in RAG
   context but carry no useful information for the entity.

2. **Significant memory filenames use dates** — `YYYY-MM-DD_slug.md` prevents
   multiple significant memories on the same day and doesn't make sense for
   memories about past events.

3. **Naive memory merge on sync_push** — When concurrent modifications happen,
   the current strategy concatenates both full documents with a `---` separator,
   producing garbled files with duplicated bullet points.

4. **Weekly/monthly consolidation lives in Psycheros** — Consolidation should be
   entity-core's responsibility since it's the centralizing system and has all
   instances' data.

5. **Single shared filename per date** — `2026-03-20.md` is written by multiple
   instances, creating ownership ambiguity and merge conflicts.

## Decisions

### D1: Remove Generated tags from daily/weekly/monthly/yearly memories

The `<!-- Generated: 2026-03-19T06:22:32.677Z -->` comment in daily memory files
provides no value to the entity reading the memory and wastes tokens in RAG
context. Remove it.

**Significant memories** keep a date in the content (the event date, not a
generation timestamp) but no `Generated:` or `Created:` tag in the HTML comment.

### D2: Instance-scoped daily memory filenames

Change daily memory filenames from `YYYY-MM-DD.md` to
`YYYY-MM-DD_{instance}.md`.

- Each instance writes only to its own file (no merge conflicts possible)
- All files are vectorized for RAG regardless of instance
- Edits are simple overwrites of your own file
- No coordination between instances needed for writes

Example: `2026-03-20_psycheros.md`, `2026-03-20_sillytavern.md`

### D3: Significant memory filenames are slug + instance, not date

Change from `YYYY-MM-DD_slug.md` to `slug_{instance}.md`.

- Date belongs in the content, not the filename
- Multiple significant memories can exist for the same day
- The filename describes the event, the instance identifies the source

Example: `first-conversation_psycheros.md`,
`realization-about-home_psycheros.md`

### D4: Consolidation moves to entity-core

Weekly, monthly, and yearly consolidation should run in entity-core, not
Psycheros.

- Entity-core has all instances' daily files (it's the canonical store)
- Entity-core already has LLM access (used for graph extraction)
- Produces shared (non-instance-scoped) weekly/monthly/yearly files
- The consolidation source material is all instances' daily files for the period

This removes consolidation from Psycheros entirely. Psycheros (and other
instances) just write dailies.

### D5: sync_push memory conflict resolution becomes unnecessary

With per-instance filenames (D2), each instance owns its file exclusively. The
`resolveMemoryConflict` merge logic becomes unnecessary for memories — an
instance can only push to its own file, so there's no conflict to resolve.

The `memory_update` tool (explicit overwrite) remains the correct path for
edits.

### D6: Knowledge graph extraction per instance file

Each daily memory file triggers its own graph extraction. With per-instance
files, bullets from different instances won't bleed into each other's graph
entries. This is already the current behavior (extraction fires per
`memory_create` call).

## File Format Changes

### Before (daily memory)

```
# Daily Memory - 2026-03-20

- Bullet point [chat:abc123] [via:psycheros]
- Another bullet [chat:def456] [via:psycheros]

<!--
Generated: 2026-04-02T23:43:10.613Z
-->
```

### After (daily memory)

```
# Daily Memory - 2026-03-20

- Bullet point [chat:abc123] [via:psycheros]
- Another bullet [chat:def456] [via:psycheros]
```

No changes to the content format — just remove the generated tag.

### Before (significant memory)

```
# First Conversation with User

Content here...

<!--
Date: 2026-03-11
Conversation: 5f0e945a-0142-4b8b-996a-72cd5aabd76f
Created: 2026-03-19T06:22:32.677Z
-->
```

Filename: `2026-03-11_first-conversation-with-user.md`

### After (significant memory)

```
# First Conversation with User

Content here...

<!--
Date: 2026-03-11
-->
```

Filename: `first-conversation-with-user_psycheros.md`

## Implementation Order

1. ~~**Remove Generated tags** — Psycheros `formatMemoryContent()` in
   `src/memory/file-writer.ts`~~ **DONE**
2. ~~**Fix significant memory filenames** — Psycheros
   `create-significant-memory.ts`, update format~~ **DONE**
3. ~~**Instance-scoped daily filenames** — Psycheros file-writer + entity-core
   sync_pull/sync_push~~ **DONE**
4. ~~**Remove sync_push memory merge** — Entity-core conflict.ts~~ **DONE**
5. **Move consolidation to entity-core** — New consolidation tool/cron in
   entity-core, remove from Psycheros

## Open Questions

- Should entity-core consolidate on a schedule (cron), or on-demand when a new
  daily is written?
- Should existing memory files be migrated to the new naming scheme?
- How does Psycheros discover when entity-core has generated a new weekly that
  should be pulled?
