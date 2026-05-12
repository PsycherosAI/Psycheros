/**
 * Vector Database Helpers
 *
 * Utilities for working with sqlite-vec extension for efficient
 * vector similarity search in SQLite.
 */

import type { Database } from "@db/sqlite";
import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir, exists } from "@std/fs";

// Track extension loading state
let extensionLoaded = false;

/**
 * Get the expected extension filename for the current platform.
 */
function getPlatformExtension(): string {
  const os = Deno.build.os;
  switch (os) {
    case "windows":
      return "vec0.dll";
    case "darwin":
      return "vec0.dylib";
    default:
      return "vec0.so";
  }
}

/**
 * Detect the current platform and return a sqlite-vec release asset name.
 * Returns null if the platform is unsupported.
 */
function detectPlatformAsset(): string | null {
  const os = Deno.build.os;
  const arch = Deno.build.arch;

  const osMap: Record<string, string> = {
    linux: "linux",
    darwin: "macos",
    windows: "windows",
  };
  const archMap: Record<string, string> = {
    x86_64: "x86_64",
    aarch64: "aarch64",
  };

  const osName = osMap[os];
  const archName = archMap[arch];
  if (!osName || !archName) return null;

  return `sqlite-vec-0.1.9-loadable-${osName}-${archName}.tar.gz`;
}

interface TarEntry {
  dataOffset: number;
  size: number;
}

/**
 * Find a file entry in a raw tar archive and return its data offset and size.
 * Minimal tar parser — only handles regular files with no extended headers.
 */
function findTarEntry(data: Uint8Array, filename: string): TarEntry | null {
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);

    // Check for end-of-archive (two zero blocks)
    if (header.every((b) => b === 0)) break;

    // Filename is at offset 0, null-terminated, max 100 bytes
    const nameBytes = header.subarray(0, 100);
    const nullIdx = nameBytes.indexOf(0);
    const name = new TextDecoder().decode(
      nameBytes.subarray(0, nullIdx === -1 ? 100 : nullIdx),
    );

    if (name === filename) {
      // Size is at offset 124, 12 bytes, octal ASCII
      const sizeStr = new TextDecoder().decode(header.subarray(124, 136))
        .trim();
      const size = parseInt(sizeStr, 8) || 0;
      // File data starts at next 512-byte boundary after header
      return { dataOffset: offset + 512, size };
    }

    // Size of this entry's data
    const sizeStr = new TextDecoder().decode(header.subarray(124, 136)).trim();
    const size = parseInt(sizeStr, 8) || 0;
    // Advance past header + data (padded to 512-byte blocks)
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Attempt to auto-download the sqlite-vec extension binary from GitHub releases.
 * Downloads and extracts to the lib/ directory if the extension file doesn't already exist.
 * Called during startup before database initialization.
 */
export async function prepareVectorExtension(
  projectRoot: string,
): Promise<void> {
  const libDir = join(projectRoot, "lib");
  const extFile = getPlatformExtension();
  const extPath = join(libDir, extFile);

  // Already exists — skip download
  if (await exists(extPath)) return;

  const assetName = detectPlatformAsset();
  if (!assetName) {
    console.warn(
      `[Vector] Unsupported platform (${Deno.build.os}/${Deno.build.arch}) for sqlite-vec auto-download`,
    );
    return;
  }

  const url =
    `https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/${assetName}`;
  console.log(
    `[Vector] sqlite-vec extension not found. Downloading ${assetName}...`,
  );

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(
        `[Vector] Failed to download sqlite-vec: HTTP ${response.status}`,
      );
      return;
    }

    await ensureDir(libDir);

    // Decompress the tar.gz and extract vec0.{so,dll,dylib}
    const tarData = new Uint8Array(await response.arrayBuffer());
    // Use Deno's built-in decompress for gzip
    const decompressed = new Uint8Array(
      await new Response(
        new Response(tarData).body!.pipeThrough(
          new DecompressionStream("gzip"),
        ),
      ).arrayBuffer(),
    );

    // Find the vec0 file in the tar archive
    const vec0Offset = findTarEntry(decompressed, extFile);
    if (vec0Offset === null) {
      console.error(
        "[Vector] Downloaded archive does not contain expected file",
      );
      return;
    }

    await Deno.writeFile(
      extPath,
      decompressed.subarray(
        vec0Offset.dataOffset,
        vec0Offset.dataOffset + vec0Offset.size,
      ),
    );
    console.log(`[Vector] sqlite-vec extension installed to ${extPath}`);
  } catch (error) {
    console.error(
      "[Vector] Failed to download sqlite-vec:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Get the path to the sqlite-vec extension file.
 * Looks for vec0 in the lib/ directory relative to this module.
 * SQLite auto-appends the platform suffix (.so on Linux, .dylib on macOS).
 */
function getExtensionPath(): string | null {
  try {
    // Get the directory containing this module
    const moduleDir = dirname(fromFileUrl(import.meta.url));
    // Go up to project root (src/db -> src -> root) then into lib
    const extPath = join(moduleDir, "..", "..", "lib", "vec0");
    return extPath;
  } catch {
    return null;
  }
}

/**
 * Check if the sqlite-vec extension is loaded.
 *
 * @returns true if the extension is loaded
 */
export function isVectorModuleAvailable(): boolean {
  return extensionLoaded;
}

/**
 * Ensure the sqlite-vec extension is loaded.
 * This is now synchronous since we load from file instead of npm package.
 *
 * @returns Promise that resolves to true if extension loaded successfully
 */
export function ensureVectorModule(): boolean {
  // Extension loading is now done in loadVectorExtension
  // This function exists for backwards compatibility
  return extensionLoaded;
}

/**
 * Load the sqlite-vec extension into a database connection.
 * Must be called before using vec0 virtual tables.
 *
 * @param db - The SQLite database instance
 * @returns true if extension loaded successfully, false otherwise
 */
export function loadVectorExtension(db: Database): boolean {
  if (extensionLoaded) {
    return true;
  }

  try {
    db.enableLoadExtension = true;

    // Build candidate paths — try explicit platform filename first, then auto-suffix
    const moduleDir = dirname(fromFileUrl(import.meta.url));
    const extFile = getPlatformExtension();
    const candidates = [
      join(moduleDir, "..", "..", "lib", extFile), // lib/vec0.{so,dll,dylib}
      getExtensionPath(), // lib/vec0 (auto-suffix)
    ].filter((p): p is string => p !== null);

    for (const extPath of candidates) {
      try {
        db.exec(`SELECT load_extension('${extPath}')`);
        extensionLoaded = true;
        db.enableLoadExtension = false;
        return true;
      } catch {
        // Try next candidate
      }
    }

    // Native extension not available — fall back to in-memory cosine similarity
    console.warn("[Vector] sqlite-vec extension not available.");
    console.warn(
      "[Vector] Vector search will fall back to in-memory calculation.",
    );
    db.enableLoadExtension = false;
    return false;
  } catch (error) {
    console.warn(
      "[Vector] Failed to load sqlite-vec extension:",
      error instanceof Error ? error.message : String(error),
    );
    db.enableLoadExtension = false;
    return false;
  }
}

/**
 * Serialize a vector (array of numbers) to Uint8Array for storage.
 * Converts to Float32Array internally for proper binary representation.
 *
 * @param vec - Array of numbers (embedding vector)
 * @returns Uint8Array suitable for BLOB storage
 */
export function serializeVector(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

/**
 * Deserialize a Uint8Array back to a number array.
 *
 * @param data - Binary data from database BLOB
 * @returns Array of numbers (embedding vector)
 */
export function deserializeVector(data: Uint8Array | ArrayBuffer): number[] {
  const buffer = data instanceof Uint8Array ? data.buffer : data;
  return Array.from(new Float32Array(buffer));
}

/**
 * Create a vector virtual table for similarity search.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the virtual table to create
 * @param dimensions - Dimension of the vectors (e.g., 384 for all-MiniLM-L6-v2)
 * @param options - Optional configuration
 */
export function createVectorTable(
  db: Database,
  tableName: string,
  dimensions: number,
  options: {
    /** Distance metric: 'cosine', 'L2', or 'ip' (inner product) */
    distanceMetric?: "cosine" | "L2" | "ip";
    /** Additional columns to include */
    additionalColumns?: string;
  } = {},
): void {
  const { distanceMetric = "cosine", additionalColumns = "" } = options;

  const columns = additionalColumns ? `${additionalColumns},\n  ` : "";

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
      ${columns}embedding FLOAT[${dimensions}]${
    distanceMetric !== "cosine" ? ` distance_metric=${distanceMetric}` : ""
  }
    )
  `);
}

/**
 * Insert a vector into a vec0 virtual table.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the vector table
 * @param rowid - The row ID (should match the source record)
 * @param embedding - The embedding vector
 */
export function insertVector(
  db: Database,
  tableName: string,
  rowid: number,
  embedding: number[],
): void {
  const serialized = serializeVector(embedding);
  db.exec(
    `INSERT INTO ${tableName}(rowid, embedding) VALUES (?, ?)`,
    [rowid, serialized],
  );
}

/**
 * Delete a vector from a vec0 virtual table.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the vector table
 * @param rowid - The row ID to delete
 */
export function deleteVector(
  db: Database,
  tableName: string,
  rowid: number,
): void {
  db.exec(`DELETE FROM ${tableName} WHERE rowid = ?`, [rowid]);
}

/**
 * Result from a vector similarity search.
 */
export interface VectorSearchRow {
  /** Row ID matching source record */
  rowid: number;
  /** Distance/similarity score (lower is more similar for cosine) */
  distance: number;
}

/**
 * Search for similar vectors using the vec0 MATCH operator.
 *
 * @param db - The SQLite database instance
 * @param tableName - Name of the vector table
 * @param queryEmbedding - The query vector
 * @param limit - Maximum number of results
 * @returns Array of search results with rowid and distance
 */
export function searchSimilarVectors(
  db: Database,
  tableName: string,
  queryEmbedding: number[],
  limit: number,
): VectorSearchRow[] {
  const serialized = serializeVector(queryEmbedding);

  const stmt = db.prepare(
    `SELECT rowid, distance
     FROM ${tableName}
     WHERE embedding MATCH ?
     ORDER BY distance
     LIMIT ?`,
  );

  const rows = stmt.all<VectorSearchRow>(serialized, limit);
  stmt.finalize();

  return rows;
}

/**
 * Check if sqlite-vec extension is loaded by querying vec_version.
 *
 * @param db - The SQLite database instance
 * @returns The version string or null if not loaded
 */
export function getVecVersion(db: Database): string | null {
  try {
    const stmt = db.prepare("SELECT vec_version() as version");
    const row = stmt.get<{ version: string }>();
    stmt.finalize();
    return row?.version ?? null;
  } catch {
    return null;
  }
}
