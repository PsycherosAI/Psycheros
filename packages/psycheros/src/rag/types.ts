/**
 * RAG Types
 *
 * Core type definitions for the Retrieval-Augmented Generation system.
 */

/**
 * Configuration for the RAG system.
 */
export interface RAGConfig {
  /** Whether RAG is enabled */
  enabled: boolean;
  /** Maximum number of chunks to retrieve */
  maxChunks: number;
  /** Maximum tokens budget for retrieved content */
  maxTokens: number;
  /** Minimum relevance score (0-1) for inclusion */
  minScore: number;
  /** Path to memories directory */
  memoriesDir: string;
  /** Current embodiment ID for instance relevance boosting */
  currentInstance?: string;
  /** Boost factor for memories from the same embodiment (default: 0.1) */
  instanceBoost?: number;
}

/**
 * Default RAG configuration values.
 */
export const DEFAULT_RAG_CONFIG: RAGConfig = {
  enabled: true,
  maxChunks: 8,
  maxTokens: 2000,
  minScore: 0.3,
  memoriesDir: "memories",
};

/**
 * A chunk of text from a memory file.
 */
export interface Chunk {
  /** Unique identifier for this chunk */
  id: string;
  /** The text content of the chunk */
  content: string;
  /** Source file path (relative to memories dir) */
  sourceFile: string;
  /** Estimated token count */
  tokenCount: number;
  /** Additional metadata (e.g., headers, position) */
  metadata?: ChunkMetadata;
  /** When this chunk was created */
  createdAt: Date;
}

/**
 * Optional metadata for a chunk.
 */
export interface ChunkMetadata {
  /** Markdown headers present in this chunk */
  headers?: string[];
  /** Line number in source file */
  lineNumber?: number;
  /** Which embodiment created this memory */
  sourceInstance?: string;
}

/**
 * Result from a retrieval operation.
 */
export interface RetrievalResult {
  /** The retrieved chunk */
  chunk: Chunk;
  /** Relevance score (0-1, cosine similarity) */
  score: number;
}

/**
 * Interface for embedding generators.
 */
export interface Embedder {
  /** Generate an embedding for the given text */
  embed(text: string): Promise<number[]>;
  /** Get the dimension of embeddings */
  getDimension(): number;
  /** Check if the model is ready */
  isReady(): boolean;
  /** Initialize the embedder (load model if needed) */
  initialize(): Promise<void>;
}

/**
 * Interface for text chunkers.
 */
export interface Chunker {
  /** Chunk text into smaller pieces */
  chunk(text: string, sourceFile: string): Chunk[];
}

/**
 * Interface for the memory indexer.
 */
export interface Indexer {
  /** Index all memory files */
  indexAll(): Promise<void>;
  /** Check if a file needs reindexing */
  needsReindex(filePath: string): Promise<boolean>;
  /** Remove indexed data for a file */
  removeFile(filePath: string): void;
  /** Reindex a single file (efficient — only processes the one changed file) */
  reindexFile(relativePath: string): Promise<void>;
}

/**
 * Interface for the memory retriever.
 */
export interface Retriever {
  /** Retrieve relevant chunks for a query */
  retrieve(
    query: string,
    config?: Partial<RAGConfig>,
  ): Promise<RetrievalResult[]>;
}

/**
 * Record for an indexed memory file.
 */
export interface IndexedMemory {
  /** File path (relative to memories dir) */
  path: string;
  /** Hash of file content for change detection */
  contentHash: string;
  /** Number of chunks from this file */
  chunkCount: number;
  /** When this file was indexed */
  indexedAt: Date;
}

/**
 * Vector search result from sqlite-vec.
 */
export interface VectorSearchResult {
  /** Chunk ID */
  chunk_id: string;
  /** Cosine similarity score */
  score: number;
}
