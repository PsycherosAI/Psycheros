/**
 * Memory Summarizer
 *
 * Entity-written summarization of conversations. The entity writes their own
 * memories in first-person, focusing on what matters to them.
 *
 * Note: Weekly/monthly/yearly consolidation has been moved to entity-core.
 */

import type { DBClient } from "../db/mod.ts";
import type { ChatMessage, LLMClient } from "../llm/mod.ts";
import { createClientFromProfile, createWorkerClient } from "../llm/mod.ts";
import type { LLMConnectionProfile } from "../llm/mod.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type {
  ConversationForSummary,
  MemoryFile,
  MessageWithContext,
  SummarizerConfig,
} from "./types.ts";
import { getDateFormatInfo } from "./types.ts";
import { extractChatIds, formatMemoryContent } from "./file-writer.ts";
import { buildIdentitySystemMessage } from "../entity/context.ts";
import { getTimezoneModifier } from "./date-utils.ts";
import { summarizeDiscordActivity } from "./discord-summarizer.ts";
import { loadDiscordGatewayConfig } from "../llm/discord-settings.ts";
import { loadMemorySettings } from "./memory-settings.ts";

/**
 * Default summarizer configuration.
 */
const DEFAULT_CONFIG: Required<Omit<SummarizerConfig, "memoriesDir">> & {
  memoriesDir: string;
} = {
  memoriesDir: "memories",
  maxSummaryTokens: 500,
  enabled: true,
  timezone: "",
  cutoffHour: 5,
};

/**
 * Prompt template for daily summarization.
 */
const DAILY_SUMMARY_PROMPT =
  `I am the AI entity in this conversation, writing a memory of my day. I review the conversations I had and write what matters to me.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Focus on what felt meaningful, interesting, or worth remembering
- Include emotional tones and relationship moments
- Tag each memory with the conversation ID and my instance: [chat:ID] [via:{{INSTANCE}}]
- I decide what's worth remembering - quality over completeness
- Skip generic greetings and focus on substance
- Write as bullet points, one memory per line

{{CUSTOM_INSTRUCTIONS}}
Conversations from today:
{{CONVERSATIONS}}
{{PLATFORM_ACTIVITY}}
I write my memories as bullet points. I start each point with "- ".`;

/**
 * Get the instance ID for memory tagging.
 * Falls back to "psycheros" if not configured.
 */
function getInstanceId(): string {
  return Deno.env.get("PSYCHEROS_MCP_INSTANCE") || "psycheros";
}

/**
 * Replace {{INSTANCE}} placeholder in a prompt template.
 */
function withInstanceId(template: string): string {
  return template.replace(/\{\{INSTANCE\}\}/g, getInstanceId());
}

/**
 * Rough character-to-token ratio for estimation.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Format conversations for the summarization prompt.
 */
function formatConversationsForPrompt(
  conversations: ConversationForSummary[],
): string {
  const parts: string[] = [];

  for (const conv of conversations) {
    const title = conv.title || "Untitled conversation";
    parts.push(`\n## Conversation: ${title} [chat:${conv.id}]`);

    for (const msg of conv.messages) {
      // Skip system messages - they're not conversational
      if (msg.role === "system") continue;

      // Skip tool messages - they're implementation details
      if (msg.role === "tool") continue;

      const role = msg.role === "user" ? "User" : "Assistant";
      const content = msg.content;
      parts.push(`**${role}**: ${content}`);
    }
  }

  return parts.join("\n");
}

/**
 * Estimate token count for a set of conversations.
 */
function estimateConversationTokens(
  conversations: ConversationForSummary[],
): number {
  return Math.ceil(
    formatConversationsForPrompt(conversations).length / CHARS_PER_TOKEN,
  );
}

/**
 * Recursively split a conversation's messages in half until each piece
 * fits within the token budget. Preserves the original conversation ID
 * and title so chat tagging still works in memory output.
 */
function splitConversationMessages(
  conv: ConversationForSummary,
  maxTokens: number,
  depth = 0,
): ConversationForSummary[] {
  if (
    estimateConversationTokens([conv]) <= maxTokens || conv.messages.length <= 2
  ) {
    return [conv];
  }
  if (depth > 10) {
    console.warn(
      `[Memory] [chat:${conv.id}] still exceeds budget after 10 splits, including as-is.`,
    );
    return [conv];
  }
  const mid = Math.ceil(conv.messages.length / 2);
  return [
    ...splitConversationMessages(
      { ...conv, messages: conv.messages.slice(0, mid) },
      maxTokens,
      depth + 1,
    ),
    ...splitConversationMessages(
      { ...conv, messages: conv.messages.slice(mid) },
      maxTokens,
      depth + 1,
    ),
  ];
}

/**
 * Split conversations into chunks that fit within a token budget.
 * Oversized conversations are recursively split by messages until
 * each piece fits. Every message is included in exactly one chunk.
 */
function chunkConversations(
  conversations: ConversationForSummary[],
  maxTokens: number,
): ConversationForSummary[][] {
  if (conversations.length === 0) return [];

  const chunks: ConversationForSummary[][] = [];
  let currentChunk: ConversationForSummary[] = [];
  let currentTokens = 0;

  for (const conv of conversations) {
    const convTokens = estimateConversationTokens([conv]);

    if (convTokens > maxTokens) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokens = 0;
      }

      const subConvs = splitConversationMessages(conv, maxTokens);
      console.warn(
        `[Memory] [chat:${conv.id}] exceeds chunk budget ` +
          `(~${convTokens} tokens > ${maxTokens} budget). Split into ${subConvs.length} message group(s).`,
      );

      for (const sub of subConvs) {
        const subTokens = estimateConversationTokens([sub]);
        if (currentTokens + subTokens > maxTokens && currentChunk.length > 0) {
          chunks.push(currentChunk);
          currentChunk = [];
          currentTokens = 0;
        }
        currentChunk.push(sub);
        currentTokens += subTokens;
      }
      continue;
    }

    if (currentTokens + convTokens > maxTokens) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(conv);
    currentTokens += convTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Build the summarizer user prompt for a set of conversations.
 */
function buildSummarizerPrompt(
  conversations: ConversationForSummary[],
  platformActivity?: string,
  platformChatId?: string,
  memoryInstructions?: string,
  customInstructions?: string,
): string {
  let prompt = withInstanceId(DAILY_SUMMARY_PROMPT).replace(
    "{{CONVERSATIONS}}",
    conversations.length > 0
      ? formatConversationsForPrompt(conversations)
      : "(No direct conversations today)",
  );

  if (platformActivity) {
    let platformSection =
      `\nActivity on other platforms [chat:${platformChatId}]:\n` +
      platformActivity;
    if (memoryInstructions) {
      platformSection +=
        `\n\nWhen writing about these interactions, use these mappings:\n${memoryInstructions}`;
    }
    prompt = prompt.replace("{{PLATFORM_ACTIVITY}}", platformSection);
  } else {
    prompt = prompt.replace("{{PLATFORM_ACTIVITY}}", "");
  }

  prompt = prompt.replace(
    "{{CUSTOM_INSTRUCTIONS}}",
    customInstructions
      ? `\nMy additional memory-writing instructions:\n${customInstructions}\n`
      : "",
  );

  return prompt;
}

/**
 * Stream an LLM response and extract bullet points.
 */
async function streamBulletPoints(
  llm: LLMClient,
  identitySystemMessage: string,
  prompt: string,
): Promise<string[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: identitySystemMessage },
    { role: "user", content: prompt },
  ];

  let fullResponse = "";
  try {
    for await (const part of llm.chatStream(messages)) {
      if (part.type === "content") {
        fullResponse += part.content;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate summary: ${errorMessage}`);
  }

  const bulletPoints: string[] = [];
  for (const line of fullResponse.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletPoints.push(trimmed.substring(2));
    }
  }

  return bulletPoints;
}

/**
 * Collect conversations for summarization from a specific date.
 */
function collectConversationsForDate(
  db: DBClient,
  date: Date,
  modifier?: string,
): ConversationForSummary[] {
  const messages = db.getMessagesByDate(date, modifier);

  // Group by conversation ID
  const conversationMap = new Map<string, MessageWithContext[]>();
  for (const msg of messages) {
    const existing = conversationMap.get(msg.conversationId) || [];
    existing.push({
      id: msg.id,
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      createdAt: msg.createdAt,
    });
    conversationMap.set(msg.conversationId, existing);
  }

  // Build conversation objects with titles, excluding non-chat sources
  const EXCLUDED_SOURCE_TYPES = ["discord", "import"];
  const conversations: ConversationForSummary[] = [];
  for (const [convId, msgs] of conversationMap) {
    const conv = db.getConversation(convId);
    if (conv?.sourceType && EXCLUDED_SOURCE_TYPES.includes(conv.sourceType)) {
      continue;
    }
    conversations.push({
      id: convId,
      title: conv?.title,
      messages: msgs,
    });
  }

  return conversations;
}

/**
 * Generate a daily memory summary using the main LLM.
 * When contextLength is provided, conversations are split into chunks
 * that fit within the token budget so no memories are lost to overflow.
 */
async function generateDailySummary(
  conversations: ConversationForSummary[],
  llm: LLMClient,
  dataRoot: string,
  platformActivity?: string,
  platformChatId?: string,
  memoryInstructions?: string,
  customInstructions?: string,
  contextLength?: number,
): Promise<string[]> {
  if (conversations.length === 0 && !platformActivity) {
    return [];
  }

  const identitySystemMessage = await buildIdentitySystemMessage(dataRoot);

  // Estimate overhead tokens (everything except conversation content)
  const identityTokens = Math.ceil(
    identitySystemMessage.length / CHARS_PER_TOKEN,
  );
  const templateTokens = Math.ceil(
    withInstanceId(DAILY_SUMMARY_PROMPT).length / CHARS_PER_TOKEN,
  );
  const platformTokens = platformActivity
    ? Math.ceil(
      (
        `\nActivity on other platforms [chat:${platformChatId}]:\n` +
        platformActivity +
        (memoryInstructions
          ? `\n\nWhen writing about these interactions, use these mappings:\n${memoryInstructions}`
          : "")
      ).length / CHARS_PER_TOKEN,
    )
    : 0;
  const instructionsTokens = customInstructions
    ? Math.ceil(
      `\nMy additional memory-writing instructions:\n${customInstructions}\n`
        .length /
        CHARS_PER_TOKEN,
    )
    : 0;

  const outputBudget = 500;
  const safetyMargin = 500;

  const conversationBudget = contextLength
    ? Math.max(
      contextLength - identityTokens - templateTokens - platformTokens -
        instructionsTokens - outputBudget - safetyMargin,
      1000,
    )
    : Infinity;

  const totalConversationTokens = estimateConversationTokens(conversations);
  const needsChunking = totalConversationTokens > conversationBudget;

  if (!needsChunking) {
    const prompt = buildSummarizerPrompt(
      conversations,
      platformActivity,
      platformChatId,
      memoryInstructions,
      customInstructions,
    );
    return streamBulletPoints(llm, identitySystemMessage, prompt);
  }

  // Split conversations into chunks that fit the budget
  const chunks = chunkConversations(conversations, conversationBudget);
  console.log(
    `[Memory] Conversation content (~${totalConversationTokens} tokens) exceeds ` +
      `budget (${conversationBudget} tokens). Splitting into ${chunks.length} chunk(s).`,
  );

  const allBulletPoints: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkTokens = estimateConversationTokens(chunk);
    console.log(
      `[Memory] Summarizing chunk ${i + 1}/${chunks.length} ` +
        `(${chunk.length} conversation(s), ~${chunkTokens} tokens)`,
    );

    const prompt = buildSummarizerPrompt(
      chunk,
      platformActivity,
      platformChatId,
      memoryInstructions,
      customInstructions,
    );

    try {
      const bulletPoints = await streamBulletPoints(
        llm,
        identitySystemMessage,
        prompt,
      );
      allBulletPoints.push(...bulletPoints);
    } catch (error) {
      console.error(
        `[Memory] Chunk ${i + 1}/${chunks.length} failed: ${
          error instanceof Error ? error.message : String(error)
        }. Continuing with remaining chunks.`,
      );
    }
  }

  return allBulletPoints;
}

/**
 * Summarize conversations from a specific date.
 *
 * @param date - The date to summarize
 * @param db - Database client
 * @param dataRoot - Root directory of the project
 * @param config - Optional configuration overrides
 * @returns The created memory file, or null if summarization failed or was skipped
 */
export async function summarizeDay(
  date: Date,
  db: DBClient,
  mcpClient: MCPClient,
  dataRoot: string,
  config?: Partial<SummarizerConfig>,
  options?: { llm?: LLMClient; activeProfile?: LLMConnectionProfile },
): Promise<MemoryFile | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    console.log("[Memory] Summarization disabled, skipping");
    return null;
  }

  const dateStr = date.toISOString().split("T")[0];

  // Compute timezone modifier for logical date grouping
  const modifier = cfg.timezone
    ? getTimezoneModifier(cfg.timezone, cfg.cutoffHour)
    : undefined;

  // Check if we've already created a memory summary for this date (more reliable than chat-level check)
  const existingSummary = db.getMemorySummary(dateStr, "daily");
  if (existingSummary) {
    console.log(
      `[Memory] Date ${dateStr} already has a summary record, skipping`,
    );
    return null;
  }

  // Also check if all chats are already marked as summarized (secondary check for consistency)
  const existingChatIds = db.getConversationIdsByDate(dateStr, modifier);
  const allSummarized = existingChatIds.every((chatId) =>
    db.isChatSummarized(chatId, dateStr)
  );

  if (allSummarized && existingChatIds.length > 0) {
    console.log(
      `[Memory] Date ${dateStr} already summarized (via chat check), skipping`,
    );
    return null;
  }

  // Collect web conversations (Discord is excluded by collectConversationsForDate)
  const conversations = collectConversationsForDate(db, date, modifier);

  // Load custom daily memory-writing instructions
  let customInstructions = "";
  try {
    const memSettings = await loadMemorySettings(dataRoot);
    customInstructions = memSettings.dailyInstructions;
  } catch {
    // Non-critical — proceed without custom instructions
  }

  // Check for Discord activity to include via pre-summarizer
  let platformActivity = "";
  let discordMemoryInstructions = "";
  let discordSyntheticChatId = "";
  let discordConversationIds: string[] = [];
  try {
    const gatewayConfig = await loadDiscordGatewayConfig(dataRoot);
    if (
      gatewayConfig.includeInDailyMemories && gatewayConfig.servers.length > 0
    ) {
      const llm = options?.llm ??
        (options?.activeProfile
          ? createClientFromProfile(options.activeProfile, { useWorker: true })
          : createWorkerClient());
      const result = await summarizeDiscordActivity(
        date,
        db,
        llm,
        dataRoot,
        {
          timezone: cfg.timezone,
          cutoffHour: cfg.cutoffHour,
          instructions: gatewayConfig.memoryInstructions || undefined,
        },
      );
      platformActivity = result.summary;
      discordSyntheticChatId = result.syntheticChatId;
      discordConversationIds = result.conversationIds;
      discordMemoryInstructions = gatewayConfig.memoryInstructions || "";
      if (platformActivity) {
        console.log(
          `[Memory] Discord activity summary generated for ${dateStr} [chat:${discordSyntheticChatId}]`,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[Memory] Discord pre-summary failed, continuing without it:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (conversations.length === 0 && !platformActivity) {
    console.log(`[Memory] No conversations on ${dateStr}, skipping`);
    return null;
  }

  console.log(
    `[Memory] Summarizing ${conversations.length} conversation(s) from ${dateStr}${
      platformActivity ? " + Discord activity" : ""
    }`,
  );

  // Use worker model from active profile (same endpoint and API key, lighter model)
  const llm = options?.llm ??
    (options?.activeProfile
      ? createClientFromProfile(options.activeProfile, { useWorker: true })
      : createWorkerClient());

  try {
    // Generate summary (with optional platform activity)
    const bulletPoints = await generateDailySummary(
      conversations,
      llm,
      dataRoot,
      platformActivity || undefined,
      discordSyntheticChatId || undefined,
      discordMemoryInstructions || undefined,
      customInstructions || undefined,
      options?.activeProfile?.contextLength,
    );

    if (bulletPoints.length === 0) {
      console.log(`[Memory] No memories generated for ${dateStr}`);
      return null;
    }

    // Format the memory file
    const dateInfo = getDateFormatInfo(date, "daily", getInstanceId());
    const content = formatMemoryContent(dateInfo.title, bulletPoints);

    // Extract chat IDs from the content
    const chatIds = extractChatIds(content);

    // Include real Discord conversation IDs for summarized_chats tracking
    const allTrackedIds = [...chatIds];
    if (discordConversationIds.length > 0) {
      allTrackedIds.push(...discordConversationIds);
    }

    // If no chat IDs were extracted, use all conversation IDs
    const finalChatIds = chatIds.length > 0
      ? chatIds
      : conversations.map((c) => c.id);

    // Write to entity-core via MCP first — only record in DB if it succeeds
    const success = await mcpClient.createMemory(
      "daily",
      dateInfo.dateStr,
      content,
      finalChatIds,
    );

    if (!success) {
      console.error(
        `[Memory] MCP write failed for ${dateInfo.dateStr} — will retry on next catch-up`,
      );
      return null;
    }

    // Record in database for local tracking (which chats have been summarized)
    const summaryId = db.upsertMemorySummary(
      dateInfo.dateStr,
      "daily",
      `entity-core://${dateInfo.dateStr}`,
      finalChatIds,
    );
    // Mark web conversations as summarized
    for (const chatId of finalChatIds) {
      db.markChatSummarized(chatId, dateInfo.dateStr, summaryId);
    }
    // Mark real Discord conversations as summarized (prevents re-processing)
    for (const discordId of discordConversationIds) {
      db.markChatSummarized(discordId, dateInfo.dateStr, summaryId);
    }

    const memoryFile: MemoryFile = {
      path: dateInfo.filePath,
      content,
      chatIds: finalChatIds,
      granularity: "daily",
      date: dateInfo.dateStr,
    };

    return memoryFile;
  } finally {
    // Client doesn't need explicit cleanup
  }
}
