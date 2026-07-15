/**
 * Entity Loom — Convert Stage
 *
 * Multi-file upload queue with per-file platform assignment.
 * Upload files → queue them → Convert All (parse) → Confirm & Store.
 */

import { join } from "@std/path";
import type { Handler } from "../server/server.ts";
import type {
  CheckpointState,
  ImportedConversation,
  PlatformType,
  PreviewStats,
  UploadEntry,
} from "../types.ts";
import {
  createParser,
  detectPlatform,
  getRegisteredPlatforms,
} from "../parsers/mod.ts";
import { hashConversation, sha256Hex } from "../dedup/content-hash.ts";
import { CheckpointManager } from "../dedup/checkpoint.ts";
import { DBWriter } from "../writers/db-writer.ts";
import {
  buildWizardState,
  getActiveCheckpoint,
  getActiveConfig,
  getActivePackageDir,
  setActiveCheckpoint,
} from "./setup-stage.ts";
import { sse } from "../server/sse.ts";
import { log } from "../server/logger.ts";

/** In-memory cached preview data */
let cachedPreview: PreviewStats | null = null;
let cachedConversations: ImportedConversation[] | null = null;
let confirmInProgress = false;

/** Get cached parsed conversations (for staging populate) */
export function getCachedConversations(): ImportedConversation[] | null {
  return cachedConversations;
}

/** Clear cached preview data and conversations */
export function clearCachedConversations(): void {
  cachedConversations = null;
  cachedPreview = null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Compute preview stats from parsed conversations */
function computePreviewStats(
  conversations: ImportedConversation[],
): PreviewStats {
  let messageCount = 0;
  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  const conversationsByMonth: Record<string, number> = {};

  for (const conv of conversations) {
    messageCount += conv.messages.length;
    const created = conv.createdAt instanceof Date
      ? conv.createdAt.toISOString()
      : String(conv.createdAt);
    const dateStr = created.slice(0, 10);
    if (!dateFrom || dateStr < dateFrom) dateFrom = dateStr;
    if (!dateTo || dateStr > dateTo) dateTo = dateStr;

    const monthKey = dateStr.slice(0, 7);
    conversationsByMonth[monthKey] = (conversationsByMonth[monthKey] || 0) + 1;
  }

  return {
    conversationCount: conversations.length,
    messageCount,
    dateFrom,
    dateTo,
    conversationsByMonth,
  };
}

/** Read upload manifest from disk */
async function readUploadManifest(packageDir: string): Promise<UploadEntry[]> {
  const manifestPath = join(packageDir, "raw", "uploads.json");
  try {
    const text = await Deno.readTextFile(manifestPath);
    return JSON.parse(text) as UploadEntry[];
  } catch {
    return [];
  }
}

/** Write upload manifest to disk */
async function writeUploadManifest(
  packageDir: string,
  entries: UploadEntry[],
): Promise<void> {
  const manifestPath = join(packageDir, "raw", "uploads.json");
  await Deno.writeTextFile(manifestPath, JSON.stringify(entries, null, 2));
}

/**
 * Pick a non-conflicting filename when two different uploaded files share
 * the same original name. Inserts a numeric suffix before the extension:
 * `conversations.json` → `conversations.1.json`, `conversations.2.json`, ...
 *
 * Used when content hash differs but filename matches an existing entry —
 * common when a user has two ChatGPT accounts whose exports are both named
 * `conversations.json`. Without this, the second upload would silently
 * overwrite the first file on disk.
 */
function disambiguateFilename(
  original: string,
  taken: Set<string>,
): string {
  if (!taken.has(original)) return original;
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}.${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological fallback — 999 collisions on the same stem.
  return `${stem}-${Date.now()}${ext}`;
}

export function convertRoutes(): Array<
  { method: string; pattern: string | RegExp; handler: Handler }
> {
  return [
    // POST /api/convert/upload — upload export file with platform
    {
      method: "POST",
      pattern: "/api/convert/upload",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) {
          return json({ error: "No active package — run setup first" }, 400);
        }

        const formData = await req.formData();
        const file = formData.get("file");
        if (!file || !(file instanceof File)) {
          return json({ error: "No file uploaded" }, 400);
        }

        const rawDir = join(packageDir, "raw");
        await Deno.mkdir(rawDir, { recursive: true });

        const bytes = new Uint8Array(await file.arrayBuffer());
        const contentHash = await sha256Hex(bytes);

        // Dedupe by (filename, contentHash). Three cases:
        //   1. Same filename + same hash → true reupload. Replace the entry
        //      in place and overwrite the file (same bytes anyway).
        //   2. Same filename + different hash → different file that happens
        //      to share a name (e.g. two ChatGPT accounts both exporting
        //      `conversations.json`). Pick a disambiguated stored filename
        //      so both files coexist on disk.
        //   3. No filename match → fresh upload.
        const existingEntries = await readUploadManifest(packageDir);
        const takenFilenames = new Set(existingEntries.map((e) => e.filename));
        const sameNameIdx = existingEntries.findIndex((e) =>
          e.filename === file.name
        );
        const sameNameEntry = sameNameIdx !== -1
          ? existingEntries[sameNameIdx]
          : null;
        const isTrueReupload = sameNameEntry !== null &&
          sameNameEntry.contentHash === contentHash;

        let storedFilename: string;
        let replaceIdx: number | null;
        if (sameNameEntry === null) {
          storedFilename = file.name;
          replaceIdx = null;
        } else if (isTrueReupload) {
          storedFilename = file.name;
          replaceIdx = sameNameIdx;
          log("info", `Re-uploading identical file: ${file.name}`);
        } else {
          storedFilename = disambiguateFilename(file.name, takenFilenames);
          replaceIdx = null;
          log(
            "info",
            `Name "${file.name}" already used by different content — storing as ${storedFilename}`,
          );
        }

        const filePath = join(rawDir, storedFilename);
        await Deno.writeFile(filePath, bytes);

        // Auto-detect platform if not specified
        const platform = (formData.get("platform") as PlatformType | null) ||
          await detectPlatform(filePath);
        if (!platform) {
          // Clean up the file since detection failed
          try {
            await Deno.remove(filePath);
          } catch { /* ignore */ }
          return json({
            error:
              "Could not detect platform — try renaming to .json or .jsonl",
          }, 400);
        }

        const entry: UploadEntry = {
          filename: storedFilename,
          platform,
          size: bytes.length,
          uploadedAt: new Date().toISOString(),
          status: "queued",
          contentHash,
        };
        if (replaceIdx !== null) {
          existingEntries[replaceIdx] = entry;
        } else {
          existingEntries.push(entry);
        }
        await writeUploadManifest(packageDir, existingEntries);

        // Clear cached preview (new data available)
        cachedPreview = null;
        cachedConversations = null;

        log(
          "info",
          `Uploaded file: ${file.name} (${bytes.length} bytes, platform: ${platform})`,
        );
        sse.broadcast({
          type: "log",
          data: {
            level: "info",
            message: `File uploaded: ${file.name} (${platform})`,
          },
          timestamp: new Date().toISOString(),
        });

        return json({ success: true, entry });
      },
    },

    // GET /api/convert/uploads — list upload queue
    {
      method: "GET",
      pattern: "/api/convert/uploads",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ entries: [] });
        const entries = await readUploadManifest(packageDir);
        return json({ entries });
      },
    },

    // DELETE /api/convert/uploads/:filename — remove file from queue
    {
      method: "DELETE",
      pattern: /^\/api\/convert\/uploads\/(.+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const filename = decodeURIComponent(ctx.params.param1);
        const rawDir = join(packageDir, "raw");

        // Remove the file
        try {
          await Deno.remove(join(rawDir, filename));
        } catch {
          // File may not exist
        }

        // Remove from manifest
        const entries = await readUploadManifest(packageDir);
        const filtered = entries.filter((e) => e.filename !== filename);
        await writeUploadManifest(packageDir, filtered);

        // Clear cached preview
        cachedPreview = null;
        cachedConversations = null;

        log("info", `Removed upload: ${filename}`);
        return json({ success: true });
      },
    },

    // PATCH /api/convert/uploads/:filename — update platform for a queue entry
    {
      method: "PATCH",
      pattern: /^\/api\/convert\/uploads\/(.+)$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const filename = decodeURIComponent(ctx.params.param1);
        const body = await req.json() as { platform?: PlatformType };
        if (!body.platform) {
          return json({ error: "Platform is required" }, 400);
        }

        const entries = await readUploadManifest(packageDir);
        const entry = entries.find((e) => e.filename === filename);
        if (!entry) {
          return json({ error: "File not found in queue" }, 404);
        }

        entry.platform = body.platform;
        await writeUploadManifest(packageDir, entries);

        return json({ success: true, entry });
      },
    },

    // POST /api/convert/detect — auto-detect platform for a queued file
    {
      method: "POST",
      pattern: "/api/convert/detect",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { filename?: string };
        const rawDir = join(packageDir, "raw");

        // Find the file — prefer specified filename, otherwise first queued file
        let filePath: string | null = null;
        if (body.filename) {
          const candidate = join(rawDir, body.filename);
          try {
            await Deno.stat(candidate);
            filePath = candidate;
          } catch {
            // File not found
          }
        }
        if (!filePath) {
          const entries = await readUploadManifest(packageDir);
          for (const entry of entries) {
            const candidate = join(rawDir, entry.filename);
            try {
              await Deno.stat(candidate);
              filePath = candidate;
              break;
            } catch {
              // Skip missing files
            }
          }
        }
        if (!filePath) {
          return json({ error: "No file found in upload queue" }, 400);
        }

        const platform = await detectPlatform(filePath);
        log("info", `Platform detection: ${platform || "unknown"}`);

        // Update the manifest entry with detected platform
        if (platform) {
          const entries = await readUploadManifest(packageDir);
          const fileBasename = filePath.split("/").pop()!;
          for (const entry of entries) {
            if (entry.filename === fileBasename) {
              entry.platform = platform as PlatformType;
              break;
            }
          }
          await writeUploadManifest(packageDir, entries);
        }

        return json({
          platform,
          filename: filePath.split("/").pop(),
          availablePlatforms: getRegisteredPlatforms(),
        });
      },
    },

    // POST /api/convert/parse — parse ALL queued files
    {
      method: "POST",
      pattern: "/api/convert/parse",
      handler: async () => {
        const packageDir = getActivePackageDir();
        const config = getActiveConfig();
        const checkpoint = getActiveCheckpoint();
        if (!packageDir || !config || !checkpoint) {
          return json({ error: "No active package" }, 400);
        }

        const entries = await readUploadManifest(packageDir);
        const queuedEntries = entries.filter((e) => e.status === "queued");
        if (queuedEntries.length === 0) {
          return json({
            error: "No queued files to parse — upload files first",
          }, 400);
        }

        try {
          const allConversations: ImportedConversation[] = [];
          const convIds = new Set<string>();

          // Load previously-committed raw conversations so we can hash a
          // new export of an already-imported thread and tell "unchanged
          // duplicate" from "updated reimport". Without this, the ID-only
          // skip below would freeze the entity's memory of any thread at
          // whatever the first-import snapshot contained.
          const previousRawByConvId = new Map<
            string,
            ImportedConversation
          >();
          try {
            const rawText = await Deno.readTextFile(
              join(packageDir, "raw", "_loom_conversations.json"),
            );
            const prior = JSON.parse(rawText) as ImportedConversation[];
            for (const c of prior) previousRawByConvId.set(c.id, c);
          } catch {
            // No prior raw file — first import through this package.
          }

          for (const entry of queuedEntries) {
            const filePath = join(packageDir, "raw", entry.filename);

            try {
              const parser = createParser(entry.platform);
              const parsed = await parser.parse(filePath);
              let skipped = 0;

              for (const conv of parsed) {
                // Compute hash BEFORE the processed-ID check. Same ID +
                // different content means the thread grew on the source
                // platform and the user is re-importing an updated export —
                // we want to replace, not skip.
                const hash = await hashConversation(conv);
                const prior = previousRawByConvId.get(conv.id);
                const isUnchanged = prior !== undefined &&
                  prior.metadata?._hash === hash;

                if (
                  checkpoint.stages.convert.processedItems.includes(conv.id) &&
                  isUnchanged
                ) {
                  // True duplicate — same ID, same content. Skip.
                  skipped++;
                  continue;
                }
                // Skip duplicates within this batch (same conv appears in
                // two uploaded files, or twice in one file).
                if (convIds.has(conv.id)) {
                  skipped++;
                  continue;
                }
                conv.metadata = conv.metadata || {};
                conv.metadata["_hash"] = hash;
                if (prior !== undefined && !isUnchanged) {
                  conv.metadata["_updated_reimport"] = "true";
                  log(
                    "info",
                    `Updated reimport for conversation ${conv.id} (hash changed) — will replace on commit`,
                  );
                }
                convIds.add(conv.id);
                allConversations.push(conv);
              }

              entry.status = "parsed";
              log(
                "info",
                `Parsed ${parsed.length} conversations from ${entry.filename} (${skipped} skipped)`,
              );
              sse.broadcast({
                type: "log",
                data: {
                  level: "info",
                  message:
                    `Parsed ${entry.filename}: ${parsed.length} conversations (${skipped} skipped)`,
                },
                timestamp: new Date().toISOString(),
              });
            } catch (error) {
              const message = error instanceof Error
                ? error.message
                : String(error);
              entry.status = "error";
              entry.error = message;
              log("error", `Parse failed for ${entry.filename}: ${message}`);
              sse.broadcast({
                type: "log",
                data: {
                  level: "error",
                  message: `Parse failed: ${entry.filename} — ${message}`,
                },
                timestamp: new Date().toISOString(),
              });
            }
          }

          await writeUploadManifest(packageDir, entries);

          cachedConversations = allConversations;
          cachedPreview = computePreviewStats(allConversations);

          const errorEntries = entries.filter((e) => e.status === "error");
          log(
            "info",
            `Parse complete: ${allConversations.length} conversations from ${queuedEntries.length} files (${errorEntries.length} errors)`,
          );
          sse.broadcast({
            type: "log",
            data: {
              level: "info",
              message:
                `Parse complete: ${allConversations.length} total conversations`,
            },
            timestamp: new Date().toISOString(),
          });

          return json({
            success: true,
            preview: cachedPreview,
            filesParsed: queuedEntries.length - errorEntries.length,
            filesErrored: errorEntries.length,
            errors: errorEntries.map((e) => ({
              filename: e.filename,
              error: e.error,
            })),
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          log("error", `Parse failed: ${message}`);
          return json({ error: message }, 500);
        }
      },
    },

    // POST /api/convert/confirm — store all parsed conversations to chats.db
    {
      method: "POST",
      pattern: "/api/convert/confirm",
      handler: async () => {
        if (confirmInProgress) {
          return json(
            { error: "Store already in progress — please wait" },
            409,
          );
        }
        confirmInProgress = true;
        try {
          const packageDir = getActivePackageDir();
          const config = getActiveConfig();
          const checkpoint = getActiveCheckpoint();
          if (!packageDir || !config || !checkpoint) {
            return json({ error: "No active package" }, 400);
          }
          if (!cachedConversations || cachedConversations.length === 0) {
            return json(
              { error: "No parsed conversations — run parse first" },
              400,
            );
          }

          const dbPath = join(packageDir, "chats.db");
          const db = new DBWriter(dbPath);
          db.init();

          let conversationsStored = 0;
          let messagesStored = 0;
          const updatedConvIds: string[] = [];

          for (const conv of cachedConversations) {
            const wasAlreadyProcessed = checkpoint.stages.convert.processedItems
              .includes(conv.id);
            const isMarkedUpdate =
              conv.metadata?.["_updated_reimport"] === "true";

            // db.writeConversation() handles both insert and replace via
            // ON CONFLICT — we don't gate on existingIds anymore. A conv
            // that's already in chats.db with the same content was already
            // filtered out at parse time, so anything reaching here is
            // either fresh or a content-updated reimport.
            const msgCount = db.writeConversation(conv);
            conversationsStored++;
            messagesStored += msgCount;

            if (wasAlreadyProcessed) {
              // Tracking: this is a replace of a previously-stored conv.
              if (isMarkedUpdate) updatedConvIds.push(conv.id);
              // Don't push the ID again — it's already in processedItems.
            } else {
              checkpoint.stages.convert.processedItems.push(conv.id);
            }
          }

          db.close();

          // For any conversation we just replaced, drop it from the
          // significant stage's processedItems so a future Significant run
          // picks up the new content. The entity's existing significant
          // memory for that thread may be stale; re-running the stage is
          // the user's call, but we make sure the stage will actually
          // re-process if invoked.
          if (updatedConvIds.length > 0) {
            const sigSet = new Set(updatedConvIds);
            const before = checkpoint.stages.significant.processedItems.length;
            checkpoint.stages.significant.processedItems = checkpoint.stages
              .significant.processedItems.filter((id) => !sigSet.has(id));
            const removed = before -
              checkpoint.stages.significant.processedItems.length;
            if (removed > 0) {
              log(
                "info",
                `Reset ${removed} significant-stage processed entries for re-imported conversations`,
              );
            }
          }

          // Replace any updated raw conversations in _loom_conversations.json
          // (not just append — the old snapshot is stale once we have a new
          // export with different content).
          const rawPath = join(packageDir, "raw", "_loom_conversations.json");
          let existingRaw: ImportedConversation[] = [];
          try {
            const existingText = await Deno.readTextFile(rawPath);
            existingRaw = JSON.parse(existingText) as ImportedConversation[];
          } catch {
            // File doesn't exist yet — first batch
          }
          // Replace any existing raw entry with the same ID, then append
          // truly new ones. A reimport with changed content needs to
          // overwrite the stale snapshot so future runs hash against the
          // most recent committed version.
          const incomingIds = new Set(cachedConversations.map((c) => c.id));
          const mergedRaw = existingRaw.filter((c) => !incomingIds.has(c.id));
          mergedRaw.push(...cachedConversations);
          await Deno.writeTextFile(rawPath, JSON.stringify(mergedRaw));

          // Mark all parsed uploads as stored
          const entries = await readUploadManifest(packageDir);
          for (const entry of entries) {
            if (entry.status === "parsed") {
              entry.status = "stored";
            }
          }
          await writeUploadManifest(packageDir, entries);

          // Mark convert stage as completed
          checkpoint.stages.convert.status = "completed";
          checkpoint.stages.convert.completed = true;
          if (
            checkpoint.currentStage === "setup" ||
            checkpoint.currentStage === "convert"
          ) {
            checkpoint.currentStage = "significant";
          }
          setActiveCheckpoint(checkpoint);

          // Save checkpoint
          const checkpointMgr = new CheckpointManager(packageDir);
          await checkpointMgr.save(checkpoint as unknown as CheckpointState);

          log(
            "info",
            `Stored ${conversationsStored} conversations (${messagesStored} messages)`,
          );
          sse.broadcast({
            type: "stage_completed",
            stage: "convert",
            data: { conversationsStored, messagesStored },
            timestamp: new Date().toISOString(),
          });

          return json({
            success: true,
            conversationsStored,
            messagesStored,
            state: buildWizardState(),
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          log("error", `Store failed: ${message}`);
          return json({ error: message }, 500);
        } finally {
          confirmInProgress = false;
        }
      },
    },

    // GET /api/convert/preview — cached preview stats
    {
      method: "GET",
      pattern: "/api/convert/preview",
      handler: async () => {
        if (!cachedPreview) {
          return json({ error: "No preview available — run parse first" }, 400);
        }
        return json({ preview: cachedPreview });
      },
    },
  ];
}
