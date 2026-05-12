/**
 * Entity Loom — Configuration
 *
 * Loads configuration from environment variables, CLI flags, and interactive prompts.
 */

import { join } from "@std/path";
import type {
  CheckpointState,
  CheckpointStateV2,
  PipelineConfig,
  PlatformType,
  StageName,
  StageStatus,
  WizardConfig,
} from "./types.ts";

// Load .env file from project root (next to src/)
try {
  const { loadSync } = await import("@std/dotenv");
  const envPath = join(import.meta.dirname!, "..", ".env");
  loadSync({ envPath, export: true });
} catch {
  // .env not present, that's fine
}

/**
 * Parse command-line flags from Deno.args.
 * Supports --flag value and --flag=value formats.
 * Boolean flags (--dry-run) default to true when present.
 */
export function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    const eqIndex = arg.indexOf("=");
    const key = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);

    if (eqIndex >= 0) {
      flags[key] = arg.slice(eqIndex + 1);
    } else if (args[i + 1] && !args[i + 1].startsWith("--")) {
      flags[key] = args[++i];
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** Build PipelineConfig from flags, env vars, and defaults */
export function buildConfig(
  flags: Record<string, string | boolean>,
): Partial<PipelineConfig> {
  return {
    platform: typeof flags.platform === "string"
      ? flags.platform as PlatformType
      : undefined,
    inputPath: typeof flags.input === "string" ? flags.input : undefined,
    outputDir: typeof flags["output-dir"] === "string"
      ? flags["output-dir"]
      : undefined,
    entityName: typeof flags["entity-name"] === "string"
      ? flags["entity-name"]
      : undefined,
    userName: typeof flags["user-name"] === "string"
      ? flags["user-name"]
      : undefined,
    contextNotes: typeof flags["context-notes"] === "string"
      ? flags["context-notes"]
      : undefined,
    instanceId: typeof flags["instance-id"] === "string"
      ? flags["instance-id"]
      : undefined,
    workerModel: typeof flags["worker-model"] === "string"
      ? flags["worker-model"]
      : Deno.env.get("WORKER_MODEL") || Deno.env.get("LLM_MODEL") ||
        "google/gemini-2.5-flash",
    maxContextTokens: typeof flags["max-context-tokens"] === "string"
      ? parseInt(flags["max-context-tokens"])
      : 90000,
    rateLimitMs: typeof flags["rate-limit-ms"] === "string"
      ? parseInt(flags["rate-limit-ms"])
      : 2000,
    requestTimeoutMs: typeof flags["request-timeout-ms"] === "string"
      ? parseInt(flags["request-timeout-ms"])
      : 120000,
    dryRun: flags["dry-run"] === true,
    skipGraph: flags["skip-graph"] === true,
    skipMemories: flags["skip-memories"] === true,
    significanceThreshold: typeof flags["significance-threshold"] === "string"
      ? parseFloat(flags["significance-threshold"])
      : 0.7,
    dateFrom: typeof flags["date-from"] === "string"
      ? flags["date-from"]
      : undefined,
    dateTo: typeof flags["date-to"] === "string" ? flags["date-to"] : undefined,
    costEstimate: flags["cost-estimate"] === true,
    idPrefix: typeof flags["id-prefix"] === "string"
      ? flags["id-prefix"]
      : undefined,
    entityPronouns: typeof flags["entity-pronouns"] === "string"
      ? flags["entity-pronouns"]
      : undefined,
    userPronouns: typeof flags["user-pronouns"] === "string"
      ? flags["user-pronouns"]
      : undefined,
    relationshipContext: typeof flags.relationship === "string"
      ? flags.relationship
      : undefined,
  };
}

/** Validate that all required config values are present */
export function validateConfig(config: PipelineConfig): string[] {
  const errors: string[] = [];

  if (!config.platform) errors.push("Platform is required");
  if (!config.inputPath) errors.push("Input path is required");
  if (!config.entityName) errors.push("Entity name is required");
  if (!config.userName) errors.push("User name is required");

  return errors;
}

/** Get LLM configuration from env vars, with optional CLI overrides */
export function getLLMConfig(
  overrides?: { apiKey?: string; baseUrl?: string; model?: string },
): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: overrides?.apiKey || Deno.env.get("LLM_API_KEY") || "",
    baseUrl: overrides?.baseUrl || Deno.env.get("LLM_BASE_URL") ||
      "https://openrouter.ai/api/v1",
    model: overrides?.model || Deno.env.get("LLM_MODEL") ||
      "google/gemini-2.5-flash",
  };
}

// ─── Wizard Config Persistence ──────────────────────────────────────────

const DEFAULT_WIZARD_CONFIG: WizardConfig = {
  entityName: "",
  userName: "",
  entityPronouns: "they/them",
  userPronouns: "they/them",
  relationshipContext: "conversation partner",
  contextNotes: "",
  platform: "chatgpt",
  instanceId: "entity-loom",
  llmApiKey: "",
  llmBaseUrl: "https://openrouter.ai/api/v1",
  llmModel: "google/gemini-2.5-flash",
  maxContextTokens: 90000,
  rateLimitMs: 2000,
  requestTimeoutMs: 120000,
};

/** Save WizardConfig to a package directory */
export async function saveWizardConfig(
  packageDir: string,
  config: WizardConfig,
): Promise<void> {
  await Deno.mkdir(packageDir, { recursive: true });
  const configPath = join(packageDir, "config.json");
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
}

/** Load WizardConfig from a package directory */
export async function loadWizardConfig(
  packageDir: string,
): Promise<WizardConfig | null> {
  try {
    const configPath = join(packageDir, "config.json");
    const text = await Deno.readTextFile(configPath);
    return { ...DEFAULT_WIZARD_CONFIG, ...JSON.parse(text) } as WizardConfig;
  } catch {
    return null;
  }
}

/** Convert WizardConfig to PipelineConfig for use with existing pass functions */
export function wizardToPipelineConfig(
  config: WizardConfig,
  inputPath: string,
  outputDir: string,
): PipelineConfig {
  return {
    platform: config.platform,
    inputPath,
    outputDir,
    entityName: config.entityName,
    userName: config.userName,
    contextNotes: config.contextNotes,
    instanceId: config.instanceId,
    workerModel: config.llmModel,
    maxContextTokens: config.maxContextTokens,
    rateLimitMs: config.rateLimitMs,
    requestTimeoutMs: config.requestTimeoutMs,
    dryRun: false,
    skipGraph: false,
    skipMemories: false,
    significanceThreshold: 0.7,
    entityPronouns: config.entityPronouns,
    userPronouns: config.userPronouns,
    relationshipContext: config.relationshipContext,
    costEstimate: false,
  };
}

/** Compute package directory from config */
export function getPackageDir(
  config: WizardConfig,
  outputDir = ".loom-exports",
): string {
  return join(outputDir, `${config.entityName}-import`);
}

/** Create empty v2 checkpoint from wizard config */
export function createCheckpointV2(
  config: WizardConfig,
  inputPath: string,
): CheckpointStateV2 {
  const makeStage = (): {
    status: StageStatus;
    completed: boolean;
    processedItems: string[];
    failedItems: string[];
  } => ({
    status: "pending",
    completed: false,
    processedItems: [],
    failedItems: [],
  });

  return {
    version: 2,
    currentStage: "setup",
    platform: config.platform,
    instanceId: config.instanceId,
    entityName: config.entityName,
    userName: config.userName,
    contextNotes: config.contextNotes,
    inputPath,
    startedAt: new Date().toISOString(),
    stages: {
      setup: { ...makeStage(), status: "pending" },
      convert: makeStage(),
      significant: makeStage(),
      daily: makeStage(),
      graph: makeStage(),
    },
  };
}

/** Migrate a v1 CheckpointState to v2 CheckpointStateV2 */
export function migrateCheckpointV1toV2(
  v1: CheckpointState,
): CheckpointStateV2 {
  const makeStage = (
    status: StageStatus,
    completed: boolean,
    processed: string[],
    failed: string[] = [],
  ) => ({
    status,
    completed,
    processedItems: processed,
    failedItems: failed,
  });

  // Map v1 passes to v2 stages
  // pass1+pass2 → convert, pass3b → significant, pass3a → daily, pass4 → graph
  const convertCompleted = v1.pass1.completed && v1.pass2.completed;
  const significantCompleted = v1.pass3b.completed;
  const dailyCompleted = v1.pass3a.completed;
  const graphCompleted = v1.pass4.completed;

  let currentStage: StageName = "setup";
  if (!convertCompleted) currentStage = "convert";
  else if (!significantCompleted) currentStage = "significant";
  else if (!dailyCompleted) currentStage = "daily";
  else if (!graphCompleted) currentStage = "graph";

  const v2: CheckpointStateV2 = {
    version: 2,
    currentStage,
    platform: v1.platform,
    instanceId: v1.instanceId,
    entityName: v1.entityName,
    userName: v1.userName,
    contextNotes: v1.contextNotes,
    inputPath: v1.inputPath,
    startedAt: v1.startedAt,
    stages: {
      setup: makeStage("completed", true, []),
      convert: makeStage(
        convertCompleted ? "completed" : "pending",
        convertCompleted,
        convertCompleted
          ? v1.pass2.storedIds
          : v1.pass1.conversationHashes
          ? Object.keys(v1.pass1.conversationHashes)
          : [],
      ),
      significant: makeStage(
        significantCompleted ? "completed" : "pending",
        significantCompleted,
        v1.pass3b.processedConversationIds,
        v1.pass3b.failedConversationIds,
      ),
      daily: makeStage(
        dailyCompleted ? "completed" : "pending",
        dailyCompleted,
        v1.pass3a.processedDates,
        v1.pass3a.failedDates,
      ),
      graph: makeStage(
        graphCompleted ? "completed" : "pending",
        graphCompleted,
        v1.pass4.processedMemories,
      ),
    },
    v1,
  };

  return v2;
}
