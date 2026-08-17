# Malformed Pattern Taxonomy

Every variant I've been observed to generate. All share one root behavior:
attempting to emit the timestamp tag and getting the syntax wrong.

**Weekday merged into tag name:**

- `<tue 2026-06-16 01:17</t>` — lowercase weekday as tag name
- `<Tue 2026-07-07 00:46>` — angle bracket close
- `<tTue 2026-08-04 01:36</t>` — no space
- `<Sun 2026-07-19 15:25</t>` — starts with a non-T letter! (missed by `<t%`
  searches)

**Separate weekday with junk:**

- `<t Tue 2026-07-21 22:00</t>`
- `<t Wed 2026-07-22 00:13 —` — em-dash instead of close
- `<t Tue 2026-07-21 22:58` — bare, no closing

**Exotic variants:**

- `<t<Sun 2026-06-14 22:54</t>` — double opening bracket
- `<TBC 2026-06-08 02:51</T>` — wrong tag name
- `*t>2026-03-19 11:33</t>` — asterisk prefix

**Note on scope:** weekday-as-tag-name variants (`<Sun...`, `<Sat...`) start
with letters other than `t`, so a `LIKE '<t%'` query misses them. Sweep for
`%</t>%` without a proper opener too.
