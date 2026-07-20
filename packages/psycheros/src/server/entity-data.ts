/**
 * Entity Data Export & Import
 *
 * Orchestrates full export and import of entity data across both
 * entity-core (identity, memories, knowledge graph) and Psycheros
 * (conversations, lorebooks, vault, images).
 *
 * @module
 */

import JSZip from "jszip";
import { isPluginSecretFilename } from "../../../plugin-api/src/mod.ts";
import { isAbsolute, join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { RouteContext } from "./routes.ts";
import type { MCPClient } from "../mcp-client/mod.ts";

/**
 * Convert a Uint8Array to base64 without blowing the call stack.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Progress event emitted during entity data import.
 * Passed via the `onProgress` callback to `importEntityData()`.
 */
export interface ImportProgressEvent {
  phase: string;
  status: string;
  current?: number;
  total?: number;
}

export interface ImportResult {
  success: boolean;
  error?: string;
  details?: {
    psycheros: {
      conversations_restored?: number;
      messages_restored?: number;
      lorebooks_restored?: number;
      lorebook_entries_restored?: number;
      pulses_restored?: number;
      vault_documents_restored?: number;
      images_restored?: number;
      anchor_images_restored?: number;
      anchor_files_restored?: number;
      chat_attachment_files_restored?: number;
      custom_tool_files_restored?: number;
      background_files_restored?: number;
      plugins_restored?: number;
      plugin_restart_required?: boolean;
    };
    entity_core?: {
      success: boolean;
      error?: string;
    };
    sync_pull?: boolean;
  };
}

/**
 * Helper: run a SELECT and return all rows.
 */
function queryAll<T extends Record<string, unknown>>(
  ctx: RouteContext,
  sql: string,
): T[] {
  const db = ctx.db.getRawDb();
  const stmt = db.prepare(sql);
  const rows = stmt.all<T>();
  stmt.finalize();
  return rows;
}

/**
 * Helper: run a parameterized write statement.
 */
function execSql(
  ctx: RouteContext,
  sql: string,
  params: (string | number | null | Uint8Array)[] = [],
): void {
  if (params.length === 0) {
    ctx.db.getRawDb().exec(sql);
  } else {
    ctx.db.getRawDb().exec(sql, params);
  }
}

function isSafeArchivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").some((part) => part === ".." || part === "");
}

async function addDirectoryToZip(
  zip: JSZip,
  sourceDir: string,
  archivePrefix: string,
  includeFile: (path: string) => boolean = () => true,
): Promise<number> {
  let count = 0;
  try {
    for await (const entry of Deno.readDir(sourceDir)) {
      const diskPath = join(sourceDir, entry.name);
      const archivePath = `${archivePrefix}/${entry.name}`;
      if (entry.isDirectory) {
        count += await addDirectoryToZip(
          zip,
          diskPath,
          archivePath,
          includeFile,
        );
      } else if (entry.isFile && includeFile(archivePath)) {
        zip.file(archivePath, await Deno.readFile(diskPath));
        count++;
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return count;
}

/**
 * Try to collect entity-core export data via MCP, with one retry after a
 * restart if the first attempt fails.
 */
async function collectEntityCoreData(
  ctx: RouteContext,
  zip: JSZip,
): Promise<{ manifest?: Record<string, unknown>; error?: string }> {
  const mcp = ctx.mcpClient;

  // No MCP client at all — MCP is intentionally disabled
  if (!mcp) {
    return {
      error:
        "MCP is not enabled. Enable MCP to include entity-core data in exports.",
    };
  }

  const tryCollect = async (): Promise<
    { manifest?: Record<string, unknown>; error?: string }
  > => {
    if (!mcp.isConnected()) {
      return { error: "MCP is not connected" };
    }
    try {
      const result = await callMcpTool(mcp, "entity_export", {});
      if (result) {
        const parsed = JSON.parse(result);
        if (parsed.success && parsed.data) {
          const zipBytes = Uint8Array.from(
            atob(parsed.data),
            (c) => c.charCodeAt(0),
          );
          const coreZip = await JSZip.loadAsync(zipBytes);

          for (const [path, file] of Object.entries(coreZip.files)) {
            if (file.dir) continue;
            const content = await file.async("uint8array");
            zip.file(path, content);
          }

          const manifestFile = coreZip.file("manifest.json");
          if (manifestFile) {
            return { manifest: JSON.parse(await manifestFile.async("string")) };
          }
          return { manifest: undefined };
        }
      }
      return { error: "entity_export returned no usable data" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  };

  // Attempt 1
  const first = await tryCollect();
  if (!first.error) return first;

  // Attempt 2: restart MCP and retry
  console.warn(
    "[EntityData] entity-core export failed, restarting MCP for retry:",
    first.error,
  );
  try {
    const restarted = await mcp.restart();
    if (restarted) {
      const second = await tryCollect();
      if (!second.error) return second;
      return { error: `entity-core unavailable after retry: ${second.error}` };
    }
    return {
      error:
        `entity-core unavailable: MCP restart failed (original error: ${first.error})`,
    };
  } catch (restartErr) {
    const msg = restartErr instanceof Error
      ? restartErr.message
      : String(restartErr);
    return {
      error:
        `entity-core unavailable: MCP restart threw (${msg}; original error: ${first.error})`,
    };
  }
}

export interface ExportResult {
  zipBytes: Uint8Array;
  entityCoreError?: string;
}

/**
 * Export all entity data as a zip file.
 *
 * Calls entity-core's entity_export tool via MCP (with automatic restart+retry
 * on failure), then adds Psycheros-specific data (conversations, lorebooks,
 * vault, images). Returns both the zip bytes and any entity-core error so the
 * caller can decide how to surface it.
 */
export async function exportEntityData(
  ctx: RouteContext,
  options?: { skipEntityCore?: boolean },
): Promise<ExportResult> {
  const zip = new JSZip();

  // --- entity-core data via MCP ---
  let entityCoreManifest: Record<string, unknown> | undefined;
  let entityCoreError: string | undefined;

  if (!options?.skipEntityCore) {
    const coreResult = await collectEntityCoreData(ctx, zip);
    entityCoreManifest = coreResult.manifest;
    entityCoreError = coreResult.error;
    if (entityCoreError) {
      console.error("[EntityData] entity-core export failed:", entityCoreError);
    }
  }

  // --- Psycheros data ---
  let conversationCount = 0;
  let messageCount = 0;
  let lorebookCount = 0;
  let lorebookEntryCount = 0;
  let vaultDocCount = 0;
  let imageCount = 0;
  let pulseCount = 0;
  let anchorFileCount = 0;
  let chatAttachmentFileCount = 0;
  let customToolFileCount = 0;
  let backgroundFileCount = 0;
  let pluginFileCount = 0;

  // Conversations + messages
  const conversations = queryAll<
    { id: string; title: string | null; created_at: string; updated_at: string }
  >(
    ctx,
    "SELECT id, title, created_at, updated_at FROM conversations ORDER BY created_at",
  );
  conversationCount = conversations.length;

  const convMap = new Map<string, Array<Record<string, unknown>>>();
  for (const conv of conversations) {
    convMap.set(conv.id, []);
  }

  const messages = queryAll<
    {
      id: string;
      conversation_id: string;
      role: string;
      content: string;
      reasoning_content: string | null;
      tool_call_id: string | null;
      tool_calls: string | null;
      created_at: string;
      is_voice: number | null;
      edited_at: string | null;
      pulse_id: string | null;
      pulse_name: string | null;
      metadata: string | null;
    }
  >(
    ctx,
    "SELECT id, conversation_id, role, content, reasoning_content, tool_call_id, tool_calls, created_at, is_voice, edited_at, pulse_id, pulse_name, metadata FROM messages ORDER BY conversation_id, created_at",
  );
  messageCount = messages.length;

  for (const msg of messages) {
    const list = convMap.get(msg.conversation_id);
    if (list) {
      list.push({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        reasoning_content: msg.reasoning_content,
        tool_call_id: msg.tool_call_id,
        tool_calls: msg.tool_calls,
        created_at: msg.created_at,
        is_voice: msg.is_voice ?? 0,
        edited_at: msg.edited_at,
        pulse_id: msg.pulse_id,
        pulse_name: msg.pulse_name,
        metadata: msg.metadata,
      });
    }
  }

  const conversationsJson = conversations.map((conv) => ({
    id: conv.id,
    title: conv.title,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    messages: convMap.get(conv.id) || [],
  }));
  zip.file(
    "psycheros/conversations.json",
    JSON.stringify(conversationsJson, null, 2),
  );

  // Lorebooks
  const lorebooks = queryAll<
    {
      id: string;
      name: string;
      description: string | null;
      enabled: number;
      created_at: string;
      updated_at: string;
    }
  >(
    ctx,
    "SELECT id, name, description, enabled, created_at, updated_at FROM lorebooks ORDER BY created_at",
  );
  lorebookCount = lorebooks.length;

  const lorebookEntries = queryAll<
    {
      id: string;
      book_id: string;
      name: string;
      content: string;
      triggers: string;
      trigger_mode: string;
      case_sensitive: number;
      sticky: number;
      sticky_duration: number;
      non_recursable: number;
      prevent_recursion: number;
      re_trigger_resets_timer: number;
      enabled: number;
      priority: number;
      scan_depth: number;
      max_tokens: number;
      created_at: string;
      updated_at: string;
    }
  >(ctx, "SELECT * FROM lorebook_entries ORDER BY created_at");
  lorebookEntryCount = lorebookEntries.length;

  const lorebooksJson = lorebooks.map((lb) => ({
    ...lb,
    entries: lorebookEntries.filter((e) => e.book_id === lb.id),
  }));
  zip.file("psycheros/lorebooks.json", JSON.stringify(lorebooksJson, null, 2));

  // Pulses — use SELECT * so the dump survives future column additions
  // without needing to maintain a column list here. The pulses table has
  // ~20 columns covering prompt, trigger config, scheduling, chaining.
  const pulses = queryAll<Record<string, unknown>>(
    ctx,
    "SELECT * FROM pulses ORDER BY created_at",
  );
  pulseCount = pulses.length;
  zip.file("psycheros/pulses.json", JSON.stringify(pulses, null, 2));

  // Anchor images
  const anchorImages = queryAll<
    {
      id: string;
      label: string;
      description: string;
      filename: string;
      file_size: number;
      created_at: string;
    }
  >(ctx, "SELECT * FROM anchor_images ORDER BY created_at");
  zip.file(
    "psycheros/anchor-images.json",
    JSON.stringify(anchorImages, null, 2),
  );

  // Vault documents (all scopes)
  const vaultDocs = queryAll<
    {
      id: string;
      title: string;
      filename: string;
      file_type: string;
      scope: string;
      conversation_id: string | null;
      file_path: string;
      file_size: number;
      content_hash: string;
      chunk_count: number;
      source: string;
      enabled: number;
      created_at: string;
      updated_at: string;
    }
  >(
    ctx,
    "SELECT * FROM vault_documents ORDER BY created_at",
  );
  vaultDocCount = vaultDocs.length;

  if (vaultDocs.length > 0) {
    const vaultFolder = zip.folder("psycheros/vault")!;
    for (const doc of vaultDocs) {
      // file_path may be absolute (seed/upload) or dataRoot-relative
      // (import). `join` concatenates two absolutes, so branch.
      const fullPath = isAbsolute(doc.file_path)
        ? doc.file_path
        : join(ctx.dataRoot, doc.file_path);
      try {
        const bytes = await Deno.readFile(fullPath);
        vaultFolder.file(doc.filename, bytes);
      } catch (err) {
        console.error(
          `[entity-data] Vault file missing during export, skipping: ${fullPath}`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Preserve full metadata so import can reconstruct with correct
    // scope, conversation_id, title, etc. Normalize file_path: the DB
    // value may be absolute (seed/upload), which leaks the user's home
    // directory name and is meaningless on another machine. Emit the
    // canonical relative path the importer reconstructs anyway.
    const sanitizedDocs = vaultDocs.map((doc) => ({
      ...doc,
      file_path: join(
        ".psycheros",
        "vault",
        "documents",
        doc.scope ?? "global",
        doc.filename,
      ),
    }));
    zip.file(
      "psycheros/vault-metadata.json",
      JSON.stringify(sanitizedDocs, null, 2),
    );
  }

  // Generated images
  const generatedImagesDir = join(
    ctx.dataRoot,
    ".psycheros",
    "generated-images",
  );
  const imagesFolder = zip.folder("psycheros/images")!;
  try {
    for await (const entry of Deno.readDir(generatedImagesDir)) {
      if (!entry.isFile) continue;
      const filePath = join(generatedImagesDir, entry.name);
      try {
        const bytes = await Deno.readFile(filePath);
        imagesFolder.file(entry.name, bytes);
        imageCount++;
      } catch (err) {
        console.error(
          `[entity-data] Image file unreadable during export, skipping: ${filePath}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch {
    // generated-images directory absent — nothing to export
  }

  pluginFileCount = await addDirectoryToZip(
    zip,
    join(ctx.dataRoot, ".psycheros", "plugins"),
    "psycheros/plugins",
    (path) => !isPluginSecretFilename(path),
  );

  // Anchor image files — the DB rows are exported above as anchor-images.json,
  // but the binary files in .psycheros/anchors/ were previously dropped on
  // export. Without them, generate_image fails at readFile() for any
  // anchor_id after import.
  anchorFileCount = await addDirectoryToZip(
    zip,
    join(ctx.dataRoot, ".psycheros", "anchors"),
    "psycheros/anchors",
  );

  // Chat attachments — referenced from user messages via
  // [USER_IMAGE: /chat-attachments/<filename> ...]. Missing files break
  // those references on re-import.
  chatAttachmentFileCount = await addDirectoryToZip(
    zip,
    join(ctx.dataRoot, ".psycheros", "chat-attachments"),
    "psycheros/chat-attachments",
  );

  // Custom tools — user-installed tool JS files. Without these, custom
  // tools silently vanish on import (the DB has no record of them; they
  // live entirely on disk).
  customToolFileCount = await addDirectoryToZip(
    zip,
    join(ctx.dataRoot, ".psycheros", "custom-tools"),
    "psycheros/custom-tools",
  );

  // Background images — cosmetic, but a user's chosen background should
  // survive a backup/restore cycle.
  backgroundFileCount = await addDirectoryToZip(
    zip,
    join(ctx.dataRoot, ".psycheros", "backgrounds"),
    "psycheros/backgrounds",
  );

  // Build manifest
  const manifest: Record<string, unknown> = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    parts: {
      entity_core: entityCoreManifest
        ? (entityCoreManifest.parts as Record<string, unknown>)?.entity_core
        : false,
      ...(options?.skipEntityCore ? { entity_core_skipped: true } : {}),
      psycheros: {
        conversations: true,
        lorebooks: true,
        pulses: true,
        vault: true,
        images: true,
        plugins: true,
        anchors: true,
        chat_attachments: true,
        custom_tools: true,
        backgrounds: true,
      },
    },
    counts: {
      ...(entityCoreManifest?.counts || {}),
      conversations: conversationCount,
      messages: messageCount,
      lorebooks: lorebookCount,
      lorebook_entries: lorebookEntryCount,
      pulses: pulseCount,
      vault_documents: vaultDocCount,
      images: imageCount,
      plugin_files: pluginFileCount,
      anchor_files: anchorFileCount,
      chat_attachment_files: chatAttachmentFileCount,
      custom_tool_files: customToolFileCount,
      background_files: backgroundFileCount,
    },
  };

  if (entityCoreError && !options?.skipEntityCore) {
    manifest.entity_core_error = entityCoreError;
  }

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const zipBytes = await zip.generateAsync({ type: "uint8array" });
  return { zipBytes, entityCoreError };
}

/**
 * Detect a single top-level wrapper folder around the expected export
 * structure. Some Windows workflows (right-click → "Send to → Compressed
 * folder" on an extracted folder) and certain cloud-sync tools wrap exports
 * one level deep — `manifest.json` ends up at `<wrapper>/manifest.json`
 * instead of `/manifest.json`, and the importer's root-manifest lookup fails.
 * Detect and strip.
 *
 * Returns the wrapper prefix (e.g. `"export-folder/"`) when there is exactly
 * one top-level folder containing `manifest.json`, otherwise null.
 */
function detectWrapperPrefix(zip: JSZip): string | null {
  const entries = Object.entries(zip.files);
  // Any file at the root means the layout isn't wrapper-only.
  if (entries.some(([path, file]) => !file.dir && !path.includes("/"))) {
    return null;
  }
  const topLevel = new Set<string>();
  for (const [path, file] of entries) {
    if (file.dir) continue;
    const idx = path.indexOf("/");
    if (idx === -1) continue;
    topLevel.add(path.slice(0, idx + 1));
  }
  if (topLevel.size !== 1) return null;
  const prefix = [...topLevel][0];
  if (!zip.file(`${prefix}manifest.json`)) return null;
  return prefix;
}

/**
 * Strip a wrapper folder if one is detected, otherwise return the original
 * zip. Re-builds without the prefix so the rest of the importer can use
 * root-relative paths unchanged.
 */
async function unwrapSingletonFolder(zip: JSZip): Promise<JSZip> {
  const prefix = detectWrapperPrefix(zip);
  if (!prefix) return zip;
  console.log(
    `[entity-data] Wrapper folder "${prefix}" detected — stripping.`,
  );
  const cleaned = new JSZip();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !path.startsWith(prefix)) continue;
    const content = await file.async("uint8array");
    cleaned.file(path.slice(prefix.length), content);
  }
  return cleaned;
}

/**
 * Import entity data from a zip file.
 *
 * Imports Psycheros data directly, and sends entity-core data
 * via MCP entity_import tool.
 */
export async function importEntityData(
  ctx: RouteContext,
  zipData: Uint8Array,
  onProgress?: (event: ImportProgressEvent) => Promise<void>,
): Promise<ImportResult> {
  const importStart = Date.now();

  // Helper to emit progress and yield to the event loop.
  const progress = async (event: ImportProgressEvent) => {
    if (onProgress) await onProgress(event);
  };
  // Yield to the event loop so /health and other endpoints stay responsive
  // during heavy synchronous SQLite operations.
  const yieldLoop = () => new Promise<void>((r) => setTimeout(r, 0));

  console.log(
    "[entity-data] Starting import, zip size:",
    (zipData.length / 1024 / 1024).toFixed(2),
    "MB",
  );
  try {
    const rawZip = await JSZip.loadAsync(zipData);
    const zip = await unwrapSingletonFolder(rawZip);
    console.log(
      "[entity-data] Zip parsed, file count:",
      Object.keys(zip.files).length,
    );

    // Validate manifest
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) {
      return {
        success: false,
        error: "Invalid export package: missing manifest.json",
      };
    }
    const manifest = JSON.parse(await manifestFile.async("string"));
    if (manifest.schema_version !== 1) {
      return {
        success: false,
        error: `Unsupported schema version: ${manifest.schema_version}`,
      };
    }

    await progress({ phase: "validate", status: "Package validated." });

    const details: ImportResult["details"] = {
      psycheros: {},
    };

    const psycherosParts = manifest.parts?.psycheros ?? {};
    const entityCoreParts = manifest.parts?.entity_core ?? {};

    // --- Import Psycheros data ---

    // Conversations + messages
    if (psycherosParts.conversations) {
      const convFile = zip.file("psycheros/conversations.json");
      if (convFile) {
        const conversations = JSON.parse(
          await convFile.async("string"),
        ) as Array<{
          id: string;
          title: string | null;
          created_at: string;
          updated_at: string;
          messages: Array<Record<string, unknown>>;
        }>;

        await progress({
          phase: "conversations",
          status: "Clearing existing conversations...",
          total: conversations.length,
        });
        await yieldLoop();

        // Clear existing (messages cascade via FK)
        execSql(ctx, "DELETE FROM lorebook_state");
        execSql(ctx, "DELETE FROM context_snapshots");
        execSql(ctx, "DELETE FROM turn_metrics");
        execSql(ctx, "DELETE FROM summarized_chats");
        execSql(ctx, "DELETE FROM messages");
        execSql(ctx, "DELETE FROM conversations");

        let messageTotal = 0;
        for (let ci = 0; ci < conversations.length; ci++) {
          const conv = conversations[ci];
          execSql(
            ctx,
            "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            [conv.id, conv.title, conv.created_at, conv.updated_at],
          );

          for (const msg of conv.messages) {
            const m = msg as Record<string, unknown>;
            // Resolve is_voice: modern backups include the field; old
            // backups detect via [Voice Chat] prefix in content.
            const hasIsVoiceField = typeof m.is_voice === "number";
            const detectedVoice = hasIsVoiceField
              ? (m.is_voice as number)
              : (typeof m.content === "string" &&
                  m.content.startsWith("[Voice Chat] ")
                ? 1
                : 0);
            const cleanContent = hasIsVoiceField
              ? String(m.content)
              : (detectedVoice === 1 && typeof m.content === "string"
                ? m.content.slice("[Voice Chat] ".length)
                : String(m.content));
            // Newer columns default to null on old exports — preserves
            // round-trip fidelity for fresh backups while keeping legacy
            // imports working without forcing a re-export.
            execSql(
              ctx,
              `INSERT OR IGNORE INTO messages
                (id, conversation_id, role, content, reasoning_content, tool_call_id, tool_calls, created_at, is_voice, edited_at, pulse_id, pulse_name, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                String(m.id),
                conv.id,
                String(m.role),
                cleanContent,
                m.reasoning_content != null
                  ? String(m.reasoning_content)
                  : null,
                m.tool_call_id != null ? String(m.tool_call_id) : null,
                m.tool_calls != null ? String(m.tool_calls) : null,
                String(m.created_at),
                detectedVoice,
                m.edited_at != null ? String(m.edited_at) : null,
                m.pulse_id != null ? String(m.pulse_id) : null,
                m.pulse_name != null ? String(m.pulse_name) : null,
                m.metadata != null ? String(m.metadata) : null,
              ],
            );
            messageTotal++;
          }

          // Yield every 50 conversations to keep /health responsive
          if (ci > 0 && ci % 50 === 0) {
            await progress({
              phase: "conversations",
              status: "Importing conversations...",
              current: ci + 1,
              total: conversations.length,
            });
            await yieldLoop();
          }
        }

        details.psycheros.conversations_restored = conversations.length;
        details.psycheros.messages_restored = messageTotal;
      }
    }

    // Lorebooks
    if (psycherosParts.lorebooks) {
      const lorebooksFile = zip.file("psycheros/lorebooks.json");
      if (lorebooksFile) {
        const lorebooks = JSON.parse(
          await lorebooksFile.async("string"),
        ) as Array<
          Record<string, unknown> & { entries?: Array<Record<string, unknown>> }
        >;

        await progress({
          phase: "lorebooks",
          status: "Clearing existing lorebooks...",
          total: lorebooks.length,
        });
        await yieldLoop();

        execSql(ctx, "DELETE FROM lorebook_state");
        execSql(ctx, "DELETE FROM lorebook_entries");
        execSql(ctx, "DELETE FROM lorebooks");

        let entryTotal = 0;
        for (const lb of lorebooks) {
          const entries = lb.entries || [];
          // Remove entries from the lorebook object before insert
          const { entries: _entries, ...lbData } = lb;
          const d = lbData as Record<string, unknown>;

          execSql(
            ctx,
            "INSERT OR IGNORE INTO lorebooks (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [
              String(d.id),
              String(d.name),
              d.description != null ? String(d.description) : null,
              Number(d.enabled ?? 1),
              String(d.created_at),
              String(d.updated_at),
            ],
          );

          for (const entry of entries) {
            const e = entry as Record<string, unknown>;
            execSql(
              ctx,
              `INSERT OR IGNORE INTO lorebook_entries
                (id, book_id, name, content, triggers, trigger_mode, case_sensitive,
                 sticky, sticky_duration, non_recursable, prevent_recursion,
                 re_trigger_resets_timer, enabled, priority, scan_depth, max_tokens,
                 created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                String(e.id),
                String(e.book_id),
                String(e.name),
                String(e.content),
                String(e.triggers),
                String(e.trigger_mode ?? "substring"),
                Number(e.case_sensitive ?? 0),
                Number(e.sticky ?? 0),
                Number(e.sticky_duration ?? 0),
                Number(e.non_recursable ?? 0),
                Number(e.prevent_recursion ?? 0),
                Number(e.re_trigger_resets_timer ?? 1),
                Number(e.enabled ?? 1),
                Number(e.priority ?? 0),
                Number(e.scan_depth ?? 5),
                Number(e.max_tokens ?? 0),
                String(e.created_at),
                String(e.updated_at),
              ],
            );
            entryTotal++;
          }
        }

        await progress({
          phase: "lorebooks",
          status: "Lorebooks imported.",
          current: lorebooks.length,
          total: lorebooks.length,
        });

        details.psycheros.lorebooks_restored = lorebooks.length;
        details.psycheros.lorebook_entries_restored = entryTotal;
      }
    }

    // Pulses — restore from psycheros/pulses.json. Column intersection
    // against the destination schema so old exports (missing newly-added
    // columns) and new exports (with columns the destination doesn't know)
    // both import cleanly. Missing columns fall back to schema defaults.
    if (psycherosParts.pulses) {
      const pulsesFile = zip.file("psycheros/pulses.json");
      if (pulsesFile) {
        await progress({
          phase: "pulses",
          status: "Restoring pulses...",
        });
        const pulses = JSON.parse(await pulsesFile.async("string")) as Array<
          Record<string, unknown>
        >;

        if (pulses.length > 0) {
          // Intersect JSON keys with destination table columns so the
          // INSERT is robust to schema drift in either direction.
          const destCols = queryAll<{ name: string }>(
            ctx,
            "PRAGMA table_info(pulses)",
          ).map((r) => r.name);
          const jsonCols = Object.keys(pulses[0]);
          const commonCols = jsonCols.filter((c) => destCols.includes(c));

          if (commonCols.length > 0) {
            const placeholders = commonCols.map(() => "?").join(", ");
            const sql = `INSERT OR REPLACE INTO pulses (${
              commonCols.join(", ")
            }) VALUES (${placeholders})`;
            for (const p of pulses) {
              execSql(
                ctx,
                sql,
                commonCols.map((c): string | number | null => {
                  const v = p[c];
                  if (v === null || v === undefined) return null;
                  if (typeof v === "number") return v;
                  if (typeof v === "string") return v;
                  // Arrays / objects must be stringified — pulses columns
                  // like chain_pulse_ids are TEXT in the schema.
                  return JSON.stringify(v);
                }),
              );
            }
          }
        }

        await progress({
          phase: "pulses",
          status: "Pulses imported.",
          current: pulses.length,
          total: pulses.length,
        });

        details.psycheros.pulses_restored = pulses.length;
      }
    }

    // Vault documents (all scopes)
    if (psycherosParts.vault) {
      const vaultPrefix = "psycheros/vault/";

      await progress({
        phase: "vault",
        status: "Clearing existing vault documents...",
      });
      await yieldLoop();

      // Clear existing vault chunks and documents
      execSql(ctx, "DELETE FROM vault_chunks");
      execSql(ctx, "DELETE FROM vault_documents");

      // Read metadata if available (preserves scope, conversation_id, etc.)
      const metadataFile = zip.file("psycheros/vault-metadata.json");
      const metadata = metadataFile
        ? JSON.parse(await metadataFile.async("string")) as Array<
          Record<string, unknown>
        >
        : null;
      const metadataMap = metadata
        ? new Map(metadata.map((d) => [String(d.filename), d]))
        : null;

      // Ensure scope subdirectories exist
      const scopeDirs = new Set<string>();
      if (metadataMap) {
        for (const doc of metadataMap.values()) {
          scopeDirs.add(String(doc.scope ?? "global"));
        }
      } else {
        scopeDirs.add("global");
      }
      for (const scope of scopeDirs) {
        await ensureDir(
          join(ctx.dataRoot, ".psycheros", "vault", "documents", scope),
        );
      }

      let docCount = 0;
      for (const [filename, file] of Object.entries(zip.files)) {
        if (file.dir || !filename.startsWith(vaultPrefix)) continue;
        const basename = filename.slice(vaultPrefix.length);
        if (!basename || basename.includes("/")) continue;
        // Skip metadata file
        if (basename === "vault-metadata.json") continue;

        const meta = metadataMap?.get(basename);
        const scope = meta ? String(meta.scope ?? "global") : "global";
        const scopeDir = join(
          ctx.dataRoot,
          ".psycheros",
          "vault",
          "documents",
          scope,
        );
        await ensureDir(scopeDir);

        const bytes = await file.async("uint8array");
        await Deno.writeFile(join(scopeDir, basename), bytes);

        if (meta) {
          // Restore with original metadata
          execSql(
            ctx,
            `INSERT INTO vault_documents
                (id, title, filename, file_type, scope, conversation_id, file_path, file_size, content_hash, chunk_count, source, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              String(meta.id ?? `vault-import-${docCount}`),
              String(meta.title ?? basename),
              String(meta.filename ?? basename),
              String(meta.file_type ?? "unknown"),
              scope,
              meta.conversation_id ? String(meta.conversation_id) : null,
              join(".psycheros", "vault", "documents", scope, basename),
              bytes.length,
              String(meta.content_hash ?? ""),
              Number(meta.chunk_count ?? 0),
              String(meta.source ?? "upload"),
              Number(meta.enabled ?? 1),
              String(meta.created_at ?? new Date().toISOString()),
              String(meta.updated_at ?? new Date().toISOString()),
            ],
          );
        } else {
          // No metadata — insert with defaults
          const ext = basename.split(".").pop()?.toLowerCase() || "unknown";
          const id = `vault-import-${docCount}`;
          const title = basename.replace(/\.[^.]+$/, "").replace(
            /^vault_\d{4}-\d{2}-\d{2}_/,
            "",
          );
          const now = new Date().toISOString();

          execSql(
            ctx,
            `INSERT INTO vault_documents
                (id, title, filename, file_type, scope, file_path, file_size, content_hash, chunk_count, source, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, 'upload', 1, ?, ?)`,
            [
              id,
              title,
              basename,
              ext,
              scope,
              join(".psycheros", "vault", "documents", scope, basename),
              bytes.length,
              now,
              now,
            ],
          );
        }

        docCount++;
        if (docCount % 50 === 0) await yieldLoop();
      }

      await progress({
        phase: "vault",
        status: "Vault documents restored.",
        current: docCount,
        total: docCount,
      });
      details.psycheros.vault_documents_restored = docCount;
    }

    // Images
    if (psycherosParts.images) {
      const imagesPrefix = "psycheros/images/";
      const generatedDir = join(
        ctx.dataRoot,
        ".psycheros",
        "generated-images",
      );
      await ensureDir(generatedDir);

      await progress({ phase: "images", status: "Restoring images..." });
      await yieldLoop();

      let imgCount = 0;
      for (const [filename, file] of Object.entries(zip.files)) {
        if (file.dir || !filename.startsWith(imagesPrefix)) continue;
        const basename = filename.slice(imagesPrefix.length);
        if (!basename || basename.includes("/")) continue;

        const bytes = await file.async("uint8array");
        await Deno.writeFile(join(generatedDir, basename), bytes);
        imgCount++;
        if (imgCount % 50 === 0) await yieldLoop();
      }

      await progress({
        phase: "images",
        status: "Images restored.",
        current: imgCount,
        total: imgCount,
      });
      details.psycheros.images_restored = imgCount;
    }

    // Anchor images
    {
      const anchorFile = zip.file("psycheros/anchor-images.json");
      if (anchorFile) {
        await progress({
          phase: "anchors",
          status: "Restoring anchor images...",
        });
        const anchors = JSON.parse(await anchorFile.async("string")) as Array<
          Record<string, unknown>
        >;

        execSql(ctx, "DELETE FROM anchor_images");

        for (const anchor of anchors) {
          const a = anchor as Record<string, unknown>;
          execSql(
            ctx,
            "INSERT OR IGNORE INTO anchor_images (id, label, description, filename, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [
              String(a.id),
              String(a.label),
              String(a.description ?? ""),
              String(a.filename),
              Number(a.file_size),
              String(a.created_at),
            ],
          );
        }

        details.psycheros.anchor_images_restored = anchors.length;
      }
    }

    if (psycherosParts.plugins) {
      const pluginsPrefix = "psycheros/plugins/";
      const pluginsDir = join(ctx.dataRoot, ".psycheros", "plugins");
      await progress({
        phase: "plugins",
        status: "Restoring trusted local plugins...",
      });
      await Deno.remove(pluginsDir, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await ensureDir(pluginsDir);

      let pluginFileCount = 0;
      for (const [filename, file] of Object.entries(zip.files)) {
        if (file.dir || !filename.startsWith(pluginsPrefix)) continue;
        const relative = filename.slice(pluginsPrefix.length);
        if (!isSafeArchivePath(relative)) {
          return {
            success: false,
            error: `Invalid plugin archive path: ${filename}`,
          };
        }
        const destination = join(pluginsDir, ...relative.split("/"));
        await ensureDir(join(destination, ".."));
        await Deno.writeFile(destination, await file.async("uint8array"));
        pluginFileCount++;
      }
      details.psycheros.plugins_restored = pluginFileCount;
      details.psycheros.plugin_restart_required = pluginFileCount > 0;
    }

    // Restore binary directories that previously weren't included in the
    // export. Each is optional in the zip — old exports without these
    // entries import cleanly, the destination dir is just left empty.
    const restoreBinaryDir = async (
      zipPrefix: string,
      destSubpath: string[],
      detailKey:
        | "anchor_files_restored"
        | "chat_attachment_files_restored"
        | "custom_tool_files_restored"
        | "background_files_restored",
    ): Promise<void> => {
      if (!zip.file(new RegExp(`^${zipPrefix}/`))) return;
      const destDir = join(ctx.dataRoot, ".psycheros", ...destSubpath);
      await Deno.remove(destDir, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await ensureDir(destDir);

      let count = 0;
      for (const [filename, file] of Object.entries(zip.files)) {
        if (file.dir || !filename.startsWith(zipPrefix + "/")) continue;
        const relative = filename.slice(zipPrefix.length + 1);
        if (!relative || !isSafeArchivePath(relative)) continue;
        const destination = join(destDir, ...relative.split("/"));
        await ensureDir(join(destination, ".."));
        await Deno.writeFile(destination, await file.async("uint8array"));
        count++;
      }
      details.psycheros[detailKey] = count;
    };

    await restoreBinaryDir(
      "psycheros/anchors",
      ["anchors"],
      "anchor_files_restored",
    );
    await restoreBinaryDir(
      "psycheros/chat-attachments",
      ["chat-attachments"],
      "chat_attachment_files_restored",
    );
    await restoreBinaryDir(
      "psycheros/custom-tools",
      ["custom-tools"],
      "custom_tool_files_restored",
    );
    await restoreBinaryDir(
      "psycheros/backgrounds",
      ["backgrounds"],
      "background_files_restored",
    );

    // --- Import entity-core data via MCP ---
    if (entityCoreParts && ctx.mcpClient?.isConnected()) {
      await progress({
        phase: "entity-core",
        status: "Importing entity-core data (identity, memories, graph)...",
      });
      await yieldLoop();
      console.log("[entity-data] Importing entity-core data via MCP…");
      try {
        // Re-zip only the entity-core portion
        const coreZip = new JSZip();
        for (const [path, file] of Object.entries(zip.files)) {
          if (file.dir || !path.startsWith("entity-core/")) continue;
          const content = await file.async("uint8array");
          coreZip.file(path, content);
        }

        // Re-add manifest with only entity-core parts
        const coreManifest = {
          schema_version: 1,
          exported_at: manifest.exported_at,
          parts: { entity_core: entityCoreParts },
          counts: (() => {
            const counts: Record<string, unknown> = {};
            if (manifest.counts) {
              for (const [key, val] of Object.entries(manifest.counts)) {
                if (
                  [
                    "identity_files",
                    "memory_entries",
                    "graph_nodes",
                    "graph_edges",
                  ].includes(key)
                ) {
                  counts[key] = val;
                }
              }
            }
            return counts;
          })(),
        };
        coreZip.file("manifest.json", JSON.stringify(coreManifest, null, 2));

        const coreZipBytes = await coreZip.generateAsync({
          type: "uint8array",
        });
        const base64 = uint8ArrayToBase64(coreZipBytes);
        console.log(
          "[entity-data] Entity-core zip prepared,",
          (coreZipBytes.length / 1024).toFixed(0),
          "KB — calling entity_import…",
        );

        const result = await callMcpTool(ctx.mcpClient, "entity_import", {
          data: base64,
          mode: "overwrite",
        });

        console.log(
          "[entity-data] entity_import returned:",
          result ? "ok" : "null",
        );

        if (result) {
          const parsed = JSON.parse(result);
          details.entity_core = {
            success: parsed.success !== false,
            error: parsed.error,
          };
        } else {
          details.entity_core = {
            success: false,
            error: "No response from entity_import",
          };
        }
      } catch (error) {
        console.error("[entity-data] entity_import failed:", error);
        details.entity_core = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (entityCoreParts && !ctx.mcpClient?.isConnected()) {
      details.entity_core = {
        success: false,
        error:
          "MCP not connected — import entity-core data separately while MCP is active",
      };
    }

    // --- Post-import: sync pull to update local identity files ---
    // The entity_import handler already closes/reopens DB connections, so the
    // entity-core process is in a consistent state. Try a pull first (no restart).
    // Only restart as a fallback if the pull fails.
    if (details.entity_core?.success && ctx.mcpClient?.isConnected()) {
      let pullSucceeded = false;

      await progress({
        phase: "sync",
        status: "Syncing identity data...",
      });
      console.log("[entity-data] Running post-import sync pull…");
      try {
        await ctx.mcpClient.pull();
        pullSucceeded = true;
        details.sync_pull = true;
      } catch (error) {
        console.error("[entity-data] Post-import pull failed:", error);
      }

      // Pull failed — restart MCP and retry
      if (!pullSucceeded && ctx.mcpClient) {
        await progress({
          phase: "restart",
          status: "Restarting entity-core before retrying sync...",
        });
        await yieldLoop();
        console.log(
          "[entity-data] Pull failed, restarting MCP for clean state…",
        );
        try {
          await ctx.mcpClient.restart();
        } catch (error) {
          console.error("[entity-data] MCP restart failed:", error);
        }

        if (ctx.mcpClient.isConnected()) {
          await progress({
            phase: "sync",
            status: "Syncing identity data (retry)...",
          });
          console.log("[entity-data] Retrying sync pull after restart…");
          try {
            await ctx.mcpClient.pull();
            details.sync_pull = true;
          } catch {
            details.sync_pull = false;
          }
        }
      }
    }

    // Clear stale RAG tables — they'll be reindexed on next access
    await progress({
      phase: "cleanup",
      status: "Clearing stale search indexes...",
    });
    await yieldLoop();
    try {
      execSql(ctx, "DELETE FROM memory_chunks");
      execSql(ctx, "DELETE FROM message_embeddings");
    } catch {
      // Tables may not exist in older installs
    }

    // Clear vector virtual tables
    try {
      execSql(ctx, "DELETE FROM vec_memory_chunks");
      execSql(ctx, "DELETE FROM vec_messages");
    } catch {
      // Virtual tables may not be loaded
    }

    console.log(
      "[entity-data] Import complete in",
      (Date.now() - importStart) / 1000,
      "s",
    );
    return { success: true, details };
  } catch (error) {
    console.error("[entity-data] Import failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Call an MCP tool and return the text content of the first result block.
 */
async function callMcpTool(
  client: MCPClient,
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const internalClient = (client as unknown as {
    client: {
      callTool: (
        opts: { name: string; arguments: Record<string, unknown> },
      ) => Promise<unknown>;
    };
  }).client;
  if (!internalClient) return null;

  const result = await internalClient.callTool({ name, arguments: args });
  if (!result || typeof result !== "object") return null;

  const r = result as Record<string, unknown>;
  if (!r.content || !Array.isArray(r.content)) return null;

  const firstBlock = r.content[0] as Record<string, unknown> | undefined;
  if (firstBlock?.type === "text" && typeof firstBlock.text === "string") {
    return firstBlock.text;
  }

  return null;
}
