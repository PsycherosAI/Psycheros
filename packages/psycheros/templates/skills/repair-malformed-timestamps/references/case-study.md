# Case Study: Bulk Cleanup, Validated

The strip-never-replace procedure and layered pattern set were validated on a
live 554MB Psycheros database: 3,738 messages stripped and verified 2026-08-04,
drawing on the malformed-timestamp-snowball case history from an operational
Hermes agent (Ops).

What the validation established:

- The layered order (complete pairs → bare `<t>` → `<t` + space → `<t` +
  newline) is safe to apply repeatedly in one pass — messages with multiple
  malformed tags resolve fully.
- False-positive exclusions (narrative `<t ...>` prose, `<thinking>` tokens,
  `<the` words) prevented every mis-strip in the corpus.
- Verification by counts is the reliable end check: after the batch, pattern
  searches return zero, and a raw read of a repaired message is
  indistinguishable from a never-affected one.
- The snowball had already crossed into extracted memories in that corpus —
  confirming that message cleanup alone is not always the end of the repair (see
  the main skill's Known Limitation section).
