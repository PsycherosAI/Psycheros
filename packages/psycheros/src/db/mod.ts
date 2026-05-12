/**
 * Psycheros Database Module
 *
 * Exports database functionality for the Psycheros daemon.
 */

export { DBClient } from "./client.ts";
export { initializeSchema } from "./schema.ts";
export {
  createVectorTable,
  deleteVector,
  deserializeVector,
  ensureVectorModule,
  getVecVersion,
  insertVector,
  isVectorModuleAvailable,
  loadVectorExtension,
  prepareVectorExtension,
  searchSimilarVectors,
  serializeVector,
} from "./vector.ts";
export type { VectorSearchRow } from "./vector.ts";
