/**
 * Entity Loom — Staging Stage
 *
 * REST API for the staging area: browse, search, tag, edit, commit,
 * tag sets, and Psycheros comparison.
 */

import { join } from "@std/path";
import type { Handler } from "../server/server.ts";
import type {
  CheckpointState,
  ImportedConversation,
  ImportedMessage,
} from "../types.ts";
import { StagingWriter } from "../writers/staging-writer.ts";
import { DBWriter } from "../writers/db-writer.ts";
import { CheckpointManager } from "../dedup/checkpoint.ts";
import {
  buildWizardState,
  getActiveCheckpoint,
  getActiveConfig,
  getActivePackageDir,
  setActiveCheckpoint,
  setFinalized,
} from "./setup-stage.ts";
import { getCachedConversations } from "./convert-stage.ts";
import { sse } from "../server/sse.ts";
import { log } from "../server/logger.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Get or create a staging writer for the active package */
function getStagingWriter(packageDir: string): StagingWriter {
  const dbPath = join(packageDir, "staging.db");
  const writer = new StagingWriter(dbPath);
  writer.init();
  return writer;
}

export function stagingRoutes(): Array<
  { method: string; pattern: string | RegExp; handler: Handler }
> {
  return [
    // POST /api/staging/populate
    {
      method: "POST",
      pattern: "/api/staging/populate",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const conversations = getCachedConversations();
        if (!conversations || conversations.length === 0) {
          return json(
            { error: "No parsed conversations — run parse first" },
            400,
          );
        }

        try {
          const staging = getStagingWriter(packageDir);
          const existingIds = staging.getExistingStagedIds();
          let newlyStaged = 0;
          let reStaged = 0;
          let skipped = 0;

          for (const conv of conversations) {
            if (existingIds.has(conv.id)) {
              // Re-write to update content if changed and reset included=1
              const wrote = await staging.writeConversation(conv);
              if (wrote > 0) {
                reStaged++;
              } else {
                // Content unchanged — still ensure included=1
                staging.setIncluded(conv.id, true);
                skipped++;
              }
            } else {
              await staging.writeConversation(conv);
              newlyStaged++;
            }
          }

          const stats = staging.getStats();
          staging.close();

          log(
            "info",
            `Staging populated: ${newlyStaged} new, ${reStaged} updated, ${skipped} unchanged — ${stats.total} total, ${stats.included} included`,
          );
          return json({
            success: true,
            newlyStaged,
            reStaged,
            skipped,
            totalStaged: stats.total,
            totalIncluded: stats.included,
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          log("error", `Staging populate failed: ${message}`);
          return json({ error: message }, 500);
        }
      },
    },

    // GET /api/staging/conversations
    {
      method: "GET",
      pattern: "/api/staging/conversations",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ conversations: [], total: 0 });

        const url = new URL(req.url);
        const staging = getStagingWriter(packageDir);
        const result = staging.listConversations({
          tag: url.searchParams.get("tag") || undefined,
          platform: (url.searchParams.get("platform") || undefined) as
            | ImportedConversation["platform"]
            | undefined,
          included: url.searchParams.get("included") === "true"
            ? true
            : url.searchParams.get("included") === "false"
            ? false
            : undefined,
          psycherosStatus:
            (url.searchParams.get("psycherosStatus") || undefined) as
              | "new"
              | "existing"
              | "changed"
              | undefined,
          offset: parseInt(url.searchParams.get("offset") || "0"),
          limit: parseInt(url.searchParams.get("limit") || "50"),
          sortBy: (url.searchParams.get("sortBy") || undefined) as
            | "date"
            | "title"
            | "messageCount"
            | "importedAt"
            | undefined,
          sortOrder: (url.searchParams.get("sortOrder") || undefined) as
            | "asc"
            | "desc"
            | undefined,
        });
        staging.close();
        return json(result);
      },
    },

    // GET /api/staging/conversations/:id
    {
      method: "GET",
      pattern: /^\/api\/staging\/conversations\/([^/]+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const staging = getStagingWriter(packageDir);
        const conv = staging.getConversation(id);
        staging.close();

        if (!conv) return json({ error: "Conversation not found" }, 404);
        return json(conv);
      },
    },

    // GET /api/staging/conversations/:id/messages
    {
      method: "GET",
      pattern: /^\/api\/staging\/conversations\/([^/]+)\/messages$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ messages: [], total: 0 });

        const id = ctx.params.param1;
        const url = new URL(req.url);
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const limit = parseInt(url.searchParams.get("limit") || "100");

        const staging = getStagingWriter(packageDir);
        const result = staging.getMessages(id, offset, limit);
        staging.close();

        return json(result);
      },
    },

    // PATCH /api/staging/conversations/:id — update included state
    {
      method: "PATCH",
      pattern: /^\/api\/staging\/conversations\/([^/]+)$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const body = await req.json() as { included?: boolean; title?: string };

        const staging = getStagingWriter(packageDir);
        if (body.included !== undefined) {
          staging.setIncluded(id, body.included);
        }
        staging.close();

        return json({ success: true });
      },
    },

    // PATCH /api/staging/conversations/bulk — bulk include/exclude
    {
      method: "PATCH",
      pattern: "/api/staging/conversations/bulk",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { ids: string[]; included: boolean };
        if (!body.ids || !Array.isArray(body.ids)) {
          return json({ error: "ids array is required" }, 400);
        }

        const staging = getStagingWriter(packageDir);
        staging.setIncludedBulk(body.ids, body.included);
        staging.close();

        return json({ success: true, count: body.ids.length });
      },
    },

    // POST /api/staging/conversations/bulk/tags — apply a tag to multiple conversations
    {
      method: "POST",
      pattern: "/api/staging/conversations/bulk/tags",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { ids: string[]; tag: string };
        if (!body.ids || !Array.isArray(body.ids) || !body.tag) {
          return json({ error: "ids array and tag are required" }, 400);
        }

        const staging = getStagingWriter(packageDir);
        for (const id of body.ids) {
          staging.addTag(id, body.tag);
        }
        staging.close();

        return json({ success: true, count: body.ids.length });
      },
    },

    // PATCH /api/staging/conversations/all — include/exclude all
    {
      method: "PATCH",
      pattern: "/api/staging/conversations/all",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { included: boolean };

        const staging = getStagingWriter(packageDir);
        staging.setAllIncluded(body.included);
        staging.close();

        return json({ success: true });
      },
    },

    // GET /api/staging/conversations/:id/tags
    {
      method: "GET",
      pattern: /^\/api\/staging\/conversations\/([^/]+)\/tags$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ tags: [] });

        const id = ctx.params.param1;
        const staging = getStagingWriter(packageDir);
        const tags = staging.getTags(id);
        staging.close();

        return json({ tags });
      },
    },

    // PUT /api/staging/conversations/:id/tags — replace all tags
    {
      method: "PUT",
      pattern: /^\/api\/staging\/conversations\/([^/]+)\/tags$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const body = await req.json() as { tags: string[] };

        const staging = getStagingWriter(packageDir);
        staging.setTags(id, body.tags || []);
        staging.close();

        return json({ success: true });
      },
    },

    // POST /api/staging/conversations/:id/tags — add a tag
    {
      method: "POST",
      pattern: /^\/api\/staging\/conversations\/([^/]+)\/tags$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const body = await req.json() as { tag: string };
        if (!body.tag) return json({ error: "tag is required" }, 400);

        const staging = getStagingWriter(packageDir);
        staging.addTag(id, body.tag);
        staging.close();

        return json({ success: true });
      },
    },

    // DELETE /api/staging/conversations/:id/tags/:tag — remove a tag
    {
      method: "DELETE",
      pattern: /^\/api\/staging\/conversations\/([^/]+)\/tags\/(.+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const tag = decodeURIComponent(ctx.params.param2);

        const staging = getStagingWriter(packageDir);
        staging.removeTag(id, tag);
        staging.close();

        return json({ success: true });
      },
    },

    // GET /api/staging/tags — list all unique tags
    {
      method: "GET",
      pattern: "/api/staging/tags",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ tags: [] });

        const staging = getStagingWriter(packageDir);
        const tags = staging.getAllTags();
        staging.close();

        return json({ tags });
      },
    },

    // GET /api/staging/search
    {
      method: "GET",
      pattern: "/api/staging/search",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ results: [], total: 0 });

        const url = new URL(req.url);
        const query = url.searchParams.get("q");
        if (!query) return json({ error: "q parameter is required" }, 400);

        const scope = (url.searchParams.get("scope") || "all") as
          | "all"
          | "titles"
          | "messages";
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const limit = parseInt(url.searchParams.get("limit") || "50");

        const staging = getStagingWriter(packageDir);
        const total = staging.searchTotal(query, { scope });
        const results = staging.search(query, { scope, offset, limit });
        staging.close();

        return json({ results, total });
      },
    },

    // PATCH /api/staging/messages/:id — edit message content
    {
      method: "PATCH",
      pattern: /^\/api\/staging\/messages\/(.+)$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const messageId = ctx.params.param1;
        const body = await req.json() as {
          conversationId: string;
          content: string;
        };
        if (!body.conversationId || body.content === undefined) {
          return json(
            { error: "conversationId and content are required" },
            400,
          );
        }

        const staging = getStagingWriter(packageDir);
        staging.editMessage(messageId, body.conversationId, body.content);
        staging.close();

        return json({ success: true });
      },
    },

    // DELETE /api/staging/messages/:id/edit — revert message edit
    {
      method: "DELETE",
      pattern: /^\/api\/staging\/messages\/(.+)\/edit$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const messageId = ctx.params.param1;
        const staging = getStagingWriter(packageDir);
        staging.revertMessageEdit(messageId);
        staging.close();

        return json({ success: true });
      },
    },

    // GET /api/staging/stats
    {
      method: "GET",
      pattern: "/api/staging/stats",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) {
          return json({
            total: 0,
            included: 0,
            excluded: 0,
            byPlatform: {},
            byTag: {},
            psycherosStatus: { new: 0, existing: 0, changed: 0 },
          });
        }

        const staging = getStagingWriter(packageDir);
        const stats = staging.getStats();
        staging.close();

        return json(stats);
      },
    },

    // POST /api/staging/commit — commit included conversations to chats.db
    {
      method: "POST",
      pattern: "/api/staging/commit",
      handler: async () => {
        const packageDir = getActivePackageDir();
        const config = getActiveConfig();
        const checkpoint = getActiveCheckpoint();
        if (!packageDir || !config || !checkpoint) {
          return json({ error: "No active package" }, 400);
        }

        try {
          const staging = getStagingWriter(packageDir);
          const includedConvs = staging.getIncludedConversations();
          staging.close();

          if (includedConvs.length === 0) {
            return json({ error: "No conversations selected for commit" }, 400);
          }

          const dbPath = join(packageDir, "chats.db");
          const db = new DBWriter(dbPath);
          db.init();

          const existingIds = db.getExistingConversationIds();
          let conversationsStored = 0;
          let messagesStored = 0;
          const committedIds: string[] = [];

          const staging2 = getStagingWriter(packageDir);

          for (const summary of includedConvs) {
            if (existingIds.has(summary.id)) {
              committedIds.push(summary.id);
              continue;
            }

            try {
              // Reconstruct an ImportedConversation from staging data
              const msgs = staging2.getMessages(summary.id, 0, 999999);
              const messages: ImportedMessage[] = msgs.messages.map((m) => ({
                id: m.id,
                conversationId: m.conversationId,
                role: m.role as ImportedMessage["role"],
                content: m.content,
                createdAt: new Date(m.createdAt),
                reasoning: m.reasoningContent || undefined,
              }));

              const conv: ImportedConversation = {
                id: summary.id,
                title: summary.title || undefined,
                createdAt: new Date(summary.createdAt),
                updatedAt: new Date(summary.updatedAt),
                messages,
                platform: summary.platform as ImportedConversation["platform"],
                systemPrompts: [],
              };

              const msgCount = db.writeConversation(conv);
              conversationsStored++;
              messagesStored += msgCount;
              committedIds.push(summary.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log(
                "error",
                `Failed to commit conversation ${summary.id}: ${msg} (createdAt=${summary.createdAt}, updatedAt=${summary.updatedAt})`,
              );
              throw err;
            }
          }

          staging2.close();
          db.close();

          // Serialize committed conversations to raw/ for significant memory extraction
          const rawDir = join(packageDir, "raw");
          await Deno.mkdir(rawDir, { recursive: true });
          const rawStaging = getStagingWriter(packageDir);
          const rawConvs: ImportedConversation[] = [];
          for (const summary of includedConvs) {
            if (!committedIds.includes(summary.id)) continue;
            const msgs = rawStaging.getMessages(summary.id, 0, 999999);
            rawConvs.push({
              id: summary.id,
              title: summary.title || undefined,
              createdAt: new Date(summary.createdAt),
              updatedAt: new Date(summary.updatedAt),
              platform: summary.platform as ImportedConversation["platform"],
              messages: msgs.messages.map((m) => ({
                id: m.id,
                conversationId: m.conversationId,
                role: m.role as ImportedMessage["role"],
                content: m.content,
                createdAt: new Date(m.createdAt),
                reasoning: m.reasoningContent || undefined,
              })),
              systemPrompts: [],
            });
          }
          rawStaging.close();
          await Deno.writeTextFile(
            join(rawDir, "_loom_conversations.json"),
            JSON.stringify(rawConvs),
          );
          log(
            "info",
            `Serialized ${rawConvs.length} conversations to raw/_loom_conversations.json`,
          );

          // Update checkpoint
          for (const id of committedIds) {
            if (!checkpoint.stages.convert.processedItems.includes(id)) {
              checkpoint.stages.convert.processedItems.push(id);
            }
          }
          checkpoint.stages.convert.status = "completed";
          checkpoint.stages.convert.completed = true;
          if (
            checkpoint.currentStage === "setup" ||
            checkpoint.currentStage === "convert"
          ) {
            checkpoint.currentStage = "significant";
          }
          setActiveCheckpoint(checkpoint);

          const checkpointMgr = new CheckpointManager(packageDir);
          await checkpointMgr.save(checkpoint as unknown as CheckpointState);

          log(
            "info",
            `Committed ${conversationsStored} conversations (${messagesStored} messages) from staging`,
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
          log("error", `Staging commit failed: ${message}`);
          return json({ error: message }, 500);
        }
      },
    },

    // POST /api/staging/export-only — commit + skip memory/graph + finalize
    {
      method: "POST",
      pattern: "/api/staging/export-only",
      handler: async () => {
        const packageDir = getActivePackageDir();
        const config = getActiveConfig();
        const checkpoint = getActiveCheckpoint();
        if (!packageDir || !config || !checkpoint) {
          return json({ error: "No active package" }, 400);
        }

        try {
          const staging = getStagingWriter(packageDir);
          const includedConvs = staging.getIncludedConversations();
          staging.close();

          if (includedConvs.length === 0) {
            return json({ error: "No conversations selected for export" }, 400);
          }

          const dbPath = join(packageDir, "chats.db");
          const db = new DBWriter(dbPath);
          db.init();

          const existingIds = db.getExistingConversationIds();
          let conversationsStored = 0;
          let messagesStored = 0;
          const committedIds: string[] = [];

          const staging2 = getStagingWriter(packageDir);

          for (const summary of includedConvs) {
            if (existingIds.has(summary.id)) {
              committedIds.push(summary.id);
              continue;
            }

            try {
              const msgs = staging2.getMessages(summary.id, 0, 999999);
              const messages: ImportedMessage[] = msgs.messages.map((m) => ({
                id: m.id,
                conversationId: m.conversationId,
                role: m.role as ImportedMessage["role"],
                content: m.content,
                createdAt: new Date(m.createdAt),
                reasoning: m.reasoningContent || undefined,
              }));

              const conv: ImportedConversation = {
                id: summary.id,
                title: summary.title || undefined,
                createdAt: new Date(summary.createdAt),
                updatedAt: new Date(summary.updatedAt),
                messages,
                platform: summary.platform as ImportedConversation["platform"],
                systemPrompts: [],
              };

              const msgCount = db.writeConversation(conv);
              conversationsStored++;
              messagesStored += msgCount;
              committedIds.push(summary.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log(
                "error",
                `Export only failed for conversation ${summary.id}: ${msg}`,
              );
              throw err;
            }
          }

          staging2.close();

          // Collect unique tags from included conversations for filename
          const allTags = new Set<string>();
          const staging3 = getStagingWriter(packageDir);
          for (const conv of includedConvs) {
            for (const tag of staging3.getTags(conv.id)) {
              allTags.add(tag);
            }
          }
          staging3.close();
          const tagList = [...allTags].sort();
          const tagSuffix = tagList.length > 0 ? tagList.join("-") + "-" : "";

          // Skip all remaining stages
          for (const stageName of ["significant", "daily", "graph"] as const) {
            checkpoint.stages[stageName].status = "completed";
            checkpoint.stages[stageName].completed = true;
          }
          checkpoint.currentStage = "graph";

          // Update convert processed items
          for (const id of committedIds) {
            if (!checkpoint.stages.convert.processedItems.includes(id)) {
              checkpoint.stages.convert.processedItems.push(id);
            }
          }
          checkpoint.stages.convert.status = "completed";
          checkpoint.stages.convert.completed = true;

          setActiveCheckpoint(checkpoint);
          const checkpointMgr = new CheckpointManager(packageDir);
          await checkpointMgr.save(checkpoint as unknown as CheckpointState);

          // Finalize: strip platform column
          db.stripPlatformColumn();
          db.close();

          setFinalized(true);

          log(
            "info",
            `Export only: ${conversationsStored} conversations (${messagesStored} messages), finalized`,
          );
          sse.broadcast({
            type: "stage_completed",
            stage: "graph",
            data: { exportOnly: true, conversationsStored, messagesStored },
            timestamp: new Date().toISOString(),
          });

          return json({
            success: true,
            conversationsStored,
            messagesStored,
            finalized: true,
            tagSuffix,
            state: buildWizardState(),
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          log("error", `Export only failed: ${message}`);
          return json({ error: message }, 500);
        }
      },
    },

    // ─── Tag Sets ─────────────────────────────────────────────────────

    // GET /api/staging/tag-sets
    {
      method: "GET",
      pattern: "/api/staging/tag-sets",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ tagSets: [] });

        const staging = getStagingWriter(packageDir);
        const tagSets = staging.listTagSets();
        staging.close();

        return json({ tagSets });
      },
    },

    // POST /api/staging/tag-sets — save current state as tag set
    {
      method: "POST",
      pattern: "/api/staging/tag-sets",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { name: string; description?: string };
        if (!body.name) return json({ error: "name is required" }, 400);

        const staging = getStagingWriter(packageDir);
        const id = await staging.saveTagSet(body.name, body.description);
        staging.close();

        log("info", `Saved tag set: ${body.name}`);
        return json({ success: true, id });
      },
    },

    // GET /api/staging/tag-sets/:id
    {
      method: "GET",
      pattern: /^\/api\/staging\/tag-sets\/([^/]+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const staging = getStagingWriter(packageDir);
        const tagSet = staging.loadTagSet(id);
        staging.close();

        if (!tagSet) return json({ error: "Tag set not found" }, 404);
        return json(tagSet);
      },
    },

    // POST /api/staging/tag-sets/:id/apply — apply tag set to staging
    {
      method: "POST",
      pattern: /^\/api\/staging\/tag-sets\/([^/]+)\/apply$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const staging = getStagingWriter(packageDir);

        try {
          const updated = staging.applyTagSet(id);
          staging.close();

          log(
            "info",
            `Applied tag set ${id}: ${updated} conversations updated`,
          );
          return json({ success: true, updated });
        } catch (error) {
          staging.close();
          const message = error instanceof Error
            ? error.message
            : String(error);
          return json({ error: message }, 400);
        }
      },
    },

    // DELETE /api/staging/tag-sets/:id
    {
      method: "DELETE",
      pattern: /^\/api\/staging\/tag-sets\/([^/]+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const id = ctx.params.param1;
        const staging = getStagingWriter(packageDir);
        staging.deleteTagSet(id);
        staging.close();

        return json({ success: true });
      },
    },

    // ─── Tag Palette ───────────────────────────────────────────────────

    // GET /api/staging/tag-palette — list all tag definitions
    {
      method: "GET",
      pattern: "/api/staging/tag-palette",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ tags: [] });

        const staging = getStagingWriter(packageDir);
        const tags = staging.getTagDefinitions();
        staging.close();

        return json({ tags });
      },
    },

    // POST /api/staging/tag-palette — create or update a tag definition
    {
      method: "POST",
      pattern: "/api/staging/tag-palette",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { name: string; color: string };
        if (!body.name?.trim()) {
          return json({ error: "Tag name is required" }, 400);
        }
        if (!body.color?.trim()) {
          return json({ error: "Tag color is required" }, 400);
        }

        const staging = getStagingWriter(packageDir);
        staging.createTagDefinition(body.name.trim(), body.color.trim());
        staging.close();

        return json({ success: true });
      },
    },

    // DELETE /api/staging/tag-palette/:name — remove a tag from the palette
    {
      method: "DELETE",
      pattern: /^\/api\/staging\/tag-palette\/(.+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const name = decodeURIComponent(ctx.params.param1);
        const staging = getStagingWriter(packageDir);
        staging.deleteTagDefinition(name);
        staging.close();

        return json({ success: true });
      },
    },

    // PATCH /api/staging/tag-palette — rename a tag
    {
      method: "PATCH",
      pattern: "/api/staging/tag-palette",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { oldName: string; newName: string };
        if (!body.oldName?.trim() || !body.newName?.trim()) {
          return json({ error: "oldName and newName are required" }, 400);
        }

        try {
          const staging = getStagingWriter(packageDir);
          staging.renameTagDefinition(body.oldName.trim(), body.newName.trim());
          staging.close();
          return json({ success: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 400);
        }
      },
    },

    // ─── Psycheros Comparison ─────────────────────────────────────────

    // GET /api/staging/psycheros/autodetect — find psycheros.db on this machine
    {
      method: "GET",
      pattern: "/api/staging/psycheros/autodetect",
      handler: async () => {
        const candidates: string[] = [];

        // Check sibling directories (entity-loom and Psycheros are often in the same parent)
        try {
          const parentDir = join(Deno.cwd(), "..");
          for await (const entry of Deno.readDir(parentDir)) {
            if (!entry.isDirectory || entry.name.startsWith(".")) continue;
            const dbPath = join(parentDir, entry.name, "data", "psycheros.db");
            try {
              const stat = await Deno.stat(dbPath);
              if (stat.isFile) candidates.push(dbPath);
            } catch { /* not found, skip */ }
          }
        } catch { /* parent dir not readable */ }

        // Check entity-core sibling
        try {
          const parentDir = join(Deno.cwd(), "..");
          for await (const entry of Deno.readDir(parentDir)) {
            if (!entry.isDirectory || entry.name.startsWith(".")) continue;
            const dbPath = join(parentDir, entry.name, "data", "chats.db");
            try {
              const stat = await Deno.stat(dbPath);
              if (stat.isFile) candidates.push(dbPath);
            } catch { /* not found, skip */ }
          }
        } catch { /* parent dir not readable */ }

        // Deduplicate
        const unique = [...new Set(candidates)];

        return json({ candidates: unique });
      },
    },

    // POST /api/staging/psycheros/compare
    {
      method: "POST",
      pattern: "/api/staging/psycheros/compare",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const body = await req.json() as { path: string };
        if (!body.path) return json({ error: "path is required" }, 400);

        try {
          const staging = getStagingWriter(packageDir);

          // Verify the file exists and is a valid SQLite database
          try {
            await Deno.stat(body.path);
          } catch {
            return json({ error: "File not found: " + body.path }, 400);
          }

          // Read conversation IDs from the remote database (psycheros.db or chats.db)
          const { Database } = await import("@db/sqlite");
          let remoteDb: InstanceType<typeof Database> | null = null;
          let remoteConvs: Array<{ id: string }>;
          try {
            remoteDb = new Database(body.path);
            remoteConvs = remoteDb.prepare(
              "SELECT id FROM conversations",
            ).all() as Array<{ id: string }>;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return json({ error: "Could not read database: " + msg }, 400);
          } finally {
            remoteDb?.close();
          }

          const remoteIds = new Set(remoteConvs.map((c) => c.id));

          // Build comparison results
          const stagedIds = staging.getExistingStagedIds();
          const matches: Array<
            {
              conversationId: string;
              matchStatus: "new" | "existing" | "changed";
            }
          > = [];

          for (const id of stagedIds) {
            if (remoteIds.has(id)) {
              matches.push({ conversationId: id, matchStatus: "existing" });
            } else {
              matches.push({ conversationId: id, matchStatus: "new" });
            }
          }

          staging.setPsycherosMatches(matches);
          const stats = staging.getStats();
          staging.close();

          const summary = stats.psycherosStatus;
          log(
            "info",
            `Psycheros comparison: ${summary.new} new, ${summary.existing} existing, ${summary.changed} changed`,
          );
          return json({ success: true, summary, matched: matches.length });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          log("error", `Psycheros compare failed: ${message}`);
          return json({ error: message }, 500);
        }
      },
    },

    // GET /api/staging/psycheros/status
    {
      method: "GET",
      pattern: "/api/staging/psycheros/status",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) {
          return json({
            matches: [],
            summary: { new: 0, existing: 0, changed: 0 },
          });
        }

        const staging = getStagingWriter(packageDir);
        const matches = staging.getPsycherosMatches();
        const stats = staging.getStats();
        staging.close();

        return json({ matches, summary: stats.psycherosStatus });
      },
    },
  ];
}
