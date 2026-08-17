# Feature Design Doc: <name>

Status: draft | approved | implemented | superseded Date: YYYY-MM-DD

Copy this file, fill every section. "N/A" is an acceptable answer where a
section genuinely doesn't apply — say why in one line. The audit section is not
optional for changes that touch existing surfaces.

## Problem / Motivation

What's wrong or missing today, and why it matters. One paragraph.

## Goals & Non-goals

- Goals: what this changes.
- Non-goals: adjacent work explicitly out of scope (prevents scope creep and
  records deliberate deferrals).

## Current-state audit

Evidence-based inventory of what exists now — file:line references, counts,
drift. For styling work: run the hex/rgba inventory greps (see
`design-system.md`) and summarize the clusters. This section is the baseline the
migration is verified against.

## Design decisions

Each decision as: **Decision** — rationale — rejected alternatives (and why).
Only decisions with real tradeoffs belong here; don't journal the obvious.

## Token / API surface changes

New or renamed tokens, functions, endpoints, settings shapes, persistence
migrations. If none: "none".

## Migration & backwards compat

How existing persisted state / saved files keep working, or get normalized. What
breaks and why that's acceptable.

## Phasing

Ordered, individually shippable steps. Each phase leaves the app working.

## Test plan

Automated gates + the manual verification matrix (surfaces, states, themes,
viewports) someone should walk through before calling it done.

## Risks / gotchas

Things that will bite during or after implementation. Load-bearing wirings that
must not be broken.

## Open questions

Unresolved items. Empty is fine; unwritten assumptions are not.

## Future direction

Where this could grow (marked as vision, not commitment).
