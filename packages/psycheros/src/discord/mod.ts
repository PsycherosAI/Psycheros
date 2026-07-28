/**
 * Discord Gateway Module
 *
 * Exports the Discord gateway client, message router,
 * conversation mapper, and response handler.
 */

export { DiscordGatewayClient } from "./gateway.ts";
export type {
  DiscordChannel,
  DiscordGuild,
  DiscordMessage,
  DiscordUser,
  GatewayEventHandler,
  GatewayEventType,
} from "./gateway.ts";

export { MessageRouter } from "./router.ts";
export type {
  AccumulatedMessage,
  DiscordTurnContext,
  DiscordTurnDisposition,
  DiscordTurnOutcome,
  RouterDeps,
} from "./router.ts";
export { DiscordPendingStore } from "./pending-store.ts";
export type { PendingDiscordMessage } from "./pending-store.ts";
export { classifyDiscordTurnDisposition } from "./disposition.ts";

export { ConversationMapper } from "./conversation-map.ts";
export {
  encodeEmojiForApi,
  ResponseHandler,
  splitMessage,
} from "./response.ts";
