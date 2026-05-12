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
import { hashConversation } from "../dedup/content-hash.ts";
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

        const filePath = join(rawDir, file.name);
        const bytes = new Uint8Array(await file.arrayBuffer());

        // Check for duplicate filename — allow re-upload by resetting status
        const existingEntries = await readUploadManifest(packageDir);
        const existingIdx = existingEntries.findIndex((e) =>
          e.filename === file.name
        );
        if (existingIdx !== -1) {
          existingEntries[existingIdx].status = "queued";
          existingEntries[existingIdx].error = undefined;
          existingEntries[existingIdx].size = bytes.length;
          existingEntries[existingIdx].uploadedAt = new Date().toISOString();
          log("info", `Re-uploading existing file: ${file.name}`);
        }

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

        // Add to manifest
        const entry: UploadEntry = {
          filename: file.name,
          platform,
          size: bytes.length,
          uploadedAt: new Date().toISOString(),
          status: "queued",
        };
        existingEntries.push(entry);
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

          for (const entry of queuedEntries) {
            const filePath = join(packageDir, "raw", entry.filename);

            try {
              const parser = createParser(entry.platform);
              const parsed = await parser.parse(filePath);
              let skipped = 0;

              for (const conv of parsed) {
                // Skip already-processed conversations
                if (
                  checkpoint.stages.convert.processedItems.includes(conv.id)
                ) {
                  skipped++;
                  continue;
                }
                // Skip duplicates within this batch
                if (convIds.has(conv.id)) {
                  skipped++;
                  continue;
                }
                const hash = await hashConversation(conv);
                conv.metadata = conv.metadata || {};
                conv.metadata["_hash"] = hash;
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

          const existingIds = db.getExistingConversationIds();
          let conversationsStored = 0;
          let messagesStored = 0;

          for (const conv of cachedConversations) {
            if (
              existingIds.has(conv.id) ||
              checkpoint.stages.convert.processedItems.includes(conv.id)
            ) {
              continue;
            }
            const msgCount = db.writeConversation(conv);
            conversationsStored++;
            messagesStored += msgCount;
            checkpoint.stages.convert.processedItems.push(conv.id);
          }

          db.close();

          // Merge raw conversations (accumulate across batches)
          const rawPath = join(packageDir, "raw", "_loom_conversations.json");
          let existingRaw: ImportedConversation[] = [];
          try {
            const existingText = await Deno.readTextFile(rawPath);
            existingRaw = JSON.parse(existingText) as ImportedConversation[];
          } catch {
            // File doesn't exist yet — first batch
          }
          const rawIds = new Set(existingRaw.map((c) => c.id));
          const mergedRaw = [...existingRaw];
          for (const conv of cachedConversations) {
            if (!rawIds.has(conv.id)) {
              mergedRaw.push(conv);
            }
          }
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
