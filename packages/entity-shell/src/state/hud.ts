import type { MuLine } from "../transport/mod.ts";

export interface RoomSlot {
  name: string;
  dbref?: string;
  flags?: string;
  description: string[];
  exits: string[];
  /** What populated the slot — "look" for now; movement auto-look is the
   * same PennMUSH output, so it lands here too. */
  source?: string;
  updatedAt?: string;
}

export interface PresenceSlot {
  here: string[];
  updatedAt?: string;
}

/**
 * My HUD: the always-in-context cockpit display. Slots are advisory state
 * derived from routed lines — raw scrollback and the transcript DB remain
 * ground truth when a parser misreads.
 */
export class HudState {
  room: RoomSlot | undefined;
  presence: PresenceSlot = { here: [] };
  map: string | undefined;
  inventory: string | undefined;

  addHere(name: string, line?: MuLine): void {
    if (!this.presence.here.includes(name)) {
      this.presence.here = [...this.presence.here, name];
    }
    this.presence.updatedAt = line?.receivedAt;
  }

  removeHere(name: string, line?: MuLine): void {
    this.presence.here = this.presence.here.filter((n) => n !== name);
    this.presence.updatedAt = line?.receivedAt;
  }

  replaceHere(names: string[], line?: MuLine): void {
    this.presence.here = names;
    this.presence.updatedAt = line?.receivedAt;
  }

  render(): string {
    const parts: string[] = [];
    if (this.map !== undefined) parts.push(`Map:\n${this.map}`);
    parts.push(
      this.room === undefined ? "Where I am: unknown — try look" : [
        `Where I am: ${this.room.name}${
          this.room.dbref ? ` (${this.room.dbref})` : ""
        }`,
        ...this.room.description,
        ...(this.room.exits.length > 0
          ? [`Exits: ${this.room.exits.join(", ")}`]
          : []),
      ].join("\n"),
    );
    parts.push(
      this.presence.here.length > 0
        ? `Here with me: ${this.presence.here.join(", ")}`
        : "Here with me: nobody",
    );
    if (this.inventory !== undefined) {
      parts.push(`What I'm carrying: ${this.inventory}`);
    }
    return parts.join("\n\n");
  }
}
