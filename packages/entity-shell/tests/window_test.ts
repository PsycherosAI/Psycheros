import { assert, assertEquals } from "@std/assert";
import type { FoldInput, FoldWriter } from "../src/window/rolling.ts";
import { RollingWindow } from "../src/window/rolling.ts";

// Small-config world: every line is 20 chars (21 counted per entry).
const line = (i: number) => `L${String(i).padStart(19, "0")}`;
const at = "2026-09-04T23:00:00.000Z";

interface WriterLog {
  inputs: FoldInput[];
  writer: FoldWriter;
}

function fakeWriter(): WriterLog {
  const inputs: FoldInput[] = [];
  return {
    inputs,
    writer: (input) => {
      inputs.push(input);
      return Promise.resolve({
        rooms: [],
        people: [],
        events: [],
        openThreads: [],
        pinnedQuotes: [],
        narrative: `I folded ${input.entries.length} entries (${
          input.entries[0]!.text.slice(0, 4)
        }…)`,
      });
    },
  };
}

Deno.test("under budget: nothing folds, tail renders verbatim", async () => {
  const log = fakeWriter();
  const window = new RollingWindow(
    { maxVerbatimChars: 1000, tailFloorChars: 300, foldChunkChars: 250 },
    log.writer,
  );
  for (let i = 0; i < 10; i++) window.pushLine(line(i), at);
  window.pushCommand("look", at);

  assertEquals(window.needsFold(), false);
  assertEquals(await window.foldIfDue(), undefined);
  assertEquals(log.inputs.length, 0);
  assertEquals(window.renderFolds(), "");
  assert(window.renderTail().includes(line(0)));
  assert(window.renderTail().includes(line(9)));
  assert(window.renderTail().includes("I sent: look"));
});

Deno.test("fold takes the oldest chunk and never crosses the tail floor", async () => {
  const log = fakeWriter();
  const window = new RollingWindow(
    { maxVerbatimChars: 1000, tailFloorChars: 300, foldChunkChars: 250 },
    log.writer,
  );
  for (let i = 0; i < 30; i++) {
    if (i === 4) window.pushCommand("look", at);
    window.pushLine(line(i), at);
  }
  // 30 lines (21 chars each) + 1 command (5) = 635 chars.
  assertEquals(window.needsFold(), true);

  const fold = await window.fold();
  assert(fold !== undefined);
  assertEquals(log.inputs.length, 1);
  const chunk = log.inputs[0]!.entries;
  // 4 lines + the short command + 7 more lines fit inside 250 chars.
  assertEquals(chunk.length, 12);
  assertEquals(chunk[0]!.text, line(0));
  assert(chunk.some((e) => e.kind === "command"));

  // Hard invariant: verbatim region stays at or above the tail floor.
  assert(window.verbatimChars >= 300);

  const folds = window.renderFolds();
  assert(folds.includes("I folded 12 entries"), folds);
  const tail = window.renderTail();
  assertEquals(tail.includes(line(0)), false);
  assert(tail.includes(line(29)));
});

Deno.test("nothing foldable when everything is inside the tail floor", async () => {
  const log = fakeWriter();
  const window = new RollingWindow(
    { maxVerbatimChars: 1000, tailFloorChars: 300, foldChunkChars: 250 },
    log.writer,
  );
  for (let i = 0; i < 16; i++) window.pushLine(line(i), at); // 336 chars

  assertEquals(window.needsFold(), false);
  assertEquals(await window.fold(), undefined);
  assertEquals(log.inputs.length, 0);
});

Deno.test("folds merge once the fold region itself overflows", async () => {
  const log = fakeWriter();
  let merges = 0;
  const window = new RollingWindow(
    {
      maxVerbatimChars: 2000,
      tailFloorChars: 300,
      foldChunkChars: 250,
      maxFoldChars: 40,
    },
    log.writer,
    (folds) => {
      merges++;
      return Promise.resolve({
        rooms: [...new Set(folds.flatMap((f) => f.rooms))],
        people: [],
        events: [],
        openThreads: [],
        pinnedQuotes: [],
        narrative: folds.map((f) => f.narrative).join("\n\n"),
      });
    },
  );
  for (let i = 0; i < 60; i++) window.pushLine(line(i), at);

  let guard = 0;
  while (window.needsFold() && guard++ < 20) await window.fold();

  assert(guard < 20, "fold loop did not converge");
  assert(merges >= 1, "expected at least one fold merge");
  assert(
    window.foldCount < 5,
    `fold count should have merged down: ${window.foldCount}`,
  );
  assert(window.renderFolds().includes("\n\n"));
  assert(window.verbatimChars >= 300);
  assert(window.renderTail().includes(line(59)));
});
