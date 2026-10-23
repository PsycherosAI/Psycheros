# psycheros — open items & integration notes

Living list of things that need figuring out. Same convention as
[`../entity-flux/NOTES.md`](../entity-flux/NOTES.md): not feature docs (that's
the README), not deep reference (that's `docs/`) — this is "known-rough and
here's the shape of the fix."

## The missing shared message entry point (the every-door problem)

Every way a turn can start — the chat route (typed messages), voice calls,
Pulse, Flux's own wake-ups — hand-assembles its own EntityTurn configuration
around the same EntityTurn machine. There is no single, route-independent "a
message entered this conversation — answer it with correctly wired context and
tools" function. The closest thing is the HTTP chat route, which background
callers cannot use (no request to ride). Found 2026-09-18 during the Pulse
forensics; the concrete damage so far:

- Pulse's `fluxManager` was a construction-time capture, undefined for life —
  classic pulse turns could never use the modulation tools (`pay_attention` /
  `mindfulness` / `tune_attention`) even while Flux ran elsewhere in the
  process. FIXED 2026-09-18: live fire-time getter (`engine.ts` config +
  `server.ts` wiring); the engine's ASSEMBLY NOTE documents the accounting rule
  for future config fields.
- Voice and Flux-hosting each had to re-learn "which conversation am I in"
  individually (`triggerFluxTurnInSession`, `firePulseIntoFluxHost`) — correct,
  but per-door by hand rather than by construction.

The fix shape (an architecture session, not a drive-by): extract the shared
entry point — one function every door calls, which resolves the conversation's
mode (classic vs Flux session), assembles the EntityConfig once (live state,
full tools), and runs the turn. Doors become thin. Until then: any new
turn-config capability must be wired at EVERY door, and background doors must
read state live at fire time.
