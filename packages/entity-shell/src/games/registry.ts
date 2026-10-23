import type { GameAdapter } from "./types.ts";

const games = new Map<string, GameAdapter>();

export function registerGame(adapter: GameAdapter): void {
  games.set(adapter.id, adapter);
}

export function getGame(id: string): GameAdapter {
  const game = games.get(id);
  if (game === undefined) {
    throw new Error(
      `unknown game "${id}" — registered: ${[...games.keys()].join(", ")}`,
    );
  }
  return game;
}

export function listGames(): GameAdapter[] {
  return [...games.values()];
}
