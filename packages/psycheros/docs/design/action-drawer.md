# Feature Design Doc: The action drawer — master menu + state sub-bar

Status: approved (plan 2026-09-28) Date: 2026-09-28

The FAB column dies. One kebab in the top-bar (the context-inspector's old seat)
opens a mobile-first drawer — Context / Voice / Workspace / Flux — hanging from
a persistent single-line state sub-bar (`Flux ON | Workspace (2)
| Voice ON`).
Full decision ledger and roadmap below — this doc is the build's record.

## Decision ledger — EVERYTHING ruled in the UI arc (2026-09-26 → 09-28)

Step zero of this build is persisting this ledger into the durable docs so it
lives in one scannable place forever. Nothing below is dropped; each line says
what it is and where it will live.

**Conversation as home (flux-surfaces.md — already written, needs amending):**

1. The classic conversation is the MAIN surface for hosted Flux: user + Ego rows
   only. Design doc exists (`docs/design/flux-surfaces.md`).
2. The hosted-conversation 409 guard becomes ROUTING into the session — text
   posts feed the session instead of refusing. Spec'd as flux-surfaces phase 1.
   NOT YET BUILT.
3. Input stays live during Ego generation — sends queue (the session is discrete
   generations + open-call park, not one long turn; classic's lock untouched for
   normal conversations). Part of phase 1.
4. Murmur TOASTS: **DROPPED** (owner, 09-28: "I don't see a way the toasts are
   gonna make this not messy visually"). The design doc still contains them —
   must be amended out.

**Power (ruled 09-27/28):** 5. Pause vs stop: pause is INTERNAL machinery (the
pause-edit-resume maintenance flow), NOT a user-facing state. User-facing power
is BINARY: Flux on / Flux off. Both quiet the system identically; both preserve
state (volatile snapshot + session gap-notes). 6. The flux power switch lives IN
THE DRAWER (Flux entry): START ONLY (owner's revision, 2026-09-29 — the drawer
is actions): the chip starts Flux hosted in the open conversation and nothing
else; the row HIDES while Flux runs. The sub-bar's `Flux ON` segment navigates
to the view (where stop lives). the view. 7. Provisional input-bar switch
(commit 690f5f50, local-only): wrong placement — REMOVED in this build.

**Mood-at-start (ruled 09-28 — NOT YET BUILT, next build):** 8. When Flux
starts, mood state seeds from the MOST RECENT exchange (last user + entity
messages in the host conversation), classified through GoEmotions — not restored
stale from the volatile snapshot. Baseline (slow timescale) untouched in the
first build. Gap-arc → baseline drift is a possible later refinement only if
needed.

**The action drawer + sub-bar (ruled 09-28 — THIS build):** 9. Master button:
kebab (⋮), in the context-inspector's old top-bar seat. (Sliders glyph rejected;
heart must not be competed with.) 10. Drawer entries, minimal labels: **Context
/ Voice / Workspace / Flux** — hidden when their subsystem is disabled;
Voice/Flux also need an open conversation. 11. Drawer is mobile-first: big tap
targets, drops from the kebab, attached to the sub-bar (pulls it down with it).
12. Sub-bar: persistent while anything is active, ONE line, fewest words,
`<subprocess> <state>`: `Flux ON | Workspace (2) | Voice ON`. Segments tappable
→ their surface. Hidden when all quiet. Never wraps; counts collapse. 13. The
FAB column DIES entirely (voice, workspace, flux FABs) — their functions become
drawer entries; the voice FAB's swap-survival FUNCTION is preserved (documented
trap). 14. Theme discipline: all new main-UI elements use --c-* tokens only; the
Flux overlay keeps its fixed identity colors.

**The watching interface (flux-surfaces phase 3 — spec'd, NOT YET BUILT):** 15.
FAB overlay (whatever button opens it) = the full watching interface: per-source
timeline toggles — Musing/Reverie/Dreaming ON by default; Noticing OFF
(noisiest); Compaction OFF; system markers toggleable. 16. NO unread badge on
any button (owner: annoying) — catch-up affordances (jump-to-unread, hold) live
INSIDE the overlay. 17. Toast geometry rulings (left-aligned, FAB column
reserved) are MOOT with toasts dropped — recorded here so the decision isn't
re-litigated.

**Standing:** 18. Padding diet (top-bar/chat-bar): its own measured pass —
owner's deferral. Not in any current build. 19. Proposal toasts (distinct
styling): dropped with all toasts; proposals surface as Ego rows. Listed so it
isn't re-litigated. 20. Lorebook/vault/graph/chat RAG now reach the Flux session
(BUILT, turn-builder phase C) — the conversation the entity reads from is whole.

## Implementation notes

- Master button: `#action-menu-btn` (kebab) in `renderHeader()` (templates.ts),
  replacing `.context-toggle`.
- Drawer `#action-drawer` + sub-bar `#state-sub-bar`: app-shell elements
  (HTMX-swap survivors), positioned under the header; drawer attaches below the
  sub-bar.
- `refreshActionState()` (psycheros.js): one fetch of /api/flux/status +
  /api/voice/status + /api/workspace/status → sub-bar segments + drawer entry
  visibility; on load, afterSwap, after actions, 5s interval.
- Entry behaviors reuse existing functions: toggleContextViewer, startVoiceCall,
  openWorkspaceList, startFluxOverlay; Flux entry: start-only POST (the sub-bar
  segment opens the view); the drawer never opens open conversation, on → open
  the Flux view.
- Styles in layout.css, --c-* tokens only, ≥44px tap targets.
- The FAB column (voice/workspace/flux) and the provisional input-bar switch are
  removed in the same build; functions survive.

## Test plan

Kebab opens/closes (outside-tap, Escape); entries per enabled-state and
conversation context; each entry does its thing; sub-bar renders
`Flux ON | Workspace (2) | Voice ON` with tappable segments; hides when quiet;
mobile viewport sanity; theme-token compliance (no fixed hexes).
