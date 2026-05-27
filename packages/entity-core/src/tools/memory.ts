/**
 * Memory Tools
 *
 * MCP tools for creating and searching my memories.
 * All tools operate from my first-person perspective.
 */

import { z } from "zod";
import type { FileStore } from "../storage/mod.ts";
import type { GraphStore } from "../graph/mod.ts";
import type { Granularity, MemoryEntry } from "../types.ts";
import { getEmbedder } from "../embeddings/mod.ts";
import type { EmbeddingCache } from "../embeddings/mod.ts";
import { computeMemoryKey } from "../embeddings/mod.ts";
import { chunkContent, shouldChunk } from "../embeddings/chunker.ts";

/**
 * Schema for memory granularity.
 */
const GranularitySchema = z.enum([
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "significant",
]);

/**
 * Input schema for memory/create tool.
 */
export const MemoryCreateSchema = z.object({
  granularity: GranularitySchema,
  date: z.string().regex(/^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/),
  content: z.string().min(1),
  chatIds: z.array(z.string()).optional().default([]),
  instanceId: z.string().min(1),
  participatingInstances: z.array(z.string()).optional(),
  slug: z.string().optional(),
});

/**
 * Input schema for memory/search tool.
 */
export const MemorySearchSchema = z.object({
  query: z.string().min(1),
  instanceId: z.string().min(1),
  queryEmbedding: z.array(z.number()).optional(),
  minScore: z.number().min(0).max(1).optional(),
  maxResults: z.number().min(1).max(50).optional(),
});

/**
 * Input schema for memory/list tool.
 */
export const MemoryListSchema = z.object({
  granularity: GranularitySchema.optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
  beforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  afterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Input schema for memory/read tool.
 */
export const MemoryReadSchema = z.object({
  granularity: GranularitySchema,
  date: z.string().regex(/^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/),
});

/**
 * Input schema for memory/update tool.
 */
export const MemoryUpdateSchema = z.object({
  granularity: GranularitySchema,
  date: z.string().regex(/^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/),
  content: z.string().min(1),
  editedBy: z.string().optional(),
  instanceId: z.string().optional(),
  slug: z.string().optional(),
});

/**
 * Output type for memory/read tool.
 */
export interface MemoryReadOutput {
  success: boolean;
  memory?: MemoryEntry;
  message?: string;
}

/**
 * Output type for memory/update tool.
 */
export interface MemoryUpdateOutput {
  success: boolean;
  message: string;
  memoryId?: string;
}

/**
 * Input schema for memory/delete tool.
 */
export const MemoryDeleteSchema = z.object({
  granularity: GranularitySchema,
  date: z.string().min(1),
  instanceId: z.string().optional(),
  slug: z.string().optional(),
});

export interface MemoryDeleteOutput {
  success: boolean;
  message: string;
}

/**
 * Output type for memory/create tool.
 */
export interface MemoryCreateOutput {
  success: boolean;
  message: string;
  memoryId?: string;
}

/**
 * Output type for memory/search tool.
 */
export interface MemorySearchOutput {
  results: Array<{
    granularity: string;
    date: string;
    score: number;
    excerpt: string;
    sourceInstance: string;
    tier: string;
    ageDays: number;
    vectorScore: number;
    method: "vector" | "text";
  }>;
  searchMethod: "vector" | "text";
  vectorAvailable: boolean;
}

/**
 * Output type for memory/list tool.
 */
export interface MemoryListOutput {
  memories: Array<{
    granularity: string;
    date: string;
    preview: string;
    sourceInstance?: string;
  }>;
  total: number;
}

/**
 * Create the memory/create tool handler.
 */
export function createMemoryCreateHandler(
  store: FileStore,
  cache?: EmbeddingCache,
) {
  return async (
    input: z.infer<typeof MemoryCreateSchema>,
  ): Promise<MemoryCreateOutput> => {
    const {
      granularity,
      date,
      content,
      chatIds,
      instanceId,
      participatingInstances,
      slug,
    } = input;

    const memory: MemoryEntry = {
      id: `${granularity}-${date}`,
      granularity: granularity as Granularity,
      date,
      content,
      chatIds,
      sourceInstance: instanceId,
      participatingInstances: participatingInstances ?? [instanceId],
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      slug: slug,
    };

    // For daily memories, merge with existing content to prevent overwriting
    // when importing from multiple sources (e.g., entity-loom runs at different
    // times). Bullets are deduplicated by [chat:id] tag.
    if (granularity === "daily") {
      memory.content = await store.createOrMergeDailyMemory(memory);
    } else {
      await store.writeMemory(memory);
    }

    // Eagerly cache embedding (fire-and-forget, same pattern as graph extraction)
    if (cache) {
      cache.getOrCompute(memory, getEmbedder())
        .then(() =>
          console.error(`[EmbeddingCache] Cached embedding for ${memory.id}`)
        )
        .catch((err) =>
          console.error(`[EmbeddingCache] Failed to cache ${memory.id}:`, err)
        );
    }

    return {
      success: true,
      message: `I have recorded a ${granularity} memory for ${date}.`,
      memoryId: memory.id,
    };
  };
}

/**
 * Create the memory/search tool handler.
 *
 * Uses multi-signal ranking:
 *   finalScore = (vectorScore × 0.6) + (recencyScore × 0.15) + (graphBoost × 0.15) + (instanceBoost × 0.1)
 *
 * Falls back to text matching if vector search is unavailable.
 */
export function createMemorySearchHandler(
  store: FileStore,
  graphStore: GraphStore,
  cache: EmbeddingCache | undefined,
  config: {
    instanceBoost?: number;
    minScore?: number;
    maxResults?: number;
  } = {},
) {
  const { instanceBoost = 0.1, minScore = 0.3, maxResults = 10 } = config;

  // Scoring weights
  const VECTOR_WEIGHT = 0.8;
  const RECENCY_WEIGHT = 0.05;
  const GRAPH_WEIGHT = 0.05;
  const INSTANCE_WEIGHT = 0.1;
  // Recency decay rate: half-life ~100 days
  const RECENCY_DECAY_RATE = 0.007;

  return async (
    input: z.infer<typeof MemorySearchSchema>,
  ): Promise<MemorySearchOutput> => {
    const { query, instanceId } = input;
    const maxResultsActual = input.maxResults ?? maxResults;
    const minScoreActual = input.minScore ?? minScore;

    const embedder = getEmbedder();

    // Split query into sentences and embed each separately.
    // This handles natural conversation where the actual topic/question
    // is buried in a longer message alongside pleasantries and context.
    // Each sentence becomes its own KNN query; results are merged.
    const sentences = splitIntoSentences(query);
    const queryEmbeddings: number[][] = [];

    if (input.queryEmbedding) {
      queryEmbeddings.push(input.queryEmbedding);
    } else {
      for (const sentence of sentences) {
        const emb = await embedder.embed(sentence);
        if (emb) queryEmbeddings.push(emb);
      }
    }

    if (queryEmbeddings.length > 0) {
      return await vectorSearch(
        queryEmbeddings,
        query,
        instanceId,
        store,
        graphStore,
        cache,
        maxResultsActual,
        minScoreActual,
        {
          VECTOR_WEIGHT,
          RECENCY_WEIGHT,
          GRAPH_WEIGHT,
          INSTANCE_WEIGHT,
          RECENCY_DECAY_RATE,
          instanceBoost,
        },
      );
    }

    // Fall back to text matching
    return textSearch(
      query,
      instanceId,
      store,
      maxResultsActual,
      minScoreActual,
      instanceBoost,
    );
  };
}

/**
 * Split text into sentences for per-sentence embedding.
 * Simple split on sentence-ending punctuation. Caps at MAX_SENTENCES
 * to avoid excessive embedding work on very long messages.
 */
const MAX_SENTENCES = 5;

function splitIntoSentences(text: string): string[] {
  // Split on .!? followed by whitespace or end of string
  const parts = text.split(/(?<=[.!?])\s+/);
  if (parts.length <= 1) return [text];

  // Deduplicate by keeping only sentences that add meaningful content
  // (skip very short fragments like "ok" or "hmm")
  const meaningful = parts.filter((s) => s.trim().length > 5);
  return meaningful.slice(0, MAX_SENTENCES);
}

/**
 * Compute recency score based on memory age.
 * Uses inverse decay: recencyScore = 1 / (1 + age_days × decay_rate)
 * Half-life ~69 days with default decay_rate of 0.01.
 */
function computeRecencyScore(memoryDate: string, decayRate: number): number {
  try {
    const memoryTime = new Date(memoryDate).getTime();
    const now = Date.now();
    const ageDays = Math.max(0, (now - memoryTime) / (1000 * 60 * 60 * 24));
    return 1 / (1 + ageDays * decayRate);
  } catch {
    return 0.5; // Neutral score if date can't be parsed
  }
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Vector-based memory search with multi-signal ranking.
 *
 * Accepts multiple query embeddings (one per sentence) for robust retrieval
 * in natural conversation. Each embedding produces KNN candidates; results
 * are merged (deduplicated, keeping best score per memory).
 */
async function vectorSearch(
  queryEmbeddings: number[][],
  query: string,
  instanceId: string,
  store: FileStore,
  graphStore: GraphStore,
  cache: EmbeddingCache | undefined,
  maxResults: number,
  minScore: number,
  weights: {
    VECTOR_WEIGHT: number;
    RECENCY_WEIGHT: number;
    GRAPH_WEIGHT: number;
    INSTANCE_WEIGHT: number;
    RECENCY_DECAY_RATE: number;
    instanceBoost: number;
  },
): Promise<MemorySearchOutput> {
  const results: MemorySearchOutput["results"] = [];

  // Step 1: Search graph for entity nodes related to the query (for graph boost signal)
  // Use first embedding for graph search (entity names are typically short phrases)
  const entityResults = graphStore.searchNodes({
    queryEmbedding: queryEmbeddings[0],
    minScore: 0.3,
    limit: 20,
  });
  const relevantEntityLabels = new Set<string>();
  for (const er of entityResults) {
    relevantEntityLabels.add(er.node.label.toLowerCase());
  }

  const embedder = getEmbedder();
  const granularities: Granularity[] = [
    "daily",
    "weekly",
    "monthly",
    "yearly",
    "significant",
  ];

  const scored: Array<{
    memoryId: string;
    granularity: string;
    date: string;
    sourceInstance: string;
    content: string;
    vectorScore: number;
    recencyScore: number;
    graphBoost: number;
    instanceScore: number;
    finalScore: number;
    chunkIndex: number;
  }> = [];

  if (cache && cache.isAvailable() && cache.getStats().totalCached > 0) {
    // FAST PATH: KNN search on cached embeddings
    // Run KNN for each query embedding (per-sentence) and merge results
    const knnCount = Math.max(maxResults * 20, 200);
    const mergedCandidates = new Map<
      string,
      { memoryKey: string; score: number; chunkIndex: number }
    >();

    for (const queryEmbedding of queryEmbeddings) {
      const candidates = cache.search(queryEmbedding, knnCount);
      for (const candidate of candidates) {
        const existing = mergedCandidates.get(candidate.memoryKey);
        if (!existing || candidate.score > existing.score) {
          mergedCandidates.set(candidate.memoryKey, {
            memoryKey: candidate.memoryKey,
            score: candidate.score,
            chunkIndex: candidate.chunkIndex,
          });
        }
      }
    }

    const candidates = Array.from(mergedCandidates.values())
      .sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
      if (results.length >= maxResults && candidate.score < minScore) break;

      const memory = await store.readMemoryByKey(candidate.memoryKey);
      if (!memory) continue;

      const vectorScore = candidate.score;

      // Skip if vector score is too low (early filter)
      if (vectorScore < minScore * 0.5) continue;

      const recencyScore = computeRecencyScore(
        memory.date,
        weights.RECENCY_DECAY_RATE,
      );

      // Graph boost
      let graphBoost = 0;
      if (relevantEntityLabels.size > 0) {
        const lowerContent = memory.content.toLowerCase();
        let matchCount = 0;
        for (const label of relevantEntityLabels) {
          if (lowerContent.includes(label)) {
            matchCount++;
          }
        }
        if (matchCount > 0) {
          graphBoost = Math.min(1, matchCount / Math.log(matchCount + 2));
        }
      }

      const instanceScore = memory.sourceInstance === instanceId
        ? weights.instanceBoost
        : 0;

      const finalScore = (vectorScore * weights.VECTOR_WEIGHT) +
        (recencyScore * weights.RECENCY_WEIGHT) +
        (graphBoost * weights.GRAPH_WEIGHT) +
        (instanceScore * weights.INSTANCE_WEIGHT);

      scored.push({
        memoryId: memory.id,
        granularity: memory.granularity,
        date: memory.date,
        sourceInstance: memory.sourceInstance,
        content: memory.content,
        vectorScore,
        recencyScore,
        graphBoost,
        instanceScore,
        finalScore,
        chunkIndex: candidate.chunkIndex,
      });
    }
  } else {
    // FALLBACK: Embed all memories, chunking long ones
    for (const granularity of granularities) {
      const memories = await store.listMemories(granularity);

      for (const memory of memories) {
        let bestVectorScore = 0;
        let bestChunkIndex = 0;
        const fullContent = memory.content.toLowerCase();

        // Try cache first, compute and cache on miss
        if (cache) {
          const cached = await cache.getOrCompute(memory, embedder);
          const memoryEmbedding = cached?.embedding ?? null;
          if (memoryEmbedding) {
            bestVectorScore = Math.max(
              ...queryEmbeddings.map((qe) =>
                cosineSimilarity(qe, memoryEmbedding)
              ),
            );
          }
        } else if (!shouldChunk(memory.content)) {
          // Short memory: embed directly
          const memoryEmbedding = await embedder.embed(
            memory.content.substring(0, 3000),
          );
          if (memoryEmbedding) {
            bestVectorScore = Math.max(
              ...queryEmbeddings.map((qe) =>
                cosineSimilarity(qe, memoryEmbedding)
              ),
            );
          }
        } else {
          // Long memory without cache: chunk and embed each
          const chunks = chunkContent(memory.content);
          for (const chunk of chunks) {
            const emb = await embedder.embed(chunk.content);
            if (!emb) continue;
            const score = Math.max(
              ...queryEmbeddings.map((qe) => cosineSimilarity(qe, emb)),
            );
            if (score > bestVectorScore) {
              bestVectorScore = score;
              bestChunkIndex = chunk.index;
            }
          }
        }

        if (bestVectorScore < minScore * 0.5) continue;

        const recencyScore = computeRecencyScore(
          memory.date,
          weights.RECENCY_DECAY_RATE,
        );

        let graphBoost = 0;
        if (relevantEntityLabels.size > 0) {
          let matchCount = 0;
          for (const label of relevantEntityLabels) {
            if (fullContent.includes(label)) {
              matchCount++;
            }
          }
          if (matchCount > 0) {
            graphBoost = Math.min(1, matchCount / Math.log(matchCount + 2));
          }
        }

        const instanceScore = memory.sourceInstance === instanceId
          ? weights.instanceBoost
          : 0;

        const finalScore = (bestVectorScore * weights.VECTOR_WEIGHT) +
          (recencyScore * weights.RECENCY_WEIGHT) +
          (graphBoost * weights.GRAPH_WEIGHT) +
          (instanceScore * weights.INSTANCE_WEIGHT);

        scored.push({
          memoryId: memory.id,
          granularity: memory.granularity,
          date: memory.date,
          sourceInstance: memory.sourceInstance,
          content: memory.content,
          vectorScore: bestVectorScore,
          recencyScore,
          graphBoost,
          instanceScore,
          finalScore,
          chunkIndex: bestChunkIndex,
        });
      }
    }
  }

  // Step 3: Sort by final score
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Step 4: Build output with excerpts
  for (const item of scored) {
    if (results.length >= maxResults) break;
    if (item.finalScore < minScore) break; // Sorted, so we can stop early

    const excerpt = findBestExcerpt(item.content, query, item.chunkIndex);

    results.push({
      granularity: item.granularity,
      date: item.date,
      score: Math.round(item.finalScore * 1000) / 1000,
      excerpt,
      sourceInstance: item.sourceInstance,
      tier: item.granularity,
      ageDays: Math.max(
        0,
        Math.round(
          (Date.now() - new Date(item.date).getTime()) / (1000 * 60 * 60 * 24),
        ),
      ),
      vectorScore: Math.round(item.vectorScore * 1000) / 1000,
      method: "vector",
    });
  }

  return { results, searchMethod: "vector", vectorAvailable: true };
}

/**
 * Extract the most relevant excerpt from memory content for RAG retrieval.
 *
 * For short memories (<2000 chars), returns the full content — no truncation.
 * For longer memories with a known chunkIndex, returns the matching chunk's
 * content directly. Otherwise falls back to keyword-matching on bullet sections.
 */
function findBestExcerpt(
  content: string,
  query: string,
  chunkIndex = 0,
): string {
  const MAX_EXCERPT = 2000;

  // Short memories: return in full (most daily/weekly memories are under 2KB)
  if (content.length <= MAX_EXCERPT) {
    return content;
  }

  // If we know which chunk matched, extract that portion directly
  if (chunkIndex > 0) {
    const chunks = chunkContent(content);
    if (chunks[chunkIndex]) {
      return chunks[chunkIndex].content;
    }
  }

  // Longer memories: find the most relevant section
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) =>
    w.length > 2
  );

  // Split on bullet points (the primary content unit in memory files)
  const bullets = content.split(/(?=^- )/m).filter((s) => s.trim().length > 10);

  if (bullets.length === 0) {
    return content.slice(0, MAX_EXCERPT);
  }

  // Score each bullet by query word overlap
  let bestIdx = 0;
  let bestScore = 0;

  for (let i = 0; i < bullets.length; i++) {
    const lower = bullets[i].toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (lower.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // Build excerpt around the best bullet, including neighbors
  const excerptParts: string[] = [];

  // Include the title line (first line starting with #)
  const titleMatch = content.match(/^#.+/m);
  if (titleMatch) excerptParts.push(titleMatch[0]);

  // Include bullets before, at, and after the best match
  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(bullets.length, bestIdx + 3);

  for (let i = start; i < end; i++) {
    const part = bullets[i].trim();
    if (excerptParts.join("").length + part.length <= MAX_EXCERPT) {
      excerptParts.push(part);
    }
  }

  return excerptParts.join("\n");
}

/**
 * Text-based fallback memory search (original behavior).
 */
async function textSearch(
  query: string,
  instanceId: string,
  store: FileStore,
  maxResults: number,
  minScore: number,
  instanceBoost: number,
): Promise<MemorySearchOutput> {
  const results: MemorySearchOutput["results"] = [];
  const granularities: Granularity[] = [
    "daily",
    "weekly",
    "monthly",
    "yearly",
    "significant",
  ];

  for (const granularity of granularities) {
    const memories = await store.listMemories(granularity);

    for (const memory of memories) {
      const lowerQuery = query.toLowerCase();
      const lowerContent = memory.content.toLowerCase();

      let score = 0;

      if (lowerContent.includes(lowerQuery)) {
        score = 0.7;
      } else {
        const queryWords = lowerQuery.split(/\s+/);
        const contentWords = lowerContent.split(/\s+/);
        const overlap = queryWords.filter((w: string) =>
          contentWords.includes(w)
        ).length;
        score = overlap / queryWords.length * 0.5;
      }

      if (memory.sourceInstance === instanceId) {
        score += instanceBoost;
      }

      if (score >= minScore) {
        const excerpt = findBestExcerpt(memory.content, query);

        const ageDays = Math.max(
          0,
          Math.round(
            (Date.now() - new Date(memory.date).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        );

        results.push({
          granularity: memory.granularity,
          date: memory.date,
          score: Math.min(score, 1),
          excerpt: excerpt.trim() + (memory.content.length > 200 ? "..." : ""),
          sourceInstance: memory.sourceInstance,
          tier: memory.granularity,
          ageDays,
          vectorScore: 0,
          method: "text",
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);

  return {
    results: results.slice(0, maxResults),
    searchMethod: "text",
    vectorAvailable: false,
  };
}

/**
 * Create the memory/list tool handler.
 */
export function createMemoryListHandler(store: FileStore) {
  return async (
    input: z.infer<typeof MemoryListSchema>,
  ): Promise<MemoryListOutput> => {
    const { granularity, limit = 20, offset = 0, beforeDate, afterDate } =
      input;
    const memories: MemoryListOutput["memories"] = [];

    const granularities: Granularity[] = granularity
      ? [granularity as Granularity]
      : ["daily", "weekly", "monthly", "yearly", "significant"];

    for (const g of granularities) {
      const list = await store.listMemories(g);

      for (const memory of list) {
        // Apply date filters
        if (beforeDate && memory.date > beforeDate) continue;
        if (afterDate && memory.date < afterDate) continue;

        memories.push({
          granularity: memory.granularity,
          date: memory.slug ? `${memory.date}_${memory.slug}` : memory.date,
          preview: memory.content.slice(0, 100) +
            (memory.content.length > 100 ? "..." : ""),
          ...(memory.sourceInstance
            ? { sourceInstance: memory.sourceInstance }
            : {}),
        });
      }
    }

    // Sort by date (newest first)
    memories.sort((a, b) => b.date.localeCompare(a.date));
    const total = memories.length;

    return { memories: memories.slice(offset, offset + limit), total };
  };
}

/**
 * Create the memory/read tool handler.
 */
export function createMemoryReadHandler(store: FileStore) {
  return async (
    input: z.infer<typeof MemoryReadSchema>,
  ): Promise<MemoryReadOutput> => {
    const { granularity, date } = input;

    // Use findMemoryByDate to search across instance variants
    // (e.g. daily memories with instance-scoped filenames like 2026-04-15_psycheros.md)
    const memory = await store.findMemoryByDate(granularity, date);

    if (!memory) {
      return {
        success: false,
        message: `No memory found for ${granularity}/${date}.`,
      };
    }

    return {
      success: true,
      memory,
    };
  };
}

/**
 * Create the memory/update tool handler.
 *
 * Explicitly overwrites a memory (no append merge).
 * Sets editedBy field for future conflict resolution awareness.
 */
export function createMemoryUpdateHandler(
  store: FileStore,
  cache?: EmbeddingCache,
) {
  return async (
    input: z.infer<typeof MemoryUpdateSchema>,
  ): Promise<MemoryUpdateOutput> => {
    const { granularity, date, content, editedBy, instanceId } = input;

    // Read existing memory to preserve metadata.
    // Always use findMemoryByDate for significant memories — readMemory
    // with instanceId looks for a daily-style instance-suffix file, which
    // doesn't exist for slug-based significant memories.
    const existing = (instanceId && granularity !== "significant")
      ? await store.readMemory(granularity, date, instanceId)
      : await store.findMemoryByDate(granularity, date);

    // Preserve slug: prefer explicit input, fall back to existing entry.
    // Without the slug, writeMemory would create a bare {date}.md file
    // that shadows the real {date}_{slug}.md.
    const slug = input.slug ?? existing?.slug;

    const memory: MemoryEntry = {
      id: `${granularity}-${date}`,
      granularity: granularity as Granularity,
      date,
      content,
      chatIds: existing?.chatIds ?? [],
      sourceInstance: existing?.sourceInstance ?? editedBy ?? instanceId ?? "",
      participatingInstances: existing?.participatingInstances,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(slug ? { slug } : {}),
    };

    await store.writeMemory(memory);

    // Re-cache embedding (fire-and-forget)
    if (cache) {
      cache.getOrCompute(memory, getEmbedder())
        .then(() =>
          console.error(`[EmbeddingCache] Re-cached embedding for ${memory.id}`)
        )
        .catch((err) =>
          console.error(
            `[EmbeddingCache] Failed to re-cache ${memory.id}:`,
            err,
          )
        );
    }

    return {
      success: true,
      message: `I have updated the ${granularity} memory for ${date}.`,
      memoryId: memory.id,
    };
  };
}

/**
 * Tool definitions for MCP registration.
 */
/**
 * Create the memory/delete tool handler.
 */
export function createMemoryDeleteHandler(
  store: FileStore,
  cache?: EmbeddingCache,
) {
  return async (
    input: z.infer<typeof MemoryDeleteSchema>,
  ): Promise<MemoryDeleteOutput> => {
    const { granularity, date, instanceId, slug } = input;

    // Compute memory key before deleting (for cache cleanup)
    const memoryKey = computeMemoryKey({
      granularity,
      date,
      sourceInstance: instanceId,
      slug,
    });

    const deleted = await store.deleteMemory(
      granularity as Granularity,
      date,
      instanceId,
      slug,
    );

    // Clean up cached embedding
    if (cache && deleted) {
      cache.delete(memoryKey);
    }

    return {
      success: deleted,
      message: deleted
        ? `Deleted ${granularity} memory: ${date}`
        : `Memory not found: ${granularity}/${date}`,
    };
  };
}

// ---- Embedding maintenance tools ----

export const MemoryEmbeddingPurgeSchema = z.object({});

export interface MemoryEmbeddingPurgeOutput {
  purged: number;
  remaining: number;
  message: string;
}

export function createMemoryEmbeddingPurgeHandler(
  store: FileStore,
  cache: EmbeddingCache,
) {
  return async (): Promise<MemoryEmbeddingPurgeOutput> => {
    let purged = 0;

    const granularities: Granularity[] = [
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "significant",
    ];

    for (const granularity of granularities) {
      const memories = await store.listMemories(granularity);
      const existingKeys = new Set(memories.map((m) =>
        computeMemoryKey({
          granularity: m.granularity,
          date: m.date,
          sourceInstance: m.sourceInstance || undefined,
          slug: m.slug || undefined,
        })
      ));

      const entries = cache.getEntriesByGranularity(granularity);
      for (const entry of entries) {
        if (!existingKeys.has(entry.parentKey)) {
          cache.delete(entry.parentKey);
          purged++;
        }
      }
    }

    const totalAfter = cache.getStats().totalCached;
    return {
      purged,
      remaining: totalAfter,
      message: purged > 0
        ? `Purged ${purged} orphaned embedding(s). ${totalAfter} remaining.`
        : "No orphaned embeddings found.",
    };
  };
}

export const MemoryEmbeddingRebuildSchema = z.object({});

export interface MemoryEmbeddingRebuildOutput {
  rebuilt: number;
  failed: number;
  total: number;
  message: string;
}

export function createMemoryEmbeddingRebuildHandler(
  store: FileStore,
  cache: EmbeddingCache,
) {
  return async (): Promise<MemoryEmbeddingRebuildOutput> => {
    const statsBefore = cache.getStats();
    const total = statsBefore.totalCached;

    // Clear all cached embeddings
    cache.clearAll();

    const embedder = getEmbedder();
    let rebuilt = 0;
    let failed = 0;

    const granularities: Granularity[] = [
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "significant",
    ];

    for (const granularity of granularities) {
      const memories = await store.listMemories(granularity);
      for (const memory of memories) {
        try {
          const result = await cache.getOrCompute(
            {
              granularity: memory.granularity,
              date: memory.date,
              sourceInstance: memory.sourceInstance || undefined,
              slug: memory.slug || undefined,
              content: memory.content,
            },
            embedder,
          );
          if (result) {
            rebuilt++;
          } else {
            failed++;
          }
        } catch (err) {
          console.error(
            `[Memory] Failed to rebuild embedding for ${granularity}/${memory.date}: ${err}`,
          );
          failed++;
        }
      }
    }

    return {
      rebuilt,
      failed,
      total,
      message: failed === 0
        ? `Rebuilt ${rebuilt} embedding(s) from ${rebuilt} memory files.`
        : `Rebuilt ${rebuilt} embedding(s), ${failed} failed.`,
    };
  };
}

export const memoryTools = {
  "memory/create": {
    description:
      "Create a new memory entry. I use this to record things worth remembering from our conversations. Tag each bullet point with the chat ID and instance: [chat:ID] [via:instanceId].",
    inputSchema: MemoryCreateSchema,
  },
  "memory/search": {
    description:
      "Search my memories for relevant content. Uses vector similarity with multi-signal ranking (semantic relevance, recency, graph context, and instance affinity). Falls back to text matching if embeddings are unavailable.",
    inputSchema: MemorySearchSchema,
  },
  "memory/list": {
    description:
      "List my memories, optionally filtered by granularity. Use this to see what I've been remembering.",
    inputSchema: MemoryListSchema,
  },
  "memory/read": {
    description:
      "Read a single memory entry by granularity and date. Returns the full content and metadata.",
    inputSchema: MemoryReadSchema,
  },
  "memory/update": {
    description:
      "Overwrite a memory entry. Use this to correct inaccuracies in my recorded memories. Unlike memory/create, this replaces content entirely (no append merge). Tracks who made the edit via editedBy.",
    inputSchema: MemoryUpdateSchema,
  },
  "memory/delete": {
    description:
      "Permanently delete a memory entry. I use this to remove memories that are no longer relevant or were created in error.",
    inputSchema: MemoryDeleteSchema,
  },
  "memory/embedding_purge": {
    description:
      "Remove orphaned memory embeddings for files that no longer exist. Cleans up ghost entries in the embedding cache left behind after manual file deletion.",
    inputSchema: MemoryEmbeddingPurgeSchema,
  },
  "memory/embedding_rebuild": {
    description:
      "Clear all memory embeddings and rebuild them from existing memory files. I use this after bulk deletion or migration to ensure embeddings match current files.",
    inputSchema: MemoryEmbeddingRebuildSchema,
  },
};
