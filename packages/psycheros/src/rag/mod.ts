/**
 * RAG Module
 *
 * Retrieval-Augmented Generation system for Psycheros.
 * Provides local semantic search over chat history, data vault,
 * and lorebook. Memory retrieval is delegated to entity-core via MCP.
 *
 * @module
 */

// Types
export type {
  Chunk,
  Chunker,
  ChunkMetadata,
  Embedder,
  IndexedMemory,
  RAGConfig,
  RetrievalResult,
  VectorSearchResult,
} from "./types.ts";

export { DEFAULT_RAG_CONFIG } from "./types.ts";

// Embedder
export { getEmbedder, LocalEmbedder } from "./embedder.ts";

// Chunker
export { estimateTokens, getChunker, MemoryChunker } from "./chunker.ts";

// Context Builder
export {
  buildGraphContext,
  buildRAGContext,
  formatMemories,
} from "./context-builder.ts";
export type {
  BuildGraphContextOptions,
  GraphContextResult,
} from "./context-builder.ts";

// Conversational RAG
export {
  ConversationRAG,
  formatChatHistoryForContext,
  getConversationRAG,
} from "./conversation.ts";
export type { ChatSearchOptions, RetrievedMessage } from "./conversation.ts";
