/**
 * Discord Gateway Module
 *
 * Exports the Discord gateway client, message router,
 * conversation mapper, and response handler.
 */

export { DiscordGatewayClient } from "./gateway.ts";
export type {
  DiscordAttachment,
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

export {
  captionTurnImages,
  downloadTurnImage,
  downloadTurnImages,
  planTurnAttachments,
} from "./images.ts";
export type {
  AttachmentEnrichmentChannel,
  DiscordPluginAttachment,
  DiscordTurnImage,
  DownloadedImage,
  TurnAttachmentPlan,
} from "./images.ts";

export { ConversationMapper } from "./conversation-map.ts";
export {
  encodeEmojiForApi,
  ResponseHandler,
  splitMessage,
} from "./response.ts";
