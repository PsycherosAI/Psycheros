/**
 * Entity Loom — Setup Stage
 *
 * Handles initial configuration: save config, create package directory,
 * test LLM connection, list packages for resume.
 */

import { basename, join, resolve } from "@std/path";
import type { Handler } from "../server/server.ts";
import type {
  CheckpointStateV2,
  StageName,
  StageStatus,
  WizardConfig,
  WizardState,
} from "../types.ts";
import {
  createCheckpointV2,
  getPackageDir,
  loadWizardConfig,
  migrateCheckpointV1toV2,
  saveWizardConfig,
} from "../config.ts";
import { CheckpointManager } from "../dedup/checkpoint.ts";
import { sse } from "../server/sse.ts";
import { log } from "../server/logger.ts";
import { getProgressSnapshot, getRunningStage } from "../server/stage-lock.ts";

const OUTPUT_DIR = join(Deno.cwd(), ".loom-exports");

/** Return a public-safe copy of the config — strips llmApiKey. */
function publicConfig(
  config: WizardConfig | null,
): (Omit<WizardConfig, "llmApiKey"> & { hasApiKey: boolean }) | null {
  if (!config) return null;
  const { llmApiKey: _, ...rest } = config;
  return { ...rest, hasApiKey: !!config.llmApiKey };
}

/** In-memory active wizard state */
let activePackageDir: string | null = null;
let activeConfig: WizardConfig | null = null;
let activeCheckpoint: CheckpointStateV2 | null = null;
let finalized = false;

/** Get active package directory */
export function getActivePackageDir(): string | null {
  return activePackageDir;
}

export function setActivePackageDir(dir: string | null): void {
  activePackageDir = dir;
}

/** Get active wizard config */
export function getActiveConfig(): WizardConfig | null {
  return activeConfig;
}

/** Get active checkpoint */
export function getActiveCheckpoint(): CheckpointStateV2 | null {
  return activeCheckpoint;
}

/** Set active checkpoint (used by stages to update) */
export function setActiveCheckpoint(checkpoint: CheckpointStateV2): void {
  activeCheckpoint = checkpoint;
}

/** Set active config (used by stages to update platform/instance) */
export function setActiveConfig(config: WizardConfig): void {
  activeConfig = config;
}

/** Get finalized state */
export function isFinalized(): boolean {
  return finalized;
}

/** Set finalized state */
export function setFinalized(v: boolean): void {
  finalized = v;
}

export function resetActivePackage(dir: string): void {
  if (activePackageDir === dir) {
    activePackageDir = null;
    activeConfig = null;
    activeCheckpoint = null;
  }
}

/** Build wizard state for the status endpoint */
export function buildWizardState(): WizardState {
  const stageStatuses = getStageStatuses();
  return {
    currentStage: activeCheckpoint?.currentStage || "setup",
    config: publicConfig(activeConfig) as WizardState["config"],
    checkpoint: activeCheckpoint,
    hasPackage: activePackageDir !== null,
    packageDir: activePackageDir,
    stageStatuses,
    runningStage: getRunningStage(),
    progress: getProgressSnapshot(),
    finalized,
  };
}

function getStageStatuses(): Record<StageName, StageStatus> {
  if (!activeCheckpoint) {
    return {
      setup: "pending",
      convert: "pending",
      significant: "pending",
      daily: "pending",
      graph: "pending",
    };
  }
  return {
    setup: activeCheckpoint.stages.setup.status,
    convert: activeCheckpoint.stages.convert.status,
    significant: activeCheckpoint.stages.significant.status,
    daily: activeCheckpoint.stages.daily.status,
    graph: activeCheckpoint.stages.graph.status,
  };
}

/**
 * Background stages that can be safely resumed after a crash. If the process
 * dies mid-stage, the persisted checkpoint still says status: "running" even
 * though nothing is in memory — on the next resume the UI would trust the
 * stale value and hide the Start button. Flipping these to "aborted" returns
 * them to the resumable path. Setup/convert are not in this list: setup is
 * synchronous and convert is short enough that re-running it is cheap.
 */
const RESUMABLE_BACKGROUND_STAGES: StageName[] = [
  "significant",
  "daily",
  "graph",
];

/**
 * Normalize stale "running" statuses to "aborted" when no stage is actually
 * running in memory. Returns true if the checkpoint was modified and needs
 * saving. processedItems and failedItems are preserved so resume picks up
 * where the crashed run left off.
 */
export function recoverStaleRunningStages(
  checkpoint: CheckpointStateV2,
): boolean {
  // If a stage is genuinely running in this process, leave the checkpoint
  // alone — the running stage will update it as it goes.
  if (getRunningStage()) return false;

  let recovered = false;
  for (const stage of RESUMABLE_BACKGROUND_STAGES) {
    const stageCheckpoint = checkpoint.stages[stage];
    if (stageCheckpoint.status === "running") {
      stageCheckpoint.status = "aborted";
      stageCheckpoint.completed = false;
      recovered = true;
      log(
        "warn",
        `Recovered stale '${stage}' stage as aborted/resumable on package resume (processed=${stageCheckpoint.processedItems.length}, failed=${stageCheckpoint.failedItems.length})`,
      );
    }
  }
  return recovered;
}

/** Load a package (resume) */
async function loadPackage(
  packageDir: string,
): Promise<{ config: WizardConfig; checkpoint: CheckpointStateV2 } | null> {
  const config = await loadWizardConfig(packageDir);
  if (!config) return null;

  // Try loading v2 checkpoint
  const checkpointMgr = new CheckpointManager(packageDir);
  const checkpoint = await checkpointMgr.load();

  let v2Checkpoint: CheckpointStateV2;
  if (checkpoint) {
    if (checkpoint.version === 2) {
      v2Checkpoint = checkpoint as unknown as CheckpointStateV2;
    } else {
      v2Checkpoint = migrateCheckpointV1toV2(checkpoint);
      await checkpointMgr.save(
        v2Checkpoint as unknown as import("../types.ts").CheckpointState,
      );
    }
  } else {
    v2Checkpoint = createCheckpointV2(config, "");
  }

  // A previous process may have died mid-stage, leaving a stale "running"
  // status in the checkpoint. If nothing is actually running in this
  // process, flip those to "aborted" so the resume UI offers the Start
  // button instead of hiding it.
  if (recoverStaleRunningStages(v2Checkpoint)) {
    await checkpointMgr.save(
      v2Checkpoint as unknown as import("../types.ts").CheckpointState,
    );
  }

  return { config, checkpoint: v2Checkpoint };
}

/** JSON response helper */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function setupRoutes(): Array<
  { method: string; pattern: string; handler: Handler }
> {
  return [
    // POST /api/setup — save config, create package dir, initial checkpoint
    {
      method: "POST",
      pattern: "/api/setup",
      handler: async (req) => {
        const body = await req.json() as Partial<WizardConfig>;
        if (!body.entityName || !body.userName) {
          return json({ error: "entityName and userName are required" }, 400);
        }

        // Build config with defaults
        const config: WizardConfig = {
          entityName: body.entityName,
          userName: body.userName,
          entityPronouns: body.entityPronouns || "they/them",
          userPronouns: body.userPronouns || "they/them",
          relationshipContext: body.relationshipContext ||
            "conversation partner",
          contextNotes: body.contextNotes || "",
          platform: "chatgpt",
          instanceId: "entity-loom",
          llmApiKey: body.llmApiKey || "",
          llmBaseUrl: body.llmBaseUrl || "https://openrouter.ai/api/v1",
          llmModel: body.llmModel || "google/gemini-2.5-flash",
          maxContextTokens: body.maxContextTokens || 90000,
          rateLimitMs: body.rateLimitMs || 2000,
          requestTimeoutMs: body.requestTimeoutMs || 120000,
        };

        const packageDir = getPackageDir(config, OUTPUT_DIR);
        await saveWizardConfig(packageDir, config);

        const checkpoint = createCheckpointV2(config, "");
        const checkpointMgr = new CheckpointManager(packageDir);
        await checkpointMgr.save(
          checkpoint as unknown as import("../types.ts").CheckpointState,
        );

        activePackageDir = packageDir;
        activeConfig = config;
        activeCheckpoint = checkpoint;

        // Mark setup as completed
        checkpoint.stages.setup.status = "completed";
        checkpoint.stages.setup.completed = true;
        checkpoint.currentStage = "convert";
        await checkpointMgr.save(
          checkpoint as unknown as import("../types.ts").CheckpointState,
        );

        log(
          "info",
          `Setup complete for ${config.entityName}, package: ${packageDir}`,
        );
        sse.broadcast({
          type: "stage_completed",
          stage: "setup",
          data: { packageDir },
          timestamp: new Date().toISOString(),
        });

        return json({ success: true, packageDir });
      },
    },

    // POST /api/setup/test-llm — test LLM connection
    {
      method: "POST",
      pattern: "/api/setup/test-llm",
      handler: async (req) => {
        const body = await req.json() as {
          apiKey?: string;
          baseUrl?: string;
          model?: string;
        };
        const apiKey = body.apiKey || activeConfig?.llmApiKey ||
          Deno.env.get("LLM_API_KEY") || "";
        const baseUrl = body.baseUrl || activeConfig?.llmBaseUrl ||
          "https://openrouter.ai/api/v1";
        const model = body.model || activeConfig?.llmModel ||
          "google/gemini-2.5-flash";

        if (!apiKey) {
          return json({ ok: false, error: "API key is required" }, 400);
        }

        const { LLMClient } = await import("../llm/client.ts");
        const llm = new LLMClient({ apiKey, baseUrl, model });
        const result = await llm.testConnection();

        log(
          "info",
          `LLM test: ${
            result.ok ? "OK" : "FAILED"
          } (${result.latencyMs}ms) model=${model}`,
        );
        return json(result);
      },
    },

    // GET /api/setup/packages — list existing packages
    {
      method: "GET",
      pattern: "/api/setup/packages",
      handler: async () => {
        const packages: Array<{ name: string; dir: string }> = [];
        try {
          for await (const entry of Deno.readDir(OUTPUT_DIR)) {
            if (entry.isDirectory) {
              const config = await loadWizardConfig(
                join(OUTPUT_DIR, entry.name),
              );
              if (config) {
                packages.push({
                  name: entry.name,
                  dir: join(OUTPUT_DIR, entry.name),
                });
              }
            }
          }
        } catch {
          // Output dir doesn't exist yet
        }
        return json({ packages });
      },
    },

    // POST /api/setup/resume — load existing package
    {
      method: "POST",
      pattern: "/api/setup/resume",
      handler: async (req) => {
        const body = await req.json() as { packageDir: string };
        if (!body.packageDir) {
          return json({ error: "packageDir is required" }, 400);
        }

        const result = await loadPackage(body.packageDir);
        if (!result) {
          return json({
            error: "Could not load package — no config.json found",
          }, 404);
        }

        activePackageDir = body.packageDir;
        activeConfig = result.config;
        activeCheckpoint = result.checkpoint;

        log("info", `Resumed package: ${body.packageDir}`);
        return json({
          success: true,
          config: publicConfig(result.config),
          currentStage: activeCheckpoint.currentStage,
        });
      },
    },

    // DELETE /api/setup/package — purge (delete) an existing package
    {
      method: "DELETE",
      pattern: "/api/setup/package",
      handler: async (req) => {
        const body = await req.json() as { packageDir: string };
        if (!body.packageDir) {
          return json({ error: "packageDir is required" }, 400);
        }

        // Validate path is inside OUTPUT_DIR to prevent traversal.
        // `@std/path`'s `resolve` normalizes `..` segments the same
        // way the previous URL-based approach did but without the
        // file:// template-literal trap: building a URL via
        // `\`file://${Deno.cwd()}/\`` truncates at the first space in
        // cwd (e.g. macOS's `~/Library/Application Support/...`),
        // matching the bug fixed in custom-loader.ts.
        const resolved = resolve(body.packageDir);
        const outputResolved = resolve(OUTPUT_DIR);
        if (!resolved.startsWith(outputResolved + "/")) {
          return json({ error: "Invalid package directory" }, 400);
        }

        // Verify it exists and has a config
        const config = await loadWizardConfig(body.packageDir);
        if (!config) {
          return json({ error: "Package not found" }, 404);
        }

        try {
          await Deno.remove(body.packageDir, { recursive: true });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return json({ error: `Failed to delete: ${message}` }, 500);
        }

        resetActivePackage(body.packageDir);
        log("info", `Purged package: ${basename(body.packageDir)}`);
        return json({ success: true });
      },
    },

    // GET /api/status — full wizard state
    {
      method: "GET",
      pattern: "/api/status",
      handler: async () => {
        return json(buildWizardState());
      },
    },
  ];
}
