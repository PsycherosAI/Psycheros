# Changelog

All notable changes to entity-flux are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this package follows
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-10-25

> A global internet security issue (CVE-2026-111943, compromised eMudhra CAs)
> affects older Deno versions — running from source? **Update your Deno
> version** (2.9.8+). Details in the psycheros 1.0.1 release note.

### Fixed

- system-state organ: every remote probe command opened a fresh SSH handshake
  (4–6 per poll against a 5s cadence), polls had no overlap guard and no wall
  clock, so a slow target stacked concurrent connections until its sshd dropped
  them — the organ flapped blind in waves that grew daily. Probes now ride one
  multiplexed ControlMaster per process, only one probe is ever in flight, and a
  stalled exec is SIGKILLed at a 10-second wall clock.
- flux manager stop: a child-kill error mid-teardown aborted the stop sequence
  before the organ loop ran, leaking every organ timer after it into ghost
  probing (three leaked organ generations observed on a production companion,
  flapping blind for two days with no manager). Every stop step is now guarded
  individually and the organ loop runs unconditionally.
- motion-vision organ stop: the frame/audio stream teardown (ffmpeg child kills)
  can no longer prevent the organ's own timers from clearing.
- Timeline double-post race closed: two writers could land the same observation
  on the durable timeline twice (the engagement wire and a promotion batch
  racing one check-then-insert). A unique index now makes the insertion itself
  the arbiter — the earliest row of each pair survives, historical duplicates
  are swept on boot, and a losing writer no longer broadcasts or briefs twice.
  Noticing's outputs also carry their own name now, instead of reading as raw
  organ streams.

## [0.1.0] - 2026-10-23

### Added

- Initial release: the persistent presence nervous system. A continuous
  subconscious process, near-real-time interaction, spontaneous thoughts and
  messages, attachable senses, and scoped routed-turn streaming with the
  ego-speech self-seed. Dreams v1 generate while the entity sleeps. Designed for
  emergence rather than simulation, and resource-conscious for both cloud API
  and local inference users.

[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-flux-v0.1.0
