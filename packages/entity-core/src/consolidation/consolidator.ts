/**
 * Memory Consolidator
 *
 * Core consolidation logic for merging daily→weekly→monthly→yearly memories.
 * Uses entity-core's FileStore for reads/writes and LLM client for summarization.
 */

import type { FileStore } from "../storage/file-store.ts";
import type { GraphStore } from "../graph/store.ts";
import type { Granularity } from "../types.ts";
import { createLLMClient } from "../llm/mod.ts";
import { EmbeddingCache } from "../embeddings/cache.ts";
import { getEmbedder } from "../embeddings/mod.ts";
import { extractMemoryToGraph } from "../graph/memory-integration.ts";
import {
  filterFilesForPeriod,
  getConsolidationDateInfo,
  getISOWeek,
  getPreviousPeriodStart,
  parseTargetDate,
} from "./periods.ts";
import {
  MONTHLY_CONSOLIDATION_PROMPT,
  WEEKLY_CONSOLIDATION_PROMPT,
  YEARLY_CONSOLIDATION_PROMPT,
} from "./prompts.ts";

/**
 * Result of a consolidation operation.
 */
export interface ConsolidationResult {
  success: boolean;
  granularity: "weekly" | "monthly" | "yearly";
  dateStr: string;
  error?: string;
}

/**
 * Format source memories for a consolidation prompt.
 * Strips headers/comments and groups by source period.
 */
function formatSourceMemories(
  memories: Array<{ date: string; content: string }>,
  sectionLabel: string,
): string {
  return memories.map((m, i) => {
    const lines = m.content.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("<!--");
    });
    return `### ${sectionLabel} ${i + 1} (${m.date})\n${lines.join("\n")}`;
  }).join("\n\n");
}

/**
 * Build a system message from the entity's identity files.
 */
async function buildIdentitySystemMessage(store: FileStore): Promise<string> {
  const identity = await store.readAllIdentity();
  const parts: string[] = [];

  const categories = [
    identity.self,
    identity.user,
    identity.relationship,
    identity.custom,
  ];
  for (const files of categories) {
    for (const file of files) {
      parts.push(`## ${file.filename}\n${file.content}`);
    }
  }

  return parts.length > 0
    ? `This is who I am:\n\n${parts.join("\n\n")}`
    : "I am an AI entity writing my own memories in first-person.";
}

/**
 * Parse bullet points from LLM response text.
 */
function parseBulletPoints(response: string): string[] {
  const bulletPoints: string[] = [];
  for (const line of response.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletPoints.push(trimmed.substring(2));
    }
  }
  return bulletPoints;
}

/**
 * Format memory file content with title and bullet points.
 */
function formatMemoryContent(title: string, bulletPoints: string[]): string {
  const bulletList = bulletPoints.map((point) => `- ${point}`).join("\n");
  return `# ${title}\n\n${bulletList}\n`;
}

/**
 * Extract source memories for a consolidation granularity.
 * Returns an array of { date, content } for all source files.
 */
async function collectSourceMemories(
  store: FileStore,
  sourceGranularity: Granularity,
): Promise<Array<{ date: string; content: string }>> {
  const memories = await store.listMemories(sourceGranularity);
  return memories.map((m) => ({ date: m.date, content: m.content }));
}

/**
 * Get the prompt template for a granularity.
 */
function getPromptTemplate(
  granularity: "weekly" | "monthly" | "yearly",
): string {
  switch (granularity) {
    case "weekly":
      return WEEKLY_CONSOLIDATION_PROMPT;
    case "monthly":
      return MONTHLY_CONSOLIDATION_PROMPT;
    case "yearly":
      return YEARLY_CONSOLIDATION_PROMPT;
  }
}

/**
 * Get the source granularity for a target consolidation granularity.
 */
function getSourceGranularity(
  granularity: "weekly" | "monthly" | "yearly",
): Granularity {
  switch (granularity) {
    case "weekly":
      return "daily";
    case "monthly":
      return "weekly";
    case "yearly":
      return "monthly";
  }
}

/**
 * Get the section label for formatting source memories.
 */
function getSectionLabel(granularity: "weekly" | "monthly" | "yearly"): string {
  switch (granularity) {
    case "weekly":
      return "Day";
    case "monthly":
      return "Week";
    case "yearly":
      return "Month";
  }
}

/**
 * Check if a consolidated file already exists for a given period.
 */
async function consolidatedFileExists(
  store: FileStore,
  granularity: "weekly" | "monthly" | "yearly",
  dateStr: string,
): Promise<boolean> {
  const existing = await store.readMemory(granularity, dateStr);
  return existing !== null;
}

/**
 * Run consolidation for a specific period.
 */
export async function consolidate(
  store: FileStore,
  graphStore: GraphStore,
  granularity: "weekly" | "monthly" | "yearly",
  targetDate: Date,
): Promise<ConsolidationResult> {
  const llm = createLLMClient();
  if (!llm) {
    return {
      success: false,
      granularity,
      dateStr: "",
      error:
        "No LLM API key configured (ENTITY_CORE_LLM_API_KEY or ZAI_API_KEY)",
    };
  }

  const dateInfo = getConsolidationDateInfo(granularity, targetDate);

  // Check if already consolidated
  if (await consolidatedFileExists(store, granularity, dateInfo.dateStr)) {
    return {
      success: false,
      granularity,
      dateStr: dateInfo.dateStr,
      error: "Already consolidated",
    };
  }

  // Collect source memories
  const sourceGranularity = getSourceGranularity(granularity);
  const allSource = await collectSourceMemories(store, sourceGranularity);

  // Filter to files in this period
  const periodSources = filterFilesForPeriod(
    allSource,
    granularity,
    targetDate,
  );

  if (periodSources.length === 0) {
    return {
      success: false,
      granularity,
      dateStr: dateInfo.dateStr,
      error: `No ${sourceGranularity} source files found for this period`,
    };
  }

  // Build the prompt
  const sectionLabel = getSectionLabel(granularity);
  const memoriesText = formatSourceMemories(periodSources, sectionLabel);
  const template = getPromptTemplate(granularity);
  const prompt = template.replace("{{SOURCE_MEMORIES}}", memoriesText);

  // Build identity context
  const systemMessage = await buildIdentitySystemMessage(store);

  // Call LLM
  let response: string;
  try {
    response = await llm.complete(prompt, { systemPrompt: systemMessage });
  } catch (error) {
    return {
      success: false,
      granularity,
      dateStr: dateInfo.dateStr,
      error: `LLM call failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Parse bullet points
  const bulletPoints = parseBulletPoints(response);
  if (bulletPoints.length === 0) {
    return {
      success: false,
      granularity,
      dateStr: dateInfo.dateStr,
      error: "LLM returned no bullet points",
    };
  }

  // Write the consolidated memory
  const content = formatMemoryContent(dateInfo.title, bulletPoints);
  await store.writeMemory({
    id: `${granularity}-${dateInfo.dateStr}`,
    granularity,
    date: dateInfo.dateStr,
    content,
    chatIds: [],
    sourceInstance: "entity-core",
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  console.error(
    `[Consolidation] Created ${granularity} memory: ${dateInfo.dateStr}`,
  );

  // Cache embedding for RAG search (fire-and-forget)
  const cacheEmbedding = async () => {
    try {
      const cache = new EmbeddingCache(store.dataDirectory);
      await cache.initialize();
      await cache.getOrCompute(
        { granularity, date: dateInfo.dateStr, content },
        getEmbedder(),
      );
      console.error(
        `[Consolidation] Cached embedding for ${granularity}-${dateInfo.dateStr}`,
      );
    } catch (error) {
      console.error(
        `[Consolidation] Embedding cache failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  };
  cacheEmbedding();

  // Extract to graph (fire-and-forget)
  extractMemoryToGraph(
    {
      id: `${granularity}-${dateInfo.dateStr}`,
      granularity,
      date: dateInfo.dateStr,
      content,
      chatIds: [],
      sourceInstance: "entity-core",
      participatingInstances: [],
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    graphStore,
    "entity-core",
  )
    .then((extraction) => {
      if (extraction.nodesCreated > 0 || extraction.edgesCreated > 0) {
        console.error(
          `[Consolidation] Extracted from ${granularity}-${dateInfo.dateStr}: ${extraction.nodesCreated} nodes, ${extraction.edgesCreated} edges`,
        );
      }
    })
    .catch((error) => {
      console.error(
        `[Consolidation] Graph extraction failed:`,
        error instanceof Error ? error.message : error,
      );
    });

  return { success: true, granularity, dateStr: dateInfo.dateStr };
}

/**
 * Find all periods that need consolidation for a given granularity.
 * Looks for source files where no corresponding consolidated file exists.
 */
export async function findUnconsolidatedPeriods(
  store: FileStore,
  granularity: "weekly" | "monthly" | "yearly",
): Promise<string[]> {
  const sourceGranularity = getSourceGranularity(granularity);
  const allSource = await collectSourceMemories(store, sourceGranularity);
  if (allSource.length === 0) return [];

  const unconsolidated = new Set<string>();

  for (const source of allSource) {
    let sourceDate: Date;

    // Weekly dates use YYYY-WNN format which new Date() can't parse
    if (sourceGranularity === "weekly") {
      const parsed = parseTargetDate("weekly", source.date);
      if (!parsed) continue;
      sourceDate = parsed;
    } else {
      sourceDate = new Date(source.date);
      if (isNaN(sourceDate.getTime())) continue;
    }

    let targetDateStr: string;

    switch (granularity) {
      case "weekly": {
        const iso = getISOWeek(sourceDate);
        targetDateStr = `${iso.year}-W${String(iso.week).padStart(2, "0")}`;
        break;
      }
      case "monthly": {
        const month = String(sourceDate.getUTCMonth() + 1).padStart(2, "0");
        targetDateStr = `${sourceDate.getUTCFullYear()}-${month}`;
        break;
      }
      case "yearly":
        targetDateStr = String(sourceDate.getUTCFullYear());
        break;
    }

    // Check if consolidated file exists
    if (!(await consolidatedFileExists(store, granularity, targetDateStr))) {
      unconsolidated.add(targetDateStr);
    }
  }

  // Filter to only past periods (not the current one)
  const now = new Date();
  const previousPeriodStart = getPreviousPeriodStart(granularity, now);
  const result: string[] = [];

  for (const dateStr of unconsolidated) {
    const targetDate = parseTargetDate(granularity, dateStr);
    if (targetDate && targetDate <= previousPeriodStart) {
      result.push(dateStr);
    }
  }

  return result;
}

/**
 * Run consolidation for all unconsolidated periods across all granularities.
 */
export async function runAllConsolidations(
  store: FileStore,
  graphStore: GraphStore,
): Promise<ConsolidationResult[]> {
  const results: ConsolidationResult[] = [];

  for (const granularity of ["weekly", "monthly", "yearly"] as const) {
    const periods = await findUnconsolidatedPeriods(store, granularity);

    for (const dateStr of periods) {
      const targetDate = parseTargetDate(granularity, dateStr);
      if (!targetDate) continue;

      console.error(`[Consolidation] Processing ${granularity}: ${dateStr}`);
      const result = await consolidate(
        store,
        graphStore,
        granularity,
        targetDate,
      );
      results.push(result);
    }
  }

  return results;
}

/**
 * Run consolidation for a specific granularity and optionally a specific period.
 * If targetDateStr is not provided, consolidates the previous period.
 */
export async function runConsolidation(
  store: FileStore,
  graphStore: GraphStore,
  granularity: "weekly" | "monthly" | "yearly",
  targetDateStr?: string,
): Promise<ConsolidationResult> {
  let targetDate: Date;

  if (targetDateStr) {
    const parsed = parseTargetDate(granularity, targetDateStr);
    if (!parsed) {
      return {
        success: false,
        granularity,
        dateStr: targetDateStr,
        error: `Invalid date string for ${granularity}: ${targetDateStr}`,
      };
    }
    targetDate = parsed;
  } else {
    targetDate = getPreviousPeriodStart(granularity, new Date());
  }

  return await consolidate(store, graphStore, granularity, targetDate);
}
