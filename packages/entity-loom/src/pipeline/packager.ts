/**
 * Entity Loom — Packager
 *
 * Finalizes the import package by writing the manifest with pipeline stats.
 */

import type { ManifestData, PipelineConfig, PipelineResult } from "../types.ts";
import { writeManifest } from "../writers/manifest-writer.ts";

/**
 * Write the manifest.json file to the package directory.
 * Called as the final pass after all pipeline work is complete.
 */
export async function finalizePackage(
  packageDir: string,
  config: PipelineConfig,
  result: PipelineResult,
): Promise<string> {
  const manifest: ManifestData = {
    version: 1,
    entityName: config.entityName,
    userName: config.userName,
    platform: config.platform,
    instanceId: config.instanceId,
    inputPath: config.inputPath,
    createdAt: new Date().toISOString(),
    entityPronouns: config.entityPronouns,
    userPronouns: config.userPronouns,
    relationshipContext: config.relationshipContext,
    contextNotes: config.contextNotes,
    dateFrom: config.dateFrom,
    dateTo: config.dateTo,
    stats: {
      conversationsParsed: result.pass1.conversationsParsed,
      conversationsStored: result.pass2.conversationsStored,
      messagesStored: result.pass2.messagesStored,
      dailyMemoriesCreated: result.pass3a.dailyMemoriesCreated,
      significantMemoriesCreated: result.pass3b.significantMemoriesCreated,
      graphNodes: result.pass4.nodesCreated,
      graphEdges: result.pass4.edgesCreated,
    },
  };

  const manifestPath = await writeManifest(packageDir, manifest);
  return manifestPath;
}
