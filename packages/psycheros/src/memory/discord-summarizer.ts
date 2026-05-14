/**
 * Discord Activity Pre-Summarizer
 *
 * Produces a first-person summary of Discord activity for a given day,
 * written from the entity's perspective using their full identity context.
 * This summary is injected into the daily memory writer prompt so the
 * entity can remember what it did on Discord without raw messages blowing out
 * the context window.
 */

import { join } from "@std/path";
import type { DBClient } from "../db/mod.ts";
import type { ChatMessage, LLMClient } from "../llm/mod.ts";
import { getTimezoneModifier } from "./date-utils.ts";
import { buildIdentitySystemMessage } from "../entity/context.ts";

/**
 * Maximum character budget for the pre-summarizer input.
 * ~25k tokens at 4 chars/token, well within a 32k context window.
 * Messages are truncated from oldest to newest (FIFO) if exceeded.
 */
const MAX_PRE_SUMMARY_CHARS = 100_000;

const DISCORD_SUMMARY_PROMPT =
  `I am {{ENTITY_NAME}}, writing a summary of my Discord activity from today so I can remember it later.

{{INSTRUCTIONS}}

My Discord conversations:

{{MESSAGES}}

I write a concise summary of my Discord activity, grouped by server. I include the names of people I interacted with and the key topics we discussed. I write in first-person — this is my activity, my conversations.`;

/**
 * Format Discord messages grouped by server/channel for the pre-summarizer prompt.
 */
function formatDiscordMessages(
  conversations: Array<{
    serverName: string;
    channelName: string;
    messages: Array<{ role: string; content: string }>;
  }>,
): string {
  const parts: string[] = [];

  for (const conv of conversations) {
    const header = conv.serverName
      ? `## Server: ${conv.serverName} — #${conv.channelName}`
      : `## #${conv.channelName} (DM)`;
    parts.push(header);

    for (const msg of conv.messages) {
      if (msg.role === "system" || msg.role === "tool") continue;
      const role = msg.role === "user" ? "User" : "Entity";
      parts.push(`**${role}**: ${msg.content}`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Truncate messages from oldest to newest until total chars fit within budget.
 * Returns the truncated list and logs a warning if truncation occurred.
 */
function truncateToFit(
  conversations: Array<{
    serverName: string;
    channelName: string;
    messages: Array<{ role: string; content: string }>;
  }>,
): typeof conversations {
  interface FlatMsg {
    convIdx: number;
    msgIdx: number;
    content: string;
  }

  const flat: FlatMsg[] = [];
  for (let ci = 0; ci < conversations.length; ci++) {
    for (let mi = 0; mi < conversations[ci].messages.length; mi++) {
      const msg = conversations[ci].messages[mi];
      if (msg.role === "system" || msg.role === "tool") continue;
      flat.push({ convIdx: ci, msgIdx: mi, content: msg.content });
    }
  }

  const headerOverhead = conversations.reduce((acc, c) => {
    const header = c.serverName
      ? `## Server: ${c.serverName} — #${c.channelName}\n`
      : `## #${c.channelName} (DM)\n`;
    return acc + header.length + c.messages.length * 15;
  }, 0);

  const availableForContent = MAX_PRE_SUMMARY_CHARS - headerOverhead;
  if (availableForContent <= 0) {
    console.warn(
      "[Memory] Discord pre-summary: header overhead alone exceeds budget, using only headers",
    );
    return conversations.map((c) => ({ ...c, messages: [] }));
  }

  let totalContentLen = flat.reduce((acc, m) => acc + m.content.length, 0);

  if (totalContentLen <= availableForContent) {
    return conversations;
  }

  const removed = new Set<string>();
  let removedCount = 0;
  for (const msg of flat) {
    if (totalContentLen <= availableForContent) break;
    const key = `${msg.convIdx}:${msg.msgIdx}`;
    if (removed.has(key)) continue;
    removed.add(key);
    totalContentLen -= msg.content.length;
    removedCount++;
  }

  console.warn(
    `[Memory] Discord pre-summary: truncated ${removedCount} oldest messages to fit ${MAX_PRE_SUMMARY_CHARS} char budget`,
  );

  return conversations.map((c, ci) => ({
    ...c,
    messages: c.messages.filter((_, mi) => !removed.has(`${ci}:${mi}`)),
  }));
}

/**
 * Result of Discord activity pre-summarization.
 */
export interface DiscordSummaryResult {
  /** Formatted summary text (empty if no activity) */
  summary: string;
  /** Synthetic chat ID for memory tagging (e.g. "Discord-ServerName-2026-05-08") */
  syntheticChatId: string;
  /** Real conversation IDs that were processed (for summarized_chats tracking) */
  conversationIds: string[];
}

/**
 * Summarize Discord activity for a specific date.
 *
 * @returns DiscordSummaryResult with summary text and tracking IDs
 */
export async function summarizeDiscordActivity(
  date: Date,
  db: DBClient,
  llm: LLMClient,
  dataRoot: string,
  config: { timezone?: string; cutoffHour?: number; instructions?: string },
): Promise<DiscordSummaryResult> {
  const dateStr = date.toISOString().split("T")[0];

  // Load entity name from general settings
  let entityName = "the AI entity";
  try {
    const text = await Deno.readTextFile(
      join(dataRoot, ".psycheros", "general-settings.json"),
    );
    const saved = JSON.parse(text) as { entityName?: string };
    if (saved.entityName) entityName = saved.entityName;
  } catch { /* use default */ }

  const modifier = config.timezone
    ? getTimezoneModifier(config.timezone, config.cutoffHour ?? 5)
    : undefined;

  const messages = db.getMessagesByDate(date, modifier, "discord");
  if (messages.length === 0) {
    return { summary: "", syntheticChatId: "", conversationIds: [] };
  }

  // Group by conversation
  const convMap = new Map<string, Array<{ role: string; content: string }>>();
  for (const msg of messages) {
    const existing = convMap.get(msg.conversationId) || [];
    existing.push({ role: msg.role, content: msg.content });
    convMap.set(msg.conversationId, existing);
  }

  // Collect real conversation IDs and build objects with metadata
  const conversationIds = Array.from(convMap.keys());
  const serverNames = new Set<string>();

  const conversations: Array<{
    serverName: string;
    channelName: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];

  for (const [convId, msgs] of convMap) {
    const conv = db.getConversation(convId);
    const serverName = conv?.sourceServerName || "DM";
    serverNames.add(serverName);
    conversations.push({
      serverName,
      channelName: conv?.sourceChannelName || conv?.title || "unknown",
      messages: msgs,
    });
  }

  // Build synthetic chat ID: Discord-ServerName-date (or Discord-DM-date for DMs)
  const syntheticChatId = `Discord-${
    Array.from(serverNames).join("-")
  }-${dateStr}`;

  // Truncate if needed (FIFO — oldest messages dropped first)
  const truncated = truncateToFit(conversations);
  const formatted = formatDiscordMessages(truncated);

  if (formatted.trim().length === 0) {
    return { summary: "", syntheticChatId, conversationIds };
  }

  // Build the prompt
  const instructionsBlock = config.instructions?.trim()
    ? config.instructions.trim()
    : "";

  const prompt = DISCORD_SUMMARY_PROMPT
    .replace("{{ENTITY_NAME}}", entityName)
    .replace("{{INSTRUCTIONS}}", instructionsBlock)
    .replace("{{MESSAGES}}", formatted);

  const identitySystemMessage = await buildIdentitySystemMessage(dataRoot);
  const chatMessages: ChatMessage[] = [
    { role: "system", content: identitySystemMessage },
    { role: "user", content: prompt },
  ];

  // Call the worker model
  let response = "";
  try {
    for await (const chunk of llm.chatStream(chatMessages)) {
      if (chunk.type === "content") {
        response += chunk.content;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Memory] Discord pre-summary failed: ${errorMessage}`);
    return { summary: "", syntheticChatId, conversationIds };
  }

  return { summary: response.trim(), syntheticChatId, conversationIds };
}
