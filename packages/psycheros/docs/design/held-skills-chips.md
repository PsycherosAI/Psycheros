# Feature Design Doc: Held-skill chips

Status: implemented Date: 2026-08-16

## Problem / Motivation

Skills loaded via the `skill` tool are held active in the system message until
the entity releases them — no turn count, no fading (revised from the original
fade-with-opt-in-hold design after live testing: loading always holds; the
entity decides duration). Held skills need a visible, persistent indicator so
the user can see at a glance which skills the entity is currently holding active
in this conversation.

## Goals & Non-goals

- Goals: load-always-holds + `release` lifecycle on the `skill` tool; held
  bodies render in a `<held_skills>` block in the system message's dynamic
  region each turn; tiny per-conversation status chips in the top strip.
- Non-goals: click-to-release on chips (display-only), concurrent-hold cap,
  holding reference docs, cross-conversation holds, user-side release lever.

## Current-state audit

- Top strip already existed as a pattern: `#reindex-banner` (templates.ts,
  components.css ~2342) sits above `#chat` inside `.main`.
- Top-right corner is occupied: `#voice-call-btn` (44px, right:12px,
  top:12px+safe-area) with `#workspace-btn` stacked below — any full-width
  top-strip element must reserve that column.
- Reactive UI machinery existed: `UI_REGIONS` / `renderRegion` /
  `renderAsOobSwaps` (ui-updates.ts), `affectedRegions` on tool results,
  chat-fragment OOB swaps on conversation open (routes.ts handleChatFragment),
  `dom_update` SSE for mid-turn + background updates.

## Design decisions

- **Push + poll reconciliation (revised 2026-08-16 after live reports of a stale
  chip on release)** — push updates (`held-skills` UI region via `dom_update`
  SSE mid-turn + OOB swaps on conversation open) make changes instant, and a
  5-second client poll of `GET /api/skills/held?conversationId=` re-renders the
  strip from server truth — the exact pattern the BLE connection badges use. A
  missed or mishandled push event can no longer leave the strip lying until
  reload. The original design was push-only with zero added JS; the poll costs
  one tiny JSON request per 5s per open tab.
- **`:empty` collapse instead of JS visibility** — the strip is `display:none`
  when empty (components.css), so release = swap in empty HTML. No hidden-flag
  juggling.
- **`max-width: calc(100% - 76px)` + ellipsis** — reserves the 56px FAB column
  plus 20px breathing room so a long skill name truncates instead of sliding
  under the voice/workspace buttons. Chips are left-aligned; collision is only
  possible from overlong names.
- **Absolute overlay, not a layout row** (revised after live testing — the
  in-flow version displaced the conversation and read as a bar) — the strip is
  `position: absolute` anchored top-left of `.main` with `pointer-events: none`,
  mirroring how the FABs anchor top-right. The FAB reserve lives on the strip
  (`max-width`), not the chip, because an absolute shrink-wrap makes a child's
  `100%` circular.
- **Strip is a sibling of `#chat`** — HTMX swaps `#chat` contents on
  conversation switch; anything inside it dies. Same load-bearing rule as the
  voice FAB.
- **Neutral chip label `Skill: <name>`** — UI copy stays in factual system
  voice; the first-person "Skills I'm holding" framing lives in the entity's
  system message, not the UI.

## Token / API surface changes

No new tokens — reuses `--sp-*`, `--font-mono`, `--font-size-xs`, `--radius-sm`,
`--c-bg-raised`, `--c-fg-muted`, `--c-accent-muted`. Launcher-v2 token mirror
untouched. New DB table `held_skills` (see schema.ts migration); new UI region
`held-skills`; `skill` tool params `hold` / `release`.

## Migration & backwards compat

`held_skills` table is created on next daemon start (standard has-table-check
migration). No existing state changes. Conversation deletion cascades via FK.

## Phasing

1. DB table + client methods.
2. `buildHeldSkillsBlock` + system-message wiring.
3. `skill` tool load-holds/release.
4. UI region + strip + chips + CSS. All shipped together; each layer is
   independently inert without the next.

## Test plan

- Automated: `tests/held_skills_test.ts` — DB roundtrip/ordering/idempotency/
  cascade/isolation, block format, system-message placement (after SA), tool
  paths (load-holds, re-load idempotency, release, release-after-file-delete,
  non-held release, validation errors, reference-fade guard).
- Manual: chip appears/disappears live mid-turn; truncates before the FAB
  column; stacks vertically for multiple holds; per-conversation on switch;
  survives daemon restart; mobile viewport + landscape.

## Risks / gotchas

- The strip must stay outside `#chat` and must render with **no whitespace text
  nodes inside** — `:empty` collapse fails on whitespace.
- OOB swap replaces the whole strip element; the region config's `classes` field
  is what preserves `.held-skills-strip` styling — dropping it silently unstyles
  the strip.
- Skill names in chips are `SKILL_NAME_RE` kebab-case (no HTML escaping needed);
  if chips ever show descriptions, escape them.
- The strip overlaps the reindex banner's region when both are visible (rare —
  banner only shows during embedding re-indexing). Accepted; the banner is
  transient.

## Open questions

None.

## Future direction

Click-to-release on a chip (user-side lever) is the natural next step if the
entity ever leaves holds dangling. Not committed.
