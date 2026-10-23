import { assert, assertEquals } from "@std/assert";
import { MushRouter } from "../src/routing/router.ts";
import { HudState } from "../src/state/hud.ts";
import type { MuLine } from "../src/transport/mod.ts";

const TS = "2026-09-04T23:27:45.000Z";

function line(text: string): MuLine {
  return { text, receivedAt: TS };
}

function feed(hud: HudState, texts: string[]) {
  const router = new MushRouter(hud);
  const scrollback: string[] = [];
  const slotLines: string[] = [];
  for (const text of texts) {
    const routed = router.route(line(text));
    if (routed.sink === "scrollback") scrollback.push(text);
    else slotLines.push(text);
  }
  return { scrollback, slotLines };
}

// Verbatim from the live PennMUSH run on 127.0.0.1:4201 (ANSI already
// stripped by the transport).
const CONNECT_AND_LOOK = [
  "<This is where you announce that they've connected to your MUSH>",
  "<It's a good idea to include the version/patchlevel of MUSH you're running>",
  "-----------------------------------------------------------------------------",
  "Use create <name> <password> to create a character.",
  "Use connect <name> <password> to connect to your existing character.",
  "Use QUIT to logout.",
  "-----------------------------------------------------------------------------",
  "",
  "Welcome to PennMUSH!",
  "Yell at your god to personalize this file",
  "",
  " ",
  "Last connect was from localhost on Fri Sep 04 23:27:45 2026.",
  "",
  "MAIL: You have no mail.",
  "",
  "Room Zero(#0RL)",
  "You are in Room Zero.",
  "Obvious exits:",
  "Nave",
  "",
  "Player Name          On For   Idle  Doing",
  "Pilgrim                  6s     0s  ",
  "There is one player connected.",
];

Deno.test("routes a live PennMUSH connect stream into HUD + scrollback", () => {
  const hud = new HudState();
  const { scrollback, slotLines } = feed(hud, CONNECT_AND_LOOK);

  assertEquals(hud.room?.name, "Room Zero");
  assertEquals(hud.room?.dbref, "#0");
  assertEquals(hud.room?.flags, "RL");
  assertEquals(hud.room?.description, ["You are in Room Zero."]);
  assertEquals(hud.room?.exits, ["Nave"]);
  assertEquals(hud.room?.source, "look");

  const rendered = hud.render();
  assert(rendered.includes("Where I am: Room Zero (#0)"), rendered);
  assert(rendered.includes("Exits: Nave"), rendered);
  assert(rendered.includes("Here with me: nobody"), rendered);

  assert(
    scrollback.some((l) => l.startsWith("Last connect was from localhost")),
  );
  assert(scrollback.some((l) => l.startsWith("Player Name")));
  assertEquals(scrollback.includes("Room Zero(#0RL)"), false);
  assertEquals(scrollback.includes("Nave"), false);
  assert(slotLines.includes("Room Zero(#0RL)"));
});

Deno.test("contents replace presence; arrivals and departures track it", () => {
  const hud = new HudState();
  feed(hud, [
    "Garden(#17R)",
    "Sun-warmed hedges.",
    "Contents:",
    "Vesper",
    "Tallow(#45)",
    "",
  ]);
  assertEquals(hud.presence.here, ["Vesper", "Tallow"]);

  const { scrollback: leavesScroll } = feed(hud, [
    "Vesper leaves to the nave.",
  ]);
  assertEquals(hud.presence.here, ["Tallow"]);

  feed(hud, ["Vesper arrives from the nave."]);
  assertEquals(hud.presence.here, ["Tallow", "Vesper"]);

  feed(hud, ["Tallow has disconnected."]);
  assertEquals(hud.presence.here, ["Vesper"]);
  assert(hud.render().includes("Here with me: Vesper"));

  // Presence events are witnessed events — they stay in scrollback verbatim.
  assert(leavesScroll.includes("Vesper leaves to the nave."));
});

Deno.test("empty HUD renders the try-look fallback", () => {
  const hud = new HudState();
  new MushRouter(hud).route(line('Someone says, "hello."'));
  assert(hud.render().includes("Where I am: unknown — try look"));
  assertEquals(hud.presence.here, []);
});

// Verbatim shape from the live test MUSH, where player-built rooms announce
// bare names with no (#dbref) anchor.
Deno.test("bare room names promote on block headers", () => {
  const hud = new HudState();
  feed(hud, [
    "Cathedral Nave",
    "Sunlight falls in tall colored shafts through the lancet windows.",
    "Contents:",
    "beeswax candle",
    "Obvious exits:",
    "Undercroft and Cloister Garden",
    "",
  ]);
  assertEquals(hud.room?.name, "Cathedral Nave");
  assert(
    hud.room?.description[0]?.startsWith("Sunlight falls") ?? false,
    JSON.stringify(hud.room?.description),
  );
  assertEquals(hud.room?.exits, ["Undercroft and Cloister Garden"]);
  assertEquals(hud.presence.here, ["beeswax candle"]);
});
