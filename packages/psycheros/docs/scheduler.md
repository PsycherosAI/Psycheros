# Scheduler

Every scheduled or event-triggered task in Psycheros runs through a single
durable primitive: the internal scheduler module at
[`src/scheduler/`](../src/scheduler/). The daemon instantiates one `Scheduler`,
gives it a SQLite database to own two tables on (`schedules`, `job_runs`), and a
5-second ticker materializes due fires, reclaims expired leases, and dispatches
handlers.

This page covers which schedules are defined, which handlers are registered, and
the durability guarantees the system gives.

> entity-core used to share this scheduler but now runs its weekly / monthly /
> yearly memory consolidation through its own narrower `ConsolidationRunner` —
> see
> [`packages/entity-core/src/consolidation/runner.ts`](../../entity-core/src/consolidation/runner.ts).

## The two tables

- **`schedules`** — definitions. One row per recurring or one-shot schedule.
  Stores the timing source (cron expression, fixed interval, random interval, or
  one-shot `run_at`), the catch-up policy, the registered handler name, and the
  materialized `next_fire_at` that the ticker reads to decide when to fire.
- **`job_runs`** — every fire that has ever been materialized: pending, in
  flight, completed, errored, or dead. This is both the work queue and the
  execution history. The admin UI and the pulse run viewer read from it.

A schedule fires by inserting a `job_runs` row at the scheduled time. The ticker
then claims pending rows up to its concurrency limit, sets a lease, and
dispatches the handler.

## Catch-up policies

When I'm down and a scheduled fire elapses, the `catchup_policy` on each
schedule decides what happens on next boot:

- **`fire_once_then_align`** — fire once now, then resume the normal cadence.
  The right choice for daily summarization and daily identity snapshots.
  Catching up matters; flooding does not.
- **`skip_missed`** — drop missed fires and resume on the next scheduled time.
  The default for user-created Pulses. A user pulse "every hour: remind me to
  stretch" doesn't want fifty reminders after a week of downtime.
- **`fire_all_missed`** — materialize one job per missed fire. Available but not
  currently used by any schedule in this codebase — would only matter for fires
  that processed discrete units of work where missing one means missing data.

## Schedules registered by Psycheros

| id                            | Handler                       | Cadence                              | Catch-up               |
| ----------------------------- | ----------------------------- | ------------------------------------ | ---------------------- |
| `memory-daily`                | `memory.summarize-daily`      | `0 5 * * *` (local TZ → UTC shifted) | `fire_once_then_align` |
| `identity-snapshot`           | `identity.snapshot`           | `0 3 * * *` UTC                      | `fire_once_then_align` |
| `mcp-pull-canonical-identity` | `mcp.pull-canonical-identity` | every 300 s                          | `skip_missed`          |
| `pulse-<pulseId>` (per-pulse) | `pulse.execute`               | Determined by the pulse's trigger    | `skip_missed`          |

Webhook and filesystem pulses do not have their own schedule rows — the HTTP
route and `Deno.watchFs` watcher each call `scheduler.enqueue` to materialize a
`job_runs` row on event. Manual triggers (the "Run Now" button, the
entity-facing `pulse` tool, and chain execution) enqueue the same way.

## Handlers registered by Psycheros

| Handler                       | Purpose                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `memory.summarize-daily`      | Runs `catchUpSummarization`; idempotent on already-summarized days    |
| `identity.snapshot`           | Calls MCP `snapshot_create`; entity-core handles retention            |
| `mcp.push-identity-change`    | Pushes one identity-file change via MCP `sync_push`; up to 5 attempts |
| `mcp.pull-canonical-identity` | Pulls canonical identity from entity-core                             |
| `pulse.execute`               | Runs a Pulse — eligibility check, semaphore acquire, agentic loop     |

## Durability guarantees

- **Catch-up across downtime.** Daily summarization and identity snapshots will
  fire once on next boot if their scheduled time elapsed while I was down.
- **Crash recovery for in-flight runs.** Single-process invariant: on boot, any
  row left in `running` state belongs to a dead worker by definition.
  `reclaimOnBoot` reclaims every such row regardless of `lease_until` — if the
  schedule's `max_attempts > 1` it is re-queued, otherwise it is marked `dead`
  with an explanatory error message. Pulses default to `max_attempts = 1` so a
  crash mid-LLM-stream does not replay an already-broadcast message.
- **Idempotent enqueue.** Ad-hoc jobs may carry an `idempotency_key`; a
  successful row with that key short-circuits a duplicate enqueue.
- **Durable identity-write queue.** `MCPClient.queueIdentityChange()` enqueues
  an `mcp.push-identity-change` job per write. If the process dies before the
  push lands, the row stays `pending` and retries on next boot — no in-memory
  write buffer to lose.
- **Expedited boot retries.** `reclaimOnBoot` also clears `next_attempt_at` on
  every `pending` row whose retry was deferred to the future by a prior failure.
  The backoff exists to space out retries in steady state, not to delay a fresh
  boot — so pending work flushes on the first tick after restart instead of
  waiting out the old timer.

## Runtime properties

- **Lease auto-renewal.** Handlers can run as long as they need to (an LLM
  stream that takes 90s, a memory-consolidation pass that takes minutes). Every
  tick renews `lease_until` for each job currently in this process's in-flight
  set, so a long-running handler never trips `reclaimExpiredLeases`. Handler
  authors don't need to remember `ctx.renewLease()` — it's automatic.
- **Low-latency dispatch.** `Scheduler.nudge()` schedules a tick on the next
  microtask turn. Called from `triggerPulse` and the admin manual-trigger
  handler so user-initiated actions don't wait up to a tick interval (~5s) for
  execution to start. Measured ~30ms HTTP→running.
- **Retention pruning.** After every terminal completion the scheduler prunes
  its cohort (same `handler` + same `schedule_id` or, for ad-hoc pulse runs,
  same `payload.pulseId`):
  - Skipped runs older than 24 hours are removed, but the most-recent 50 skipped
    runs are always kept regardless of age — so an inactivity pulse's audit
    trail doesn't disappear after a quiet period.
  - Terminal runs of any status are capped at 200 per cohort. This bounds
    storage even for inactivity pulses that fire every minute.

## Pulse stats are derived, not denormalized

The `pulses` table no longer carries `success_count`, `error_count`,
`last_run_at`, or `last_status`. Those are derived on demand from `job_runs`
filtered by `handler = 'pulse.execute'` and the JSON-extracted
`payload.pulseId`. See `DBClient.getPulseStats()`.

## Inactivity pulses

Inactivity-triggered pulses are recurring schedules that fire every minute
(`* * * * *`). The `pulse.execute` handler checks
`DBClient.getLastUserMessageTimestamp()` and the pulse's last **successful** run
before actually firing — if either guard fails the run is marked `skipped` with
no LLM call and no chat side effects. The cooldown only gates on successful runs
so that consecutive skipped ticks (threshold not yet met) don't block the first
real fire. The last-user-message timestamp is computed from the `messages`
table, not an in-memory cache, so it survives process restart.

## Operating the scheduler

- **List schedules:** `GET /api/admin/jobs` (JSON), `/fragments/admin/jobs`
  (HTML), or `scheduler.listSchedules()` programmatically. Pulse schedules
  (`pulse-*`) are filtered out of the admin view because they have their own UI
  in Pulse settings.
- **Manually trigger a schedule:** `POST /api/admin/jobs/:id/trigger` enqueues
  an ad-hoc `job_runs` row for that schedule's handler.
- **Inspect job history:** `scheduler.listJobRuns({handler, status, …})`. For
  pulses, `DBClient.listPulseRuns()` projects the same rows into the pulse
  history UI shape.

## Mental model

> The scheduler is the only thing that knows time. Triggers (cron, webhook,
> filesystem, inactivity, manual) are all just ways of putting a row into
> `job_runs`. The ticker decides when to dispatch it. The handler does the
> actual work and returns success / skipped / error. Nothing else owns the
> timing or the retry policy, anywhere.
