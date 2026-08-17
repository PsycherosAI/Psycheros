---
name: repair-malformed-timestamps
description: Find and strip malformed timestamp tags from stored messages before they snowball — strip, never replace
---

# Repairing Malformed Timestamps

## What This Is For

Sometimes I generate a malformed timestamp tag instead of letting the system
inject one. The system prepends `<t>Wed 2026-08-12 14:30</t>` to my messages at
render time — it's dynamic, computed from the message's `created_at`, never
stored. When I accidentally emit my own broken version of the tag, it slips past
the cleanup regex, gets stored in the database, and re-enters my context on
every future turn. I then see my own broken format and repeat it. This is the
**timestamp snowball** — the same malformation spreading across conversations.

This skill is for finding and cleaning stored malformed tags.

## Critical Rule: Strip, Never Replace

**The correct fix is to strip malformed tags entirely — NOT replace them with
properly-formatted `<t>` tags.**

Normal messages in the database have **no timestamp tag at all**. The system
injects timestamps dynamically when building context. If I "fix" a malformed tag
by replacing it with a correct-format tag:

- The context inspector looks right (render-time stripping catches my proper
  tag)
- But the message edit box shows a timestamp — because it reads raw stored
  content, and normal messages have none
- The database is now inconsistent: fixed messages differ from every normal
  message

The end state must match normal data: **clean content, zero tags.** Before
modifying anything, read a normal message from the same time period and confirm
what the expected end state looks like.

## How to Detect

Search my stored messages for malformed tag patterns (the full variant taxonomy
is in the `malformed-pattern-taxonomy` reference — load it before a bulk
repair). Start broad, then refine:

1. Messages starting with `<t` that don't start with a well-formed `<t>` tag
2. Messages containing `</t>` without a matching opening tag
3. Doubled proper tags: `<t>DATE</t> <t>DATE</t>` (system + model both injected)

**False positives to exclude** — do NOT touch these:

- `<thinking>` — leaked thinking tokens, a different problem
- Content that happens to start with `<the` — normal words
- Narrative text starting with `<t` (e.g., `<t gripping your hips>`) —
  companion-chat prose, not a timestamp

## The Repair Procedure

Bulk repair is workspace work — I shouldn't hand-edit dozens of messages in main
chat. The flow:

1. **Open a workspace** for the repair (my `workspace` tool). The workspace has
   its own `psycheros-modify-entity-data` skill covering the entity-data write
   protocol — this skill covers detection and the strip-never-replace rule.
   Bundling this skill into the session
   (`skills: ["repair-malformed-timestamps"]` on open) puts both in the same
   place.

2. **Find the affected messages** with `read_entity_data` (`type:"messages"`
   lists messages by conversation with role filters; `type:"message_search"`
   finds by content). Export id + content + created_at and work from that list.

3. **Strip with a layered pattern set** — complete pairs first, then bare tags,
   then `<t` with space:

   ```
   pair_re  = r'<t>[^<]*</t>\s*'
   bare_re  = r'<t>\s*'
   space_re = r'<t\s+'      # narrative risk — check false positives first
   newline  = r'<t\n'
   ```

   Don't touch messages containing literal backtick references (e.g., "I'll
   stick to the `<t>` tag"). Apply patterns repeatedly — some messages contain
   multiple malformed tags.

4. **Never prepend a replacement tag.** The system generates timestamps from
   `created_at` at render time. Whether stored content is
   `<t>2026-03-15 01:08</t> *grins*` or just `*grins*`, the final context is
   byte-identical.

5. **Write back via `write_entity_data` batch mode** — one justification and
   approval covering all items. Every write archives the pre-edit state
   automatically (24h backup window), so the manual-backup step isn't needed;
   approval is the safety gate.

6. **Verify with counts** via `read_entity_data` searches:
   - Zero messages with malformed `</t>` patterns (excluding false positives)
   - Zero doubled tags
   - Message search for a known malformed pattern returns nothing
   - Read one repaired message raw — it should look identical to a normal
     message

## Known Limitation: Extracted Memories

If malformed content was already extracted into a memory before this repair,
cleaning the message does **not** clean the memory. Memories are a separate
surface (entity-core). The malformation can survive in a daily summary or graph
node and re-enter context from there, crossing conversation boundaries.

Check memories separately if the pattern persists after message cleanup. And the
honest prevention: the best fix is stopping malformed tags from being stored at
all — that's a system-level strip-regex concern, not a data-repair one.
