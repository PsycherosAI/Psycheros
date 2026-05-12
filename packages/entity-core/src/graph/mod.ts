/**
 * Graph Module
 *
 * My knowledge graph - the web of what I know about my person
 * and how everything connects.
 */

// Types
export {
  type CreateEdgeInput,
  type CreateNodeInput,
  EMBEDDING_DIMENSION,
  type GetEdgesOptions,
  type GraphEdge,
  type GraphInsight,
  type GraphNode,
  type GraphStats,
  type ListNodesOptions,
  type NodeSearchResult,
  type SearchNodesOptions,
  type Subgraph,
  SUGGESTED_EDGE_VOCABULARY,
  type SuggestedNodeType,
  type TraverseOptions,
  type TraverseResult,
  type UpdateEdgeInput,
  type UpdateNodeInput,
} from "./types.ts";

// Store
export { GraphStore } from "./store.ts";

// Schema
export {
  getVecVersion,
  initializeGraphSchema,
  isVectorSearchAvailable,
  verifyVectorTableSync,
} from "./schema.ts";

// Extraction prompt & dedup
export {
  buildExtractionPrompt,
  confirmNode,
  EXTRACTION_SYSTEM_PROMPT,
  type ExtractionType,
  findSemanticDuplicate,
  MIN_CONFIDENCE,
} from "./extraction-prompt.ts";

// Graph consolidation
export { consolidateGraph, type ConsolidationResult } from "./consolidator.ts";

// Memory Integration
export {
  createMemoryIntegration,
  MemoryIntegration,
} from "./memory-integration.ts";

// RAG Integration
export {
  createGraphRAG,
  GraphRAG,
  type GraphRAGOptions,
  type GraphRAGResult,
} from "./rag-integration.ts";
