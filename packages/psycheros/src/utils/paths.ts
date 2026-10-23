/**
 * Data-path helpers — the single home of the on-disk layout convention.
 *
 * Everything the daemon persists lives under `<dataRoot>/.psycheros/` (the
 * DB, settings JSON files, model caches, organ state). The folder name is
 * host policy, not caller knowledge: resolve it here, never spell it out
 * at call sites. entity-flux imports this leaf instead of re-deriving the
 * convention — flux→psycheros leaf imports are allowed (dependency
 * direction protects psycheros, not flux).
 */

import { join } from "@std/path";

/** The daemon's persistent-data directory under the given data root. */
export function psycherosDir(dataRoot: string): string {
  return join(dataRoot, ".psycheros");
}
