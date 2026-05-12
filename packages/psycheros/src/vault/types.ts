/**
 * Vault Type Definitions
 *
 * Core types for the Data Vault document storage system.
 */

/** Scope of a vault document */
export type VaultScope = "global" | "chat";

/** Source of a vault document */
export type VaultSource = "upload" | "entity";

/** Supported file types for vault uploads */
export const SUPPORTED_VAULT_TYPES = [
  "md",
  "txt",
  "pdf",
  "docx",
  "xlsx",
] as const;

export type VaultFileType = (typeof SUPPORTED_VAULT_TYPES)[number];

/** A vault document stored in the database */
export interface VaultDocument {
  id: string;
  title: string;
  filename: string;
  fileType: VaultFileType;
  scope: VaultScope;
  conversationId?: string;
  filePath: string;
  fileSize: number;
  contentHash: string;
  chunkCount: number;
  source: VaultSource;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A chunk of text extracted from a vault document */
export interface VaultChunk {
  id: string;
  documentId: string;
  content: string;
  tokenCount: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** Result from a vault search */
export interface VaultSearchResult {
  chunk: VaultChunk;
  documentTitle: string;
  score: number;
}

/** Options for listing documents */
export interface VaultListOptions {
  scope?: VaultScope | "all";
  conversationId?: string;
}

/** Options for creating a document from upload */
export interface VaultCreateOptions {
  scope: VaultScope;
  conversationId?: string;
  title?: string;
}

/** Options for searching the vault */
export interface VaultSearchOptions {
  conversationId?: string;
  maxChunks?: number;
  minScore?: number;
}

/** Allowed MIME types for vault uploads */
export const VAULT_MIME_TYPES: Record<string, VaultFileType> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** Maximum upload size (10MB) */
export const MAX_VAULT_FILE_SIZE = 10 * 1024 * 1024;

/** Default token budget for vault RAG */
export const VAULT_DEFAULT_MAX_TOKENS = 1500;

/** Default max chunks for vault search */
export const VAULT_DEFAULT_MAX_CHUNKS = 5;
