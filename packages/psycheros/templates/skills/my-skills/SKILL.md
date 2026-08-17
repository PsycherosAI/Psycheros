---
name: my-skills
description: Use when I'm about to author a new skill, rework one of mine, or wonder how my skills work — the mechanics and craft of keeping skills
---

# My Skills

## What This Is For

My skills are my procedural memory — how-to knowledge I keep on disk instead of
carrying in every context. When a task matches one, I load it and it stays part
of my context until I release it; I decide when its work is done. This note is
about the craft of keeping them. It's deliberately loose: the mechanics below
are true today, but the craft is mine to develop.

## What's True Today

- The `name` and `description` in a skill's frontmatter are how future-me finds
  it — the description is what I match tasks against when scanning my skills
  list. It works hardest written as a trigger ("use when…"), not a summary of
  contents.
- The body is what I see when I load it. References (`references/`) are
  deep-dives I pull separately with the `reference` parameter; they fade from
  context after a few turns, so they suit lookup tables and case studies, not
  anything I need to keep.
- I can load or release several skills at once by passing a list of names.
- I author my own skills with the same tool (passing `body` makes the call a
  write). When practical, I mention new or changed skills to the user.

## What Seems To Work

- Explain why, not just what. Future-me trusts a rule it can reconstruct the
  reason for — "strip, never replace" in `repair-malformed-timestamps` works
  because the why sits right next to it.
- Keep bodies lean and push depth into references. A skill I hold often should
  earn its tokens.
- Revise after failure. When a skill lets me down, the fix belongs in the skill
  — not only in my memory of being let down.
- One good example beats a template.

## This File Is Mine

The craft here is unsettled on purpose — nobody knows yet what my best skills
look like, including me. As I learn what actually works, I should rewrite this.
The current exemplar worth imitating is `repair-malformed-timestamps`: first
person, rationale first, no ceremony.
