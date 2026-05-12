/**
 * Entity Loom — Manifest Writer
 *
 * Writes the package manifest.json file.
 */

import { join } from "@std/path";
import type { ManifestData } from "../types.ts";

/**
 * Write the manifest to the package directory.
 * Returns the path to the written manifest file.
 */
export async function writeManifest(
  packageDir: string,
  manifest: ManifestData,
): Promise<string> {
  const manifestPath = join(packageDir, "manifest.json");
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}
