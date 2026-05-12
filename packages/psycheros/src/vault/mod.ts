/**
 * Vault Module
 *
 * Barrel exports for the Data Vault system.
 */

export { VaultManager } from "./manager.ts";
export { formatVaultContext } from "./retriever.ts";
export { extractText, resolveFileType } from "./processor.ts";
export type {
  VaultChunk,
  VaultCreateOptions,
  VaultDocument,
  VaultFileType,
  VaultListOptions,
  VaultScope,
  VaultSearchOptions,
  VaultSearchResult,
  VaultSource,
} from "./types.ts";
export {
  MAX_VAULT_FILE_SIZE,
  SUPPORTED_VAULT_TYPES,
  VAULT_DEFAULT_MAX_CHUNKS,
  VAULT_DEFAULT_MAX_TOKENS,
  VAULT_MIME_TYPES,
} from "./types.ts";
