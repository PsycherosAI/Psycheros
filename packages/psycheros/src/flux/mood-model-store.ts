/**
 * Mood-model store — provisioning for the vad-bert variants
 * (HuggingFace-hosted, users pick the quant; explicit download-to-disk,
 * never runtime cache magic).
 *
 * Layout per variant, under the data root:
 *   .psycheros/model-cache/vad-bert-{int8|fp32}/
 *     config.json, tokenizer.json, tokenizer_config.json,
 *     special_tokens_map.json, vocab.txt, onnx/model.onnx
 *
 * Source: the project's own HuggingFace repo (settings'
 * moodClassifierRepoId — configured, never guessed) with `{variant}/`
 * subdirectories in the same layout. Files stream to disk; nothing
 * executes; the classifier loads the completed directory only.
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";

export type MoodModelVariant = "int8" | "fp32";

/** Every file a complete variant directory carries. */
const FILES: Array<{ path: string; minBytes: number }> = [
  { path: "config.json", minBytes: 200 },
  { path: "tokenizer.json", minBytes: 10_000 },
  { path: "tokenizer_config.json", minBytes: 100 },
  { path: "special_tokens_map.json", minBytes: 50 },
  { path: "vocab.txt", minBytes: 100_000 },
  { path: "onnx/model.onnx", minBytes: 50_000_000 },
];

/** The on-disk directory for a variant. */
export function moodModelDir(
  dataRoot: string,
  variant: MoodModelVariant,
): string {
  return join(
    dataRoot,
    ".psycheros",
    "model-cache",
    `vad-bert-${variant}`,
  );
}

/** Is a variant fully on disk (every file present and non-trivial)? */
export async function moodModelOnDisk(
  dataRoot: string,
  variant: MoodModelVariant,
): Promise<boolean> {
  const dir = moodModelDir(dataRoot, variant);
  for (const f of FILES) {
    try {
      const st = await Deno.stat(join(dir, f.path));
      if (!st.isFile || (st.size ?? 0) < f.minBytes) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Bytes on disk for a variant (0 when absent) — for the UI. */
export async function moodModelBytes(
  dataRoot: string,
  variant: MoodModelVariant,
): Promise<number> {
  const dir = moodModelDir(dataRoot, variant);
  let total = 0;
  for (const f of FILES) {
    try {
      const st = await Deno.stat(join(dir, f.path));
      total += st.size ?? 0;
    } catch {
      return 0;
    }
  }
  return total;
}

// =============================================================================
// Download
// =============================================================================

interface DownloadState {
  state: "downloading" | "done" | "error";
  bytes: number;
  totalBytes: number | null;
  error?: string;
}

const downloads = new Map<MoodModelVariant, DownloadState>();

/** Live download state for a variant (null when idle). */
export function moodModelDownloadState(
  variant: MoodModelVariant,
): DownloadState | null {
  return downloads.get(variant) ?? null;
}

/** Kick off a background download. Returns the rejection reason as a
 * message string on refusal; the download itself never throws. */
export async function startMoodModelDownload(
  dataRoot: string,
  variant: MoodModelVariant,
  repoId: string,
): Promise<string | null> {
  if (!repoId.trim()) {
    return "no model repository configured — set the repo id first";
  }
  if (downloads.get(variant)?.state === "downloading") {
    return `already downloading ${variant}`;
  }
  if (await moodModelOnDisk(dataRoot, variant)) {
    return `${variant} is already on disk`;
  }
  downloads.set(variant, { state: "downloading", bytes: 0, totalBytes: null });
  // Fire-and-forget: the UI polls moodModelDownloadState.
  void runDownload(dataRoot, variant, repoId.trim()).catch((error) => {
    downloads.set(variant, {
      state: "error",
      bytes: 0,
      totalBytes: null,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return null;
}

async function runDownload(
  dataRoot: string,
  variant: MoodModelVariant,
  repoId: string,
): Promise<void> {
  const dir = moodModelDir(dataRoot, variant);
  const state = downloads.get(variant)!;
  for (const f of FILES) {
    const url =
      `https://huggingface.co/${repoId}/resolve/main/${variant}/${f.path}`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`${f.path}: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get("content-length")) || null;
    state.totalBytes = total;
    await ensureDir(join(dir, f.path, ".."));
    const file = await Deno.open(join(dir, f.path) + ".part", {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      // Stream: these are 110–438MB — never buffer whole.
      const reader = res.body.getReader();
      const writer = file.writable.getWriter();
      let fileBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
          fileBytes += value.byteLength;
          state.bytes += value.byteLength;
        }
        if (fileBytes < f.minBytes) {
          throw new Error(
            `${f.path}: truncated (${fileBytes} bytes, expected ≥ ${f.minBytes})`,
          );
        }
        // writer.close() closes the UNDERLYING file handle in Deno —
        // the resource is done here; any later file.close() would
        // throw Bad resource ID.
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        throw error;
      }
    } finally {
      // Sync close; a no-op when the writer already closed the handle
      // (closing twice throws, so guard the already-closed case).
      try {
        file.close();
      } catch {
        // Already closed by the writer — nothing to do.
      }
    }
    await Deno.rename(join(dir, f.path) + ".part", join(dir, f.path));
  }
  if (!(await moodModelOnDisk(dataRoot, variant))) {
    throw new Error("download completed but verification failed");
  }
  state.state = "done";
}
