import type { DiscordTurnDisposition } from "./router.ts";

export function classifyDiscordTurnDisposition(options: {
  discordActionAttempted: boolean;
  discordActionSucceeded: boolean;
}): DiscordTurnDisposition {
  if (!options.discordActionAttempted) return "deliberately_quiet";
  return options.discordActionSucceeded ? "contributed" : "failed";
}
