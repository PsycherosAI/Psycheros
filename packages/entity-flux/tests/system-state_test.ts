/**
 * system-state tests — the pure gate: idle/active via probe counts, lock
 * transitions, session diffing, blindness holds, silent first adoption.
 * Capture parser tested against a real /proc/interrupts excerpt.
 */

import { assertEquals } from "@std/assert";
import {
  defaultSystemStateConfig,
  freshSystemStateGate,
  type SystemStateSample,
} from "../src/organs/system-state/types.ts";
import { stepSystemGate } from "../src/organs/system-state/system-gate.ts";
import {
  type CommandRunner,
  parseInputCount,
  runCommand,
} from "../src/organs/system-state/capture.ts";
import { createSystemStateOrgan } from "../src/organs/system-state/system-state-organ.ts";

const config = defaultSystemStateConfig(); // idleAfterProbes: 120

function sample(o: Partial<SystemStateSample> = {}): SystemStateSample {
  return {
    at: 0,
    up: true,
    inputCount: 1000,
    locked: false,
    sessions: ["operator"],
    load1: 0.5,
    ...o,
  };
}

function kinds(ts: Array<{ kind: string }>): string[] {
  return ts.map((t) => t.kind);
}

Deno.test("system-state: first observations adopt silently", () => {
  let g = freshSystemStateGate();
  let step = stepSystemGate(g, sample(), config);
  g = step.state;
  assertEquals(step.transitions, []);
  // Second sample with input: adopts active, still silent.
  step = stepSystemGate(g, sample({ inputCount: 1100, at: 5_000 }), config);
  assertEquals(step.transitions, []);
  assertEquals(step.state.active, true);
});

Deno.test("system-state: idle only after the full probe count", () => {
  let g = freshSystemStateGate();
  g = stepSystemGate(g, sample(), config).state;
  g = stepSystemGate(g, sample({ inputCount: 1100 }), config).state;
  assertEquals(g.active, true);
  // 119 input-free probes: still active, no event.
  for (let i = 0; i < 119; i++) {
    const step = stepSystemGate(g, sample({ inputCount: 1100 }), config);
    assertEquals(step.transitions, []);
    g = step.state;
  }
  assertEquals(g.active, true);
  // 120th: the event.
  const step = stepSystemGate(g, sample({ inputCount: 1100 }), config);
  assertEquals(kinds(step.transitions), ["user_idle"]);
  assertEquals(step.state.active, false);
});

Deno.test("system-state: any input returns the user, once", () => {
  let g = freshSystemStateGate();
  g = stepSystemGate(g, sample(), config).state;
  g = stepSystemGate(g, sample({ inputCount: 1100 }), config).state;
  for (let i = 0; i < 120; i++) {
    g = stepSystemGate(g, sample({ inputCount: 1100 }), config).state;
  }
  assertEquals(g.active, false);
  const back = stepSystemGate(g, sample({ inputCount: 1110 }), config);
  assertEquals(kinds(back.transitions), ["user_active"]);
  assertEquals(back.state.active, true);
  // Continuing input: no repeat events.
  const more = stepSystemGate(back.state, sample({ inputCount: 1200 }), config);
  assertEquals(more.transitions, []);
});

Deno.test("system-state: lock and unlock are transitions, holds are silent", () => {
  let g = freshSystemStateGate();
  g = stepSystemGate(g, sample(), config).state;
  g = stepSystemGate(g, sample({ inputCount: 1100 }), config).state;
  let step = stepSystemGate(
    g,
    sample({ inputCount: 1100, locked: true }),
    config,
  );
  assertEquals(kinds(step.transitions), ["locked"]);
  g = step.state;
  // Still locked: nothing.
  step = stepSystemGate(g, sample({ inputCount: 1100, locked: true }), config);
  assertEquals(step.transitions, []);
  step = stepSystemGate(g, sample({ inputCount: 1100, locked: false }), config);
  assertEquals(kinds(step.transitions), ["unlocked"]);
});

Deno.test("system-state: session arrivals and departures diff cleanly", () => {
  let g = freshSystemStateGate();
  g = stepSystemGate(g, sample({ sessions: ["operator"] }), config).state;
  let step = stepSystemGate(
    g,
    sample({ inputCount: 1100, sessions: ["operator", "root"] }),
    config,
  );
  assertEquals(kinds(step.transitions), ["session_opened"]);
  assertEquals(step.transitions[0].session, "root");
  g = step.state;
  step = stepSystemGate(
    g,
    sample({ inputCount: 1100, sessions: ["operator"] }),
    config,
  );
  assertEquals(kinds(step.transitions), ["session_closed"]);
  assertEquals(step.transitions[0].session, "root");
});

Deno.test("system-state: blindness holds everything", () => {
  let g = freshSystemStateGate();
  g = stepSystemGate(g, sample(), config).state;
  g =
    stepSystemGate(g, sample({ inputCount: 1100, locked: true }), config).state;
  const held = stepSystemGate(
    g,
    sample({ up: false, inputCount: null, locked: null, sessions: [] }),
    config,
  );
  assertEquals(held.transitions, []);
  assertEquals(held.state, g);
});

Deno.test("parseInputCount: sums matching handlers only", () => {
  const proc = `
IRQ:  1  2
  42:  100  50  IR-PCI-MSIX-foo  xhci_hcd
  43:  7  IR-PCI-MSIX-bar  nvme
  44:  3  4  i8042
CPU0
`;
  const total = parseInputCount(proc, "i8042|keyboard|mouse|xhci_hcd");
  assertEquals(total, 157); // 100+50+3+4, nvke excluded
  assertEquals(parseInputCount("no matches", "i8042"), null);
});

Deno.test("runCommand: stdout passes through, failure is null", async () => {
  assertEquals(await runCommand(["/bin/sh", "-c", "printf ' hi  \\n'"]), "hi");
  assertEquals(await runCommand(["/bin/sh", "-c", "exit 3"]), null);
});

Deno.test("runCommand: the wall clock kills a stalled exec", async () => {
  const at = Date.now();
  const out = await runCommand(["/bin/sh", "-c", "sleep 30"], 200);
  assertEquals(out, null);
  assertEquals(Date.now() - at < 5_000, true);
});

Deno.test("system-state organ: one probe in flight, ever", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let calls = 0;
    let release!: () => void;
    const blocks = new Promise<void>((r) => {
      release = r;
    });
    // Poll shape: interrupts + loadavg + loginctl list fire together;
    // an empty session list keeps probeSessions at one call. The first
    // call parks until released — poll 1 stays in flight.
    const runner: CommandRunner = (command) => {
      calls++;
      if (command.includes("loginctl")) return Promise.resolve("");
      if (command.includes("loadavg")) {
        return Promise.resolve("0.50 0.40 0.30 1/100 1234");
      }
      if (calls === 1) return blocks.then(() => "42: 100 xhci_hcd\nCPU0\n");
      return Promise.resolve("42: 100 xhci_hcd\nCPU0\n");
    };
    const organ = createSystemStateOrgan(
      defaultSystemStateConfig(),
      () => {},
      { dataRoot: dir },
      runner,
    );
    organ.start();
    while (calls < 3) await new Promise((r) => setTimeout(r, 5));
    // Poll 1 is parked on its first command; another tick must not start
    // a second poll — no new runner calls.
    await organ.tick();
    assertEquals(calls, 3);
    release();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(calls, 3); // poll 1 finished; nothing else leaked in
    await organ.tick(); // slot free: poll 2 runs to completion
    assertEquals(calls, 6);
    organ.stop();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
