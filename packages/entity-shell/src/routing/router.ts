import type { HudState, RoomSlot } from "../state/mod.ts";
import type { MuLine } from "../transport/mod.ts";
import type { RoutedLine } from "./mod.ts";

const ROOM_NAME_RE = /^(.+?)\(#(\d+)([A-Za-z]*)\)$/;
const EXITS_HEADER = "Obvious exits:";
const CONTENTS_HEADER = "Contents:";
const ARRIVES_RE = /^(\S+) arrives(?:\.| from | through )/;
const LEAVES_RE = /^(\S+) leaves(?:\.| to | through )/;
const CONNECTED_RE = /^(\S+) has connected\.$/;
const DISCONNECTED_RE = /^(\S+) has disconnected\.$/;
const NAME_IN_CONTENTS_RE = /^(.+?)(?:\(.+\))?$/;

type Mode = "idle" | "provisional" | "room-desc" | "exits" | "contents";

/** Cap on provisional chatter before a block anchor must appear. */
const MAX_PROVISIONAL = 12;

/**
 * Generic PennMUSH-family line router: look blocks feed the room slot,
 * presence events update the presence slot while staying in scrollback
 * (they are witnessed events), and everything unrecognized scrolls.
 *
 * Heuristics, not protocol: a look block ends at a blank line or restarts
 * at a new room-name line; if a game emits no trailing blank, following
 * non-room output can pollute the block — scrollback and the transcript DB
 * stay ground truth.
 */
export class MushRouter {
  readonly #hud: HudState;
  #mode: Mode = "idle";
  #pendingRoom: RoomSlot | undefined;
  #contentsNames: string[] = [];
  #provisionalLines: string[] = [];

  constructor(hud: HudState) {
    this.#hud = hud;
  }

  /** True while a look block is open (waiting for its terminator). */
  get midBlock(): boolean {
    return this.#mode !== "idle";
  }

  /**
   * Finalize any open block now — for games that send no trailing blank
   * line after a look block. The session calls this after a short quiet gap.
   */
  settle(): void {
    if (this.#mode === "contents") {
      this.#hud.replaceHere(this.#contentsNames);
      this.#contentsNames = [];
    }
    if (this.#mode !== "idle") this.#finalizeRoom();
    this.#mode = "idle";
  }

  route(line: MuLine): RoutedLine {
    const text = line.text;
    const roomLine = ROOM_NAME_RE.exec(text);
    switch (this.#mode) {
      case "room-desc":
        if (text === "" || roomLine) {
          this.#finalizeRoom(line);
          if (roomLine) return this.#openRoom(roomLine, line);
          return this.#toSlot("room", line);
        }
        if (text === EXITS_HEADER) {
          this.#mode = "exits";
          return this.#toSlot("room", line);
        }
        if (text === CONTENTS_HEADER) {
          this.#mode = "contents";
          this.#contentsNames = [];
          return this.#toSlot("room", line);
        }
        this.#pendingRoom?.description.push(text);
        return this.#toSlot("room", line);
      case "exits":
        if (text === "" || roomLine) {
          this.#finalizeRoom(line);
          if (roomLine) return this.#openRoom(roomLine, line);
          return this.#toSlot("room", line);
        }
        this.#pendingRoom?.exits.push(text.trim());
        return this.#toSlot("room", line);
      case "contents": {
        // PennMUSH order: Contents comes before Obvious exits.
        if (text === EXITS_HEADER) {
          this.#hud.replaceHere(this.#contentsNames, line);
          this.#contentsNames = [];
          this.#mode = "exits";
          return this.#toSlot("room", line);
        }
        // A contents entry can itself look like "Name(#45)" — PennMUSH
        // shows dbrefs there — so only a blank line ends the block here.
        if (text === "") {
          this.#hud.replaceHere(this.#contentsNames, line);
          this.#finalizeRoom(line);
          return this.#toSlot("room", line);
        }
        const name = NAME_IN_CONTENTS_RE.exec(text.trim())?.[1]?.trim();
        if (name) this.#contentsNames.push(name);
        return this.#toSlot("room", line);
      }
      case "provisional": {
        // Some games show bare room names with no (#dbref) anchor — collect
        // quietly and promote to a real look block when a header appears.
        if (text === "" || this.#provisionalLines.length >= MAX_PROVISIONAL) {
          this.#mode = "idle";
          this.#provisionalLines = [];
          return this.#toScrollback(line);
        }
        this.#provisionalLines.push(text);
        if (text === EXITS_HEADER || text === CONTENTS_HEADER) {
          const [first, ...rest] = this.#provisionalLines;
          this.#pendingRoom = {
            name: (first ?? "").trim(),
            description: rest.slice(0, -1),
            exits: [],
            source: "look",
            updatedAt: line.receivedAt,
          };
          this.#mode = text === EXITS_HEADER ? "exits" : "contents";
          this.#contentsNames = [];
          this.#provisionalLines = [];
          return this.#toSlot("room", line);
        }
        return this.#toScrollback(line);
      }
    }

    if (roomLine) return this.#openRoom(roomLine, line);

    let who = ARRIVES_RE.exec(text)?.[1];
    if (who === undefined) who = CONNECTED_RE.exec(text)?.[1];
    if (who !== undefined) {
      this.#hud.addHere(who, line);
      return this.#toScrollback(line);
    }
    who = LEAVES_RE.exec(text)?.[1] ?? DISCONNECTED_RE.exec(text)?.[1];
    if (who !== undefined) {
      this.#hud.removeHere(who, line);
      return this.#toScrollback(line);
    }
    if (text !== "") {
      this.#mode = "provisional";
      this.#provisionalLines = [text];
    }
    return this.#toScrollback(line);
  }

  #openRoom(match: RegExpExecArray, line: MuLine): RoutedLine {
    this.#pendingRoom = {
      name: match[1]!,
      dbref: `#${match[2]}`,
      flags: match[3],
      description: [],
      exits: [],
      source: "look",
      updatedAt: line.receivedAt,
    };
    this.#mode = "room-desc";
    return this.#toSlot("room", line);
  }

  #finalizeRoom(line?: MuLine): void {
    if (this.#pendingRoom !== undefined) {
      this.#pendingRoom.updatedAt = line?.receivedAt ??
        new Date().toISOString();
      this.#hud.room = this.#pendingRoom;
      this.#pendingRoom = undefined;
    }
    this.#mode = "idle";
  }

  #toSlot(slot: string, line: MuLine): RoutedLine {
    return { line, sink: "hud-slot", slot };
  }

  #toScrollback(line: MuLine): RoutedLine {
    return { line, sink: "scrollback" };
  }
}
