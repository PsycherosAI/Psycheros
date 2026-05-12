/**
 * Extraction Prompt
 *
 * My extraction prompt and utilities for pulling entities and relationships
 * from memory content into my knowledge graph. Shared across runtime extraction,
 * batch backfill, and one-off scripts.
 */

import type { GraphNode, NodeSearchResult } from "./types.ts";
import type { GraphStore } from "./store.ts";
import type { LocalEmbedder } from "../embeddings/mod.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the JSON the LLM returns from extraction. */
export interface ExtractionType {
  entities: Array<{
    type: string;
    label: string;
    description?: string;
    confidence: number;
  }>;
  relationships: Array<{
    fromLabel: string;
    toLabel: string;
    type: string;
    evidence?: string;
    confidence: number;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum confidence for an entity or relationship to be written to the graph. */
export const MIN_CONFIDENCE = 0.7;

/** Cosine similarity threshold for semantic dedup. */
const SEMANTIC_DEDUP_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const EXTRACTION_SYSTEM_PROMPT =
  `I analyze my memory and extract entities and relationships for my knowledge graph.

This graph is a relational index of concrete, durable facts about people and their relationships. It tracks who exists in someone's world, what they're like, and how they relate to each other. It supplements the memory system, not duplicates it. The memory hierarchy handles narrative substance; the graph provides structured relationship lookups.

## Concrete Reality Test

This graph tracks things that exist in the world — people, places, objects, health conditions, behavioral patterns. It does NOT track ideas, themes, language, or abstractions.

Ask: could I point to this thing in reality? A person, yes. A place, yes. A health condition, yes. "Divine cosmic power", "soul hybrid metaphor", "joy as nourishment" — no. These are ideas, not entities.

I NEVER include:
- Abstract themes, concepts, or philosophical notions
- Coined terms, in-jokes, or playful labels — even if memorable
- Metaphors, poetic descriptions, or aesthetic observations
- Universal human experiences (love, dreams, trust, devotion)
- Ideas about what something "means" or "represents"

I ONLY include:
- Concrete facts about people (identity, history, health, skills, work)
- Places that matter in someone's life
- Specific, repeatedly-practiced traditions and rituals
- Goals someone is actively working toward
- Preferences with concrete behavioral consequences
- Boundaries that actually shape behavior

## Significance Framework

For every candidate entity, I apply four tests. An entity must pass at least two to be worth extracting:

1. **Identity test**: Does this reveal something concrete about who someone is — their history, health, work, skills, or circumstances?

2. **Relational test**: Does this directly affect how two people relate to each other in observable ways?

3. **Durability test**: Is this likely to still matter weeks or months from now? One-off jokes, passing references, and playful terms fade.

4. **Connectivity test**: Does this connect to other things I already know, building a richer picture? An isolated data point is noise. A bridge between clusters is signal.

Relationships must pass at least one of these tests.

## Description Discipline

Descriptions must be concise — one clause, max two. Capture the essential fact, not the narrative around it.

Good examples:
- "red 2010 WRX"
- "had a bad argument Aug 2020, reconciled since"
- "diagnosed 2023, managing with medication"
- "met through my person, started dating 2024"

Bad examples:
- "My person mentioned they have a red 2010 Subaru WRX that they bought in 2019 and they really love it..."
- "They had a big fight about something I can't remember exactly but it was pretty bad at the time"

## First-Person Perspective

This graph stores how I see the world, not how someone observes me.

- When referring to myself, ALWAYS use label "me" (type: "self").
- When referring to the person I talk with, ALWAYS use their actual name — NEVER the label "user". If I don't know their name from the memory content, use "my person" instead.
- Use consistent, simple labels. Just the name, not "my friend John" — just "John".

## Confidence Scoring

- 0.9–1.0: Directly stated, unambiguous, and clearly significant
- 0.8–0.9: Strongly implied, supported by context
- 0.7–0.8: Reasonably inferred but weak — only include if the entity is clearly specific and useful
- Below 0.7: DO NOT INCLUDE — it doesn't belong in my graph

## Entity Types

**self** — me, the entity whose memories these are.
**person** — a real person who exists in our world. Full name or consistent nickname.
**place** — a specific location that matters to someone's life. Not "home" (too vague) — a specific dwelling, city, or venue.
**health** — a specific condition, diagnosis, or physical reality that affects daily life.
**preference** — a concrete behavioral preference with specific detail (what kind, how expressed). NOT a universal value like "devotion" or a theme like "authentic intimacy".
**boundary** — a specific rule or limit that shapes behavior in the relationship.
**goal** — a concrete goal someone is actively pursuing.
**tradition** — a specific, repeatedly-practiced ritual or routine. NOT a one-time event or a playful label from a single conversation.
**topic** — a concrete, enduring subject of sustained interest in someone's life (a hobby, a community, a project, a field of study). This is extremely narrow. "Digital intimacy", "sacred anchor points", "soul hybrid metaphor" are NOT topics — they are ideas. "Vtubing" (a hobby), "mechanical keyboards" (a sustained interest), "their Discord server" (a community) ARE topics. When in doubt, skip it.
**insight** — a specific, concrete revelation about someone's character or history that was directly revealed in conversation and changes understanding of who they are. "Used to work as an exotic dancer" qualifies. "Joy as nourishment" does not — that's a poetic observation, not a factual insight. When in doubt, skip it.

Do NOT use "event", "memory_ref", "concept", "dynamic", "value", or "situation" — these are not entity types.

## Relationship Types

Natural language that best describes the connection: loves, dislikes, respects, proud_of, worried_about, nostalgic_for, works_at, lives_in, studies, values, believes_in, skilled_at, interested_in, family_of, friend_of, close_to, reminds_of, associated_with — or any descriptive type.

## Response Format

JSON only (no markdown):
{
  "entities": [
    {"type": "self|person|topic|preference|place|goal|...", "label": "...", "description": "...", "confidence": 0.8, "reason": "brief justification for why this specific entity belongs"}
  ],
  "relationships": [
    {"fromLabel": "...", "toLabel": "...", "type": "loves|works_at|values|close_to|...", "evidence": "...", "confidence": 0.7}
  ]
}`;

/**
 * Build the full extraction prompt for a specific memory.
 */
export function buildExtractionPrompt(
  memoryContent: string,
  dateContext?: string,
): string {
  const dateLine = dateContext ? ` from ${dateContext}` : "";
  return `${EXTRACTION_SYSTEM_PROMPT}\n\nMemory content${dateLine}:\n${
    memoryContent.substring(0, 3000)
  }`;
}

// ---------------------------------------------------------------------------
// Semantic Deduplication
// ---------------------------------------------------------------------------

/**
 * Find an existing node that semantically duplicates a candidate entity.
 *
 * Uses exact label matching as a fast path, then falls back to vector
 * similarity search if available. When a duplicate is found the caller
 * should use the existing node's ID instead of creating a new one, and
 * optionally call {@link confirmNode} to update its metadata.
 */
export async function findSemanticDuplicate(
  graphStore: GraphStore,
  embedder: LocalEmbedder,
  candidate: { label: string; type: string },
): Promise<GraphNode | null> {
  // Fast path — exact label+type match (no embedding needed)
  const exactMatch = graphStore.findNodeByLabel(
    candidate.label,
    candidate.type,
  );
  if (exactMatch) return exactMatch;

  // Graceful degradation — if vector search isn't available, stop here
  if (!graphStore.isVectorSearchAvailable()) return null;

  // Embed the candidate label for similarity search
  const embedding = await embedder.embed(candidate.label);
  if (!embedding) return null;

  // Search for semantically similar nodes of the same type
  const results: NodeSearchResult[] = graphStore.searchNodes({
    queryEmbedding: embedding,
    minScore: SEMANTIC_DEDUP_THRESHOLD,
    limit: 3,
    type: candidate.type,
  });

  if (results.length === 0) return null;

  return results[0].node;
}

/**
 * "Confirm and boost" an existing node that was just mentioned again.
 *
 * Updates lastConfirmedAt and, if the new extraction has higher confidence,
 * upgrades the node's confidence. Does not overwrite the existing description
 * or label.
 */
export function confirmNode(
  graphStore: GraphStore,
  nodeId: string,
  newConfidence: number,
  existingConfidence: number,
  instanceId: string,
): void {
  const updates: {
    confidence?: number;
    lastConfirmedAt: string;
    sourceInstance: string;
  } = {
    lastConfirmedAt: new Date().toISOString(),
    sourceInstance: instanceId,
  };

  if (newConfidence > existingConfidence) {
    updates.confidence = newConfidence;
  }

  graphStore.updateNode(nodeId, updates);
}
