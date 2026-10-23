import type { HudState } from "../state/mod.ts";
import type { MuLine } from "../transport/mod.ts";
import type { RoutedLine } from "../routing/mod.ts";

/** Connection details, game-agnostic in shape. */
export interface GameConnectionOptions {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password?: string;
  onLine: (line: MuLine) => void;
  onClose: (reason?: Error) => void;
}

export interface GameConnection {
  send(command: string): Promise<void>;
  close(): void;
}

/** A tool the entity gets while playing — plain JSON Schema, no loop deps. */
export interface GameToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

/** A game's line router, owned per session. */
export interface GameLineRouter {
  route(line: MuLine): RoutedLine;
  /** True while a multi-line block is open; the session settles it after a quiet gap. */
  get midBlock(): boolean;
  settle(): void;
}

export interface GameToolsContext {
  /** The only path out to the game world — records into my window too. */
  send: (command: string) => Promise<void>;
}

/**
 * A game the shell knows how to wear. Everything game-specific lives here:
 * transport, line routing, tools, and what counts as a direct message to me.
 * The session, window, HUD slots, and ports stay game-agnostic.
 */
export interface GameAdapter {
  /** Registry id, e.g. "pennmush" — what `play({game})` selects. */
  id: string;
  label: string;
  /**
   * What this game is, in my voice — rides in the stable prompt region so I
   * know the world I'm in and everything I can normally do in it. Games whose
   * culture is old, well-known knowledge (MU*) can stay short: name the
   * server family and say the whole command surface is mine.
   */
  blurb?: string;
  connect(options: GameConnectionOptions): Promise<GameConnection>;
  createRouter(hud: HudState): GameLineRouter;
  tools(ctx: GameToolsContext): GameToolSpec[];
  /** Lines that are private messages to me — DM-like, always worth a turn. */
  isDirectMessage?(text: string): boolean;
}
