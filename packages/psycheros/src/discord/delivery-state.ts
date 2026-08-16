export type DiscordDeliveryOwner = string;

/** I share this within one Discord turn so only one tool owns my delivery. */
export interface DiscordDeliveryState {
  claimedBy?: DiscordDeliveryOwner;
}

export function claimDiscordDelivery(
  state: DiscordDeliveryState | undefined,
  tool: DiscordDeliveryOwner,
): boolean {
  if (!state) return true;
  if (state.claimedBy && state.claimedBy !== tool) return false;
  state.claimedBy = tool;
  return true;
}
