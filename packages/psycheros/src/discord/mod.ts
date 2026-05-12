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
  RouterDeps,
} from "./router.ts";

export { ConversationMapper } from "./conversation-map.ts";
export { ResponseHandler } from "./response.ts";
