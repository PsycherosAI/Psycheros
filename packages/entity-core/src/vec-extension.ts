/**
 * sqlite-vec extension loader.
 *
 * The sqlite-vec native extension is not committed to the repo. On first
 * use, ensureVectorExtension downloads the platform-appropriate binary
 * from the sqlite-vec GitHub releases and writes it to <projectRoot>/lib/.
 * Subsequent calls are a fast no-op once the file exists.
 *
 * Consumers (GraphStore, EmbeddingCache) should call ensureVectorExtension
 * once during initialize() before opening the database connection, then
 * load the extension via SELECT load_extension('<lib/vec0>').
 */

import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";

const SQLITE_VEC_VERSION = "0.1.9";

/**
 * Get the expected extension filename for the current platform.
 * SQLite's load_extension auto-appends the platform suffix when passed
 * the stem, but we keep explicit naming for clarity and for the tar lookup.
 */
export function getPlatformExtension(): string {
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
 * Map the current platform to the sqlite-vec release asset filename.
 * Returns null if the platform isn't supported by upstream releases.
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

  return `sqlite-vec-${SQLITE_VEC_VERSION}-loadable-${osName}-${archName}.tar.gz`;
}

interface TarEntry {
  dataOffset: number;
  size: number;
}

/**
 * Minimal tar parser — finds a regular-file entry by exact filename and
 * returns its data offset and size. Doesn't handle extended headers or
 * long filenames; sufficient for the sqlite-vec release tarball layout.
 */
function findTarEntry(data: Uint8Array, filename: string): TarEntry | null {
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);

    // End-of-archive: two zero blocks. We only check the first one.
    if (header.every((b) => b === 0)) break;

    // Filename: bytes 0-99, null-terminated.
    const nameBytes = header.subarray(0, 100);
    const nullIdx = nameBytes.indexOf(0);
    const name = new TextDecoder().decode(
      nameBytes.subarray(0, nullIdx === -1 ? 100 : nullIdx),
    );

    // Size: bytes 124-135, octal ASCII.
    const sizeStr = new TextDecoder().decode(header.subarray(124, 136)).trim();
    const size = parseInt(sizeStr, 8) || 0;

    if (name === filename) {
      return { dataOffset: offset + 512, size };
    }

    // Advance past header + data, rounded up to a 512-byte boundary.
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Ensure the sqlite-vec extension exists at <projectRoot>/lib/vec0.<ext>.
 * If missing, downloads the release tarball from GitHub and extracts the
 * platform binary. Returns true if the file exists (or was successfully
 * written) by the time the function returns.
 *
 * @param projectRoot Directory containing (or that should contain) a `lib/`
 *   subdirectory for the binary. Typically the package root.
 */
export async function ensureVectorExtension(
  projectRoot: string,
): Promise<boolean> {
  const libDir = join(projectRoot, "lib");
  const extFile = getPlatformExtension();
  const extPath = join(libDir, extFile);

  if (await exists(extPath)) return true;

  const assetName = detectPlatformAsset();
  if (!assetName) {
    console.warn(
      `[vec-extension] Unsupported platform (${Deno.build.os}/${Deno.build.arch}) for sqlite-vec auto-download`,
    );
    return false;
  }

  const url =
    `https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/${assetName}`;
  console.log(
    `[vec-extension] sqlite-vec extension not found. Downloading ${assetName}...`,
  );

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(
        `[vec-extension] Failed to download sqlite-vec: HTTP ${response.status}`,
      );
      return false;
    }

    await ensureDir(libDir);

    const tarData = new Uint8Array(await response.arrayBuffer());
    const decompressed = new Uint8Array(
      await new Response(
        new Response(tarData).body!.pipeThrough(
          new DecompressionStream("gzip"),
        ),
      ).arrayBuffer(),
    );

    const vec0Entry = findTarEntry(decompressed, extFile);
    if (vec0Entry === null) {
      console.error(
        "[vec-extension] Downloaded archive does not contain expected file",
      );
      return false;
    }

    await Deno.writeFile(
      extPath,
      decompressed.subarray(
        vec0Entry.dataOffset,
        vec0Entry.dataOffset + vec0Entry.size,
      ),
    );
    console.log(`[vec-extension] sqlite-vec extension installed to ${extPath}`);
    return true;
  } catch (error) {
    console.error(
      "[vec-extension] Failed to download sqlite-vec:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
