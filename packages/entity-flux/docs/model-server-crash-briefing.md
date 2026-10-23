# Local model-server crashes — briefing (prepared 2026-09-07)

The llama-server instances behind Flux's model hookups keep dying silently. This
document is the complete evidence file + fix options for a session on
stabilizing them. Flux-side context lives in
[`motion-vision-session-briefing.md`](motion-vision-session-briefing.md); this
one is the infrastructure deep-dive.

## The servers (three, all llama.cpp Vulkan builds)

| Port  | Role                             | Model                        | Resident size        | GPU offload |
| ----- | -------------------------------- | ---------------------------- | -------------------- | ----------- |
| 18081 | Vision captioner (motion-vision) | LFM2.5-VL-450M-Q8_0 + mmproj | ~1.3GB RSS, vm ~11GB | `-ngl 99`   |
| 18080 | Noticing small-LLM               | gemma-4-E2B q4_0             | ~1.6GB RSS, vm ~11GB | `-ngl 40`   |
| 18082 | Reverie small-LLM                | Gemma-4-E4B uncensored Q4    | ~1.3GB RSS, vm ~13GB | `-ngl 50`   |

- Binary:
  `~/Experiments/gemma4-e2b-baseline/build/llama-b10288-vulkan/bin/llama-server`
- Launch flags: `-c 4096 -fa on --jinja --host 127.0.0.1 --port <N>`
- Host: the local inference host, 28GB RAM, shared with the Psycheros daemon,
  Chromium, and the desktop session. No discrete-GPU isolation (Vulkan = system
  RAM).

## The evidence — kernel-confirmed OOM kills

`journalctl -k` shows **six OOM kills of llama-server in ~26 hours**:

| When (local) | Victim                    | anon-rss at death | total-vm |
| ------------ | ------------------------- | ----------------- | -------- |
| Sep 6 00:57  | llama-server              | ~7GB              | ~9GB     |
| Sep 6 14:42  | llama-server              | ~9GB              | ~11GB    |
| Sep 6 16:32  | llama-server              | ~11GB             | ~13GB    |
| Sep 7 00:22  | llama-server              | ~9GB              | ~11GB    |
| Sep 7 00:45  | llama-server              | ~9GB              | ~11GB    |
| Sep 7 01:04  | llama-server (pid 743417) | 9GB               | 11.3GB   |

Sample kill line (the fingerprint):

```
kernel: oom-kill:constraint=CONSTRAINT_NONE,...,global_oom,
  task=llama-server,pid=743417,uid=1000
kernel: Out of memory: Killed process 743417 (llama-server)
  total-vm:11858888kB, anon-rss:9637012kB, ... oom_score_adj:200
```

**Two load-bearing facts in that line:**

1. `global_oom`, `CONSTRAINT_NONE` — not a cgroup limit, not a memcg policy: the
   WHOLE box ran out. Nothing about these processes specifically violated a
   bound; they were just the biggest/most- killable residents when the sum
   crossed 28GB.
2. `oom_score_adj:200` — the servers run with an ELEVATED kill preference (+200
   of the −1000..1000 scale) because they inherit it from the terminal-spawn
   systemd scope (`app-org.gnome.Terminal...vte-spawn...scope`). The kernel is
   actively PREFERRED to kill them over, say, Chromium. This is inherited, never
   chosen — and it's fixable (below).

## Why the deaths looked mysterious from Flux

- SIGKILL = no shutdown log line. The server's log just stops mid-task (last
  observed: `slot launch_slot_ ... processing task` at the exact kill
  timestamp). 914 "connection refused" retries accumulated on the daemon side
  before a human looked.
- The deaths cluster at genuine memory-pressure moments: all three servers
  resident + daemon (embedder warm, GoEmotions loaded) + Chromium tabs + desktop
  ≈ 28GB. The Vulkan runtime also transiently allocates during model load (~vm
  sizes above are mostly mappings that fault in under load).
- Which server dies is somewhat arbitrary (oom_score, RSS, and recency decide),
  which is why all three ports have been victims at least once.

## Current mitigations already in place (detection, not prevention)

- Thalamus health monitor (2026-09-06): probes each port every 30s, flips the
  Flux page dot red on death, green on recovery. Works every time. It DETECTS;
  nothing RESTORES.
- The Sensory Organ survives cleanly (retries, resumes when the server returns).

## Fix options (decide in the dedicated session)

1. **systemd user units with restart** — the classic answer and probably the
   right one:
   - `Restart=on-failure` + `RestartSec=10` (auto-revive after every OOM kill),
   - `MemoryHigh=`/`MemoryMax=` per unit (turn global_oom into a clean
     per-service kill + restart instead of random victim selection),
   - `OOMScoreAdjust=0` or negative (STOP preferring the model servers as
     victims — today's +200 inheritance is pure accident),
   - launches detached from the terminal session (survive logout; no vte-spawn
     scope).
   - Cost: three unit files + a `systemctl --user` habit; zero code.
2. **Host-side supervisor inside Psycheros** — read the health report, respawn
   dead processes with backoff. Keeps everything in-repo and cross-platform
   (Windows launcher-v2 story), but reimplements what systemd gives free on
   Linux, and the supervisor itself must be careful not to fight the OOM killer
   (restart storms under sustained pressure — needs backoff + max-restart
   windows).
3. **Reduce resident pressure:**
   - One llama-server, three models via `--model` hot-swap is NOT supported by
     llama.cpp; but ONE server per box with slotting for the two small-LLMs
     (noticing + reverie share the E2B?) is worth a look — reverie on the
     uncensored E4B was a quality choice, not a hard requirement.
   - Lower `-ngl` (more CPU offload, less pinned RAM) on the small models;
     they're not latency-critical (180s cadences).
   - `-c 2048` for the small-LLMs (they don't need 4096; the vision server DOES
     — multi-frame requests measure ~2500 tokens).
4. **Buy headroom** — 28GB is simply tight for this topology; swap upgrades are
   cheap insurance if this box stays the dev host.

Recommended pairing: **option 1 (systemd) + option 3's context sizes**, with the
supervisor (option 2) built only if the Windows/cross-platform case needs it.

## Verification checklist for whoever fixes this

- [ ] Unit files start all three servers at login (or boot) with the flags from
      the table above (vision needs `-c 4096`!)
- [ ] `OOMScoreAdjust` no longer +200
      (`systemctl --user show <unit> |
      grep OOMScoreAdjust` → 0 or
      negative)
- [ ] `systemctl --user kill <unit>` → server returns within ~15s, health dot
      flips red→green on the Flux page
- [ ] Sustained memory pressure (open enough Chromium tabs) kills and restarts
      the servers WITHOUT daemon-side corpse-retry loops beyond one health tick
- [ ] The daemon's flux-settings.json URLs unchanged (127.0.0.1 ports)
