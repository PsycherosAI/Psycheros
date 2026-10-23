export type {
  GameAdapter,
  GameConnection,
  GameConnectionOptions,
  GameLineRouter,
  GameToolsContext,
  GameToolSpec,
} from "./types.ts";
export { getGame, listGames, registerGame } from "./registry.ts";

// Importing pennmush registers it — the default game in the registry.
import "./pennmush.ts";
