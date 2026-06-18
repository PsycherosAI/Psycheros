/**
 * Psycheros HTTP Server
 *
 * Main HTTP server for the Psycheros daemon. Handles routing, static file serving,
 * API endpoints, and SSE streaming for chat responses.
 *
 * @module
 */

import { DBClient } from "../db/mod.ts";
import {
  type BLESettings,
  type ButtplugSettings,
  createClientFromProfile,
  createDefaultClient,
  type DiscordGatewayConfig,
  type DiscordSettings,
  type EntityCoreLLMSettings,
  getActiveProfile,
  getDefaultBLESettings,
  getDefaultButtplugSettings,
  getDefaultDiscordGatewayConfig,
  getDefaultImageGenSettings,
  getDefaultLovenseSettings,
  type HomeSettings,
  type ImageGenSettings,
  type LLMClient,
  type LLMConnectionProfile,
  type LLMProfileSettings,
  type LLMSettings,
  loadBLESettings,
  loadButtplugSettings,
  loadDiscordGatewayConfig,
  loadDiscordSettings,
  loadEntityCoreLLMSettings,
  loadHomeSettings,
  loadImageGenSettings,
  loadLovenseSettings,
  loadProfileSettings,
  loadWebSearchSettings,
  type LovenseSettings,
  profileToLLMSettings,
  saveBLESettings,
  saveButtplugSettings,
  saveDiscordGatewayConfig,
  saveDiscordSettings,
  saveEntityCoreLLMSettings,
  saveHomeSettings,
  saveImageGenSettings,
  saveLovenseSettings,
  saveProfileSettings,
  saveWebSearchSettings,
  type WebSearchSettings,
} from "../llm/mod.ts";
import {
  AVAILABLE_TOOLS,
  createDefaultRegistry,
  getEnabledToolNames,
  loadCustomTools,
  loadToolsSettings,
  saveToolsSettings,
  ToolRegistry,
  type ToolsSettings,
} from "../tools/mod.ts";
import {
  DEFAULT_RAG_CONFIG,
  getConversationRAG,
  type RAGConfig,
} from "../rag/mod.ts";
import {
  catchUpSummarization,
  repairOrphanedSummaries,
} from "../memory/mod.ts";
import { DEFAULT_CUTOFF_HOUR } from "../memory/date-utils.ts";
import { Scheduler } from "../scheduler/mod.ts";
import type { HandlerResult } from "../scheduler/mod.ts";
import { getDisplayTimezone, localTimeToUtcCron } from "../pulse/timezone.ts";

import type { MCPClient } from "../mcp-client/mod.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import { LorebookManager } from "../lorebook/mod.ts";
import { VaultManager } from "../vault/mod.ts";
import { PulseEngine } from "../pulse/mod.ts";
import { setPulseEngine } from "../tools/pulse-tools.ts";
import { DeviceStatusCache } from "./device-cache.ts";
import {
  ConversationMapper,
  DiscordGatewayClient,
  MessageRouter,
  ResponseHandler,
} from "../discord/mod.ts";
import { join } from "@std/path";
import { MAX_REQUEST_BODY_SIZE, MAX_UPLOAD_BODY_SIZE } from "../constants.ts";
import {
  callTTS,
  handleBatchDeleteConversations,
  handleButtplugStatus,
  handleChat,
  handleChatFragment,
  handleChatRetry,
  handleChatStop,
  handleClearConversationContext,
  handleConnectionsButtplugFragment,
  handleConnectionsDiscordFragment,
  handleConnectionsHomeFragment,
  handleConnectionsLovenseFragment,
  handleConnectionsSettingsFragment,
  handleConsolidationFragment,
  handleConsolidationRun,
  handleControlHomeDevice,
  handleConversationListFragment,
  handleConversationView,
  handleCORS,
  handleCreateConversation,
  handleCreateCustomFile,
  handleCreateEventRule,
  handleCreateGraphEdge,
  handleCreateGraphNode,
  handleCreateLorebook,
  handleCreateLorebookEntry,
  handleCreateSignificantMemory,
  handleCreateSnapshot,
  handleCustomToolsListFragment,
  handleDeleteAnchorImage,
  handleDeleteBackground,
  handleDeleteConversation,
  handleDeleteCustomFile,
  handleDeleteCustomTool,
  handleDeleteEventRule,
  handleDeleteGraphEdge,
  handleDeleteGraphNode,
  handleDeleteImageGenSlot,
  handleDeleteLorebook,
  handleDeleteLorebookEntry,
  handleDeleteSignificantMemory,
  handleDeleteVault,
  handleDeviceBridge,
  handleDeviceCommand,
  handleEmbedMemories,
  // handleEntityCoreConsolidationRun, // removed — consolidation runs automatically on startup
  handleEntityCoreEmbeddingPurge,
  handleEntityCoreEmbeddingRebuild,
  handleEntityCoreFragment,
  handleEntityCoreGraph,
  handleEntityCoreLLM,
  handleEntityCoreMaintenance,
  handleEntityCoreOverview,
  handleEntityCoreSnapshotPreview,
  handleEntityCoreSnapshots,
  handleEntityCoreSync,
  handleEvents,
  handleGalleryImages,
  handleGeneralSettingsFragment,
  handleGetAppearanceSettings,
  handleGetBLESettings,
  handleGetBLEStatus,
  handleGetButtplugSettings,
  handleGetContextSnapshots,
  handleGetDiscordSettings,
  handleGetEntityCoreLLMSettings,
  handleGetEventRules,
  handleGetGeneralSettings,
  handleGetGraphData,
  handleGetHomeSettings,
  handleGetImageGenSettings,
  handleGetLLMSettings,
  handleGetLorebook,
  handleGetLovenseSettings,
  handleGetMessages,
  handleGetSASettings,
  handleGetSnapshot,
  handleGetToolsSettings,
  handleGetVault,
  handleGetVoiceSettings,
  handleGetVoiceStatus,
  handleGetWebSearchSettings,
  handleHealth,
  handleImportSillyTavernLorebook,
  handleIndex,
  handleInstructionsFragment,
  handleListAnchorImages,
  handleListBackgrounds,
  handleListConversations,
  handleListLorebookEntries,
  handleListLorebooks,
  handleListSnapshots,
  handleListVault,
  handleLLMProfileEditFragment,
  handleLLMSettingsFragment,
  handleLorebookDetailFragment,
  handleLorebookEntryEditFragment,
  handleLorebooksFragment,
  handleLovenseStatus,
  handleMcpSync,
  handleMemoriesEditorFragment,
  handleMemoriesFragment,
  handleMemoriesListFragment,
  handleMemoriesSearchFragment,
  handleMemoryConsolidate,
  handleMessagesPaginated,
  handlePushSubscribe,
  handlePushUnsubscribe,
  handlePushVapidKey,
  handleResetLorebookState,
  handleRestoreSnapshot,
  handleSASettingsFragment,
  handleSaveAppearanceSettings,
  handleSaveBLESettings,
  handleSaveButtplugSettings,
  handleSaveDiscordSettings,
  handleSaveEntityCoreLLMSettings,
  handleSaveGeneralSettings,
  handleSaveHomeSettings,
  handleSaveImageGenSettings,
  handleSaveImageGenSlot,
  handleSaveLLMProfile,
  handleSaveLLMSettings,
  handleSaveLovenseSettings,
  handleSaveMemory,
  handleSaveMemoryInstructions,
  handleSavePromptLabel,
  handleSaveSASettings,
  handleSaveSettingsFile,
  handleSaveToolsSettings,
  handleSaveVoiceSettings,
  handleSaveWebSearchSettings,
  handleSearchVault,
  handleServeBackground,
  handleServeImageFile,
  handleServiceWorker,
  handleSetActiveProfile,
  handleSettingsFileEditorFragment,
  handleSettingsFileListFragment,
  handleSettingsFragment,
  handleSettingsHubFragment,
  handleSnapshotPreviewFragment,
  handleSnapshotsFragment,
  handleStaticFile,
  handleTestButtplugConnection,
  handleTestLLMConnection,
  handleTestLovenseConnection,
  handleTestTTSConnection,
  handleToolsSettingsFragment,
  handleUpdateAnchorImage,
  handleUpdateEventRule,
  handleUpdateGraphEdge,
  handleUpdateGraphNode,
  handleUpdateLorebook,
  handleUpdateLorebookEntry,
  handleUpdateMessage,
  handleUpdateTitle,
  handleUpdateVault,
  handleUploadAnchorImage,
  handleUploadBackground,
  handleUploadChatAttachment,
  handleUploadCustomTool,
  handleUploadIdentityFile,
  handleUploadVault,
  handleVaultDetailFragment,
  handleVaultFragment,
  handleVisionAnchorsFragment,
  handleVisionGalleryFragment,
  handleVisionGeneratorsFragment,
  handleVisionImageGenSlotFragment,
  handleVisionSettingsFragment,
  handleVoiceCallFragment,
  handleVoiceProfileEditFragment,
  handleVoiceSettingsHubFragment,
  handleVoiceWebSocket,
  handleWearableData,
  handleWearableStream,
  type RouteContext,
} from "./routes.ts";
import {
  handleCreatePulse,
  handleDeletePulse,
  handleGetPulse,
  handleGetPulseRun,
  handleGetRunningPulse,
  handleListPulseRuns,
  handleListPulseRunsForPulse,
  handleListPulses,
  handlePulseEditFragment,
  handlePulseFragment,
  handlePulseListFragment,
  handlePulseLogFragment,
  handlePulseNewFragment,
  handleStopPulse,
  handleTriggerPulse,
  handleUpdatePulse,
  handleWebhookTrigger,
} from "../pulse/routes.ts";
import { getBroadcaster } from "./broadcaster.ts";
import { getDeviceBridge } from "./device-bridge.ts";
import { getWearableConnectionManager } from "../wearable/mod.ts";
import { VoiceSessionManager } from "../voice/mod.ts";
import {
  getDefaultVoiceSettings,
  loadVoiceSettings,
  saveVoiceSettings,
  type VoiceSettings,
} from "../llm/voice-settings.ts";
import { EventRulesEngine } from "../wearable/event-rules-engine.ts";
import {
  handleAdminActionsFragment,
  handleAdminAddInstanceSuffix,
  handleAdminBatchPopulate,
  handleAdminDataMigrationChats,
  handleAdminDataMigrationGraph,
  handleAdminDataMigrationMemories,
  handleAdminDiagnosticsAPI,
  handleAdminDiagnosticsFragment,
  handleAdminEntityDataExport,
  handleAdminEntityDataFragment,
  handleAdminEntityDataImport,
  handleAdminEntityDataRestoreConversations,
  handleAdminFragment,
  handleAdminJobRowsFragment,
  handleAdminJobsAPI,
  handleAdminJobsFragment,
  handleAdminJobTriggerAPI,
  handleAdminLogEntriesAPI,
  handleAdminLogsAPI,
  handleAdminLogsFragment,
} from "./admin-routes.ts";
import { setServerStartTime } from "./diagnostics.ts";

/**
 * Server configuration options.
 */
export interface ServerConfig {
  /** Port to listen on */
  port: number;
  /** Hostname to bind to (default: "localhost") */
  hostname?: string;
  /**
   * Source root — where psycheros source lives. Used for serving static
   * web/ assets, reading templates, finding scripts, etc.
   */
  projectRoot: string;
  /**
   * Data root — where user-mutable runtime state lives (.psycheros/,
   * identity/, .snapshots/, memories/).
   * Set via PSYCHEROS_DATA_DIR env. Defaults to projectRoot for
   * backward compatibility with `deno task start` deployments.
   */
  dataRoot: string;
  /** Optional database path (default: {dataRoot}/.psycheros/psycheros.db) */
  dbPath?: string;
  /** List of tool names the entity is allowed to use (empty = no tools) */
  allowedTools?: string[];
  /** RAG configuration options */
  ragConfig?: Partial<RAGConfig>;
  /** Whether memory summarization is enabled (default: true) */
  memoryEnabled?: boolean;
  /** Optional MCP client for syncing with entity-core */
  mcpClient?: MCPClient;
}

/**
 * HTTP server for the Psycheros daemon.
 *
 * Manages the database, LLM client, tool registry, and handles
 * incoming HTTP requests with routing to appropriate handlers.
 *
 * @example
 * ```typescript
 * const server = new Server({
 *   port: 8080,
 *   projectRoot: "/path/to/project",
 * });
 *
 * await server.start();
 *
 * // Later...
 * server.stop();
 * ```
 */
/** Keepalive interval in milliseconds (30 seconds) */
const KEEPALIVE_INTERVAL_MS = 30_000;

export class Server {
  private db: DBClient;
  private llm: LLMClient;
  private tools: ToolRegistry;
  private chatRAG: ConversationRAG | null = null;
  private ragConfig: RAGConfig;
  private abortController: AbortController;
  private config: ServerConfig;
  private keepaliveInterval: number | null = null;
  private mcpClient: MCPClient | null = null;
  private lorebookManager: LorebookManager;
  private vaultManager: VaultManager;
  private llmProfileSettings: LLMProfileSettings;
  private webSearchSettings: WebSearchSettings;
  private discordSettings: DiscordSettings;
  private homeSettings: HomeSettings;
  private lovenseSettings: LovenseSettings;
  private buttplugSettings: ButtplugSettings;
  private bleSettings: BLESettings;
  private imageGenSettings: ImageGenSettings;
  private toolSettings: ToolsSettings;
  private entityCoreLLMSettings: EntityCoreLLMSettings;
  private customTools: Record<string, import("../tools/types.ts").Tool>;
  private pulseEngine: PulseEngine | null = null;
  private scheduler: Scheduler | null = null;
  private eventRulesEngine: EventRulesEngine | null = null;
  private deviceCache: DeviceStatusCache;
  private discordGatewayConfig: DiscordGatewayConfig;
  private discordGatewayClient: DiscordGatewayClient | null = null;
  private discordRouter: MessageRouter | null = null;
  private discordConversationMapper: ConversationMapper | null = null;
  private discordResponseHandler: ResponseHandler | null = null;
  private voiceSettings: VoiceSettings;

  /**
   * Create a new Server instance.
   *
   * @param config - Server configuration
   */
  constructor(config: ServerConfig) {
    this.config = config;

    // Initialize database
    const dbPath = config.dbPath ||
      `${config.dataRoot}/.psycheros/psycheros.db`;
    this.db = new DBClient(dbPath);

    // Initialize LLM client with env-var defaults (will be reloaded from settings in init())
    this.llm = createDefaultClient();
    this.llmProfileSettings = { profiles: [], activeProfileId: "" };

    // Initialize web search settings (will be reloaded from settings in init())
    this.webSearchSettings = {
      provider: "disabled",
      tavilyApiKey: "",
      braveApiKey: "",
    };

    // Initialize Discord settings (will be reloaded from settings in init())
    this.discordSettings = {
      botToken: "",
      defaultChannelId: "",
      enabled: false,
      gatewayEnabled: false,
      globalInstructions: "",
      showHubInSidebar: true,
    };
    this.discordGatewayConfig = getDefaultDiscordGatewayConfig();

    // Initialize Home settings (will be reloaded from settings in init())
    this.homeSettings = { devices: [] };

    // Initialize Lovense settings (will be reloaded from settings in init())
    this.lovenseSettings = getDefaultLovenseSettings();

    // Initialize Buttplug settings (will be reloaded from settings in init())
    this.buttplugSettings = getDefaultButtplugSettings();

    // Initialize BLE settings (will be reloaded from settings in init())
    this.bleSettings = getDefaultBLESettings();

    // Initialize Image Gen settings (will be reloaded from settings in init())
    this.imageGenSettings = getDefaultImageGenSettings();

    // Initialize tool settings (will be reloaded from settings in init())
    this.toolSettings = { toolOverrides: {} };

    // Initialize Entity-Core LLM settings (will be reloaded from settings in init())
    this.entityCoreLLMSettings = {};

    // Initialize custom tools (will be loaded in init())
    this.customTools = {};

    // Initialize voice settings (will be reloaded from settings in init())
    this.voiceSettings = getDefaultVoiceSettings();

    // Initialize tool registry with only allowed tools
    this.tools = createDefaultRegistry(config.allowedTools ?? []);

    // Initialize RAG configuration
    this.ragConfig = {
      ...DEFAULT_RAG_CONFIG,
      ...config.ragConfig,
      memoriesDir: join(
        config.dataRoot,
        config.ragConfig?.memoriesDir ?? DEFAULT_RAG_CONFIG.memoriesDir,
      ),
    };

    // Initialize chat RAG if enabled
    if (this.ragConfig.enabled) {
      this.chatRAG = getConversationRAG(this.db.getRawDb());
    }

    // Store MCP client if provided
    this.mcpClient = config.mcpClient ?? null;

    // Initialize lorebook manager
    this.lorebookManager = new LorebookManager(this.db);

    // Initialize vault manager
    this.vaultManager = new VaultManager(
      this.db,
      config.projectRoot,
      config.dataRoot,
    );

    // Create abort controller for graceful shutdown
    this.abortController = new AbortController();

    // Initialize device status cache for SA system
    // Uses getters so settings changes from init()/UI updates are picked up on next refresh
    this.deviceCache = new DeviceStatusCache({
      homeSettings: () => this.homeSettings,
      lovenseSettings: () => this.lovenseSettings,
      buttplugSettings: () => this.buttplugSettings,
    });
  }

  /**
   * Initialize async dependencies (must be called before start()).
   */
  async init(): Promise<void> {
    this.llmProfileSettings = await loadProfileSettings(
      this.config.dataRoot,
    );
    this.webSearchSettings = await loadWebSearchSettings(
      this.config.dataRoot,
    );
    this.discordSettings = await loadDiscordSettings(this.config.dataRoot);
    this.discordGatewayConfig = await loadDiscordGatewayConfig(
      this.config.dataRoot,
    );
    this.homeSettings = await loadHomeSettings(this.config.dataRoot);
    this.lovenseSettings = await loadLovenseSettings(this.config.dataRoot);
    this.buttplugSettings = await loadButtplugSettings(this.config.dataRoot);
    this.bleSettings = await loadBLESettings(this.config.dataRoot);
    this.imageGenSettings = await loadImageGenSettings(this.config.dataRoot);
    this.entityCoreLLMSettings = await loadEntityCoreLLMSettings(
      this.config.dataRoot,
    );
    this.toolSettings = await loadToolsSettings(this.config.dataRoot);
    this.customTools = await loadCustomTools(this.config.dataRoot);
    this.voiceSettings = await loadVoiceSettings(this.config.dataRoot);
    this.reloadLLMClient();
    this.reloadToolRegistry();

    // Index any vault template files seeded by init that aren't in the DB yet
    await this.vaultManager.indexSeededTemplates();

    // Load general settings to set PSYCHEROS_DISPLAY_TZ for server-side timestamp formatting
    try {
      const settingsText = await Deno.readTextFile(
        `${this.config.dataRoot}/.psycheros/general-settings.json`,
      );
      const settings = JSON.parse(settingsText) as { timezone?: string };
      if (settings.timezone) {
        Deno.env.set("PSYCHEROS_DISPLAY_TZ", settings.timezone);
      }
    } catch {
      // No settings file yet — use system default
    }
  }

  /**
   * Get the current LLM settings (derived from active profile).
   * @deprecated Use getLLMProfileSettings() or getActiveLLMProfile() instead.
   */
  getLLMSettings(): LLMSettings {
    const active = getActiveProfile(this.llmProfileSettings);
    return active
      ? profileToLLMSettings(active)
      : this.llmProfileSettings.profiles.length > 0
      ? profileToLLMSettings(this.llmProfileSettings.profiles[0])
      : {
        baseUrl: "",
        apiKey: "",
        model: "",
        workerModel: "",
        temperature: 0.7,
        topP: 1,
        topK: 0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        maxTokens: 4096,
        contextLength: 128000,
        thinkingEnabled: false,
      };
  }

  /**
   * Update LLM settings, persist to disk, and hot-reload the client.
   * @deprecated Use updateLLMProfileSettings() instead.
   */
  async updateLLMSettings(settings: LLMSettings): Promise<void> {
    const active = getActiveProfile(this.llmProfileSettings);
    if (active) {
      // Merge flat settings into the active profile
      Object.assign(active, settings);
      await this.updateLLMProfileSettings(this.llmProfileSettings);
    }
  }

  /**
   * Get the current LLM profile settings (all profiles + active ID).
   */
  getLLMProfileSettings(): LLMProfileSettings {
    return this.llmProfileSettings;
  }

  /**
   * Update LLM profile settings, persist to disk, and hot-reload the client.
   */
  async updateLLMProfileSettings(settings: LLMProfileSettings): Promise<void> {
    this.llmProfileSettings = settings;
    await saveProfileSettings(this.config.dataRoot, settings);
    this.reloadLLMClient();
  }

  /**
   * Get the currently active LLM connection profile.
   */
  getActiveLLMProfile(): LLMConnectionProfile | null {
    return getActiveProfile(this.llmProfileSettings);
  }

  /**
   * Set the active LLM profile by ID, persist, and hot-reload the client.
   * Optionally restarts entity-core to pick up new credentials.
   */
  async setActiveProfile(profileId: string): Promise<void> {
    this.llmProfileSettings.activeProfileId = profileId;
    await saveProfileSettings(this.config.dataRoot, this.llmProfileSettings);
    this.reloadLLMClient();

    // Restart entity-core to pick up new LLM credentials
    if (this.mcpClient) {
      const active = getActiveProfile(this.llmProfileSettings);
      if (active) {
        // Apply entity-core LLM overrides on top of the active profile
        const ecSettings = await loadEntityCoreLLMSettings(
          this.config.dataRoot,
        );
        const ecTemperature = ecSettings.temperature ?? 0.3;
        const ecMaxTokens = ecSettings.maxTokens ?? 8000;

        console.log(
          "[Server] Restarting entity-core with updated LLM credentials...",
        );
        try {
          await this.mcpClient.restart({
            ENTITY_CORE_LLM_API_KEY: active.apiKey,
            ENTITY_CORE_LLM_BASE_URL: active.baseUrl,
            ENTITY_CORE_LLM_MODEL: ecSettings.model || active.model,
            ENTITY_CORE_LLM_TEMPERATURE: String(ecTemperature),
            ENTITY_CORE_LLM_MAX_TOKENS: String(ecMaxTokens),
          });
          console.log("[Server] entity-core restarted successfully");
        } catch (error) {
          console.error(
            "[Server] Failed to restart entity-core:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  /**
   * Get the current web search settings.
   */
  getWebSearchSettings(): WebSearchSettings {
    return this.webSearchSettings;
  }

  /**
   * Update web search settings, persist to disk, and reload tool registry.
   */
  async updateWebSearchSettings(settings: WebSearchSettings): Promise<void> {
    this.webSearchSettings = settings;
    await saveWebSearchSettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Get the current Discord settings.
   */
  getDiscordSettings(): DiscordSettings {
    return this.discordSettings;
  }

  /**
   * Update Discord settings, persist to disk, and reload tool registry.
   */
  async updateDiscordSettings(settings: DiscordSettings): Promise<void> {
    const prevGatewayEnabled = this.discordSettings.gatewayEnabled;
    this.discordSettings = settings;
    await saveDiscordSettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();

    // Handle gateway enable/disable toggle
    if (settings.gatewayEnabled && !prevGatewayEnabled) {
      await this.startDiscordGateway();
    } else if (!settings.gatewayEnabled && prevGatewayEnabled) {
      this.stopDiscordGateway();
    }
  }

  /**
   * Get the current Discord gateway configuration.
   */
  getDiscordGatewayConfig(): DiscordGatewayConfig {
    return this.discordGatewayConfig;
  }

  /**
   * Update Discord gateway configuration and reconnect if needed.
   */
  async updateDiscordGatewayConfig(
    config: DiscordGatewayConfig,
  ): Promise<void> {
    const merged = { ...getDefaultDiscordGatewayConfig(), ...config };
    this.discordGatewayConfig = merged;
    await saveDiscordGatewayConfig(this.config.dataRoot, merged);

    // Hot-reload the router config if gateway is running
    if (this.discordRouter) {
      this.discordRouter.updateConfig(config);
    }
    if (this.discordGatewayClient) {
      this.discordGatewayClient.updateConfig(config);
    }
  }

  /**
   * Start the Discord Gateway client.
   */
  private async startDiscordGateway(): Promise<void> {
    if (
      !this.discordSettings.gatewayEnabled || !this.discordSettings.botToken
    ) return;

    try {
      this.discordConversationMapper = new ConversationMapper(this.db);
      this.discordGatewayClient = new DiscordGatewayClient(
        this.discordSettings.botToken,
        this.discordGatewayConfig,
      );
      this.discordResponseHandler = new ResponseHandler(
        this.discordSettings.botToken,
        null, // Will be updated once ready
      );

      this.discordRouter = new MessageRouter({
        gateway: this.discordGatewayClient,
        config: this.discordGatewayConfig,
        conversationMapper: this.discordConversationMapper,
        onTurn: (conversationId, userMessage, context) =>
          this.handleDiscordTurn(conversationId, userMessage, context),
        onMessage: (channelId, message) =>
          this.handleDiscordMessage(channelId, message),
      });

      this.discordRouter.start();
      await this.discordGatewayClient.connect();

      // Update response handler with bot user ID once ready
      this.discordResponseHandler.updateBotUserId(
        this.discordGatewayClient.getBotUserId(),
      );

      console.log("[Discord] Gateway started successfully");
    } catch (error) {
      console.error(
        "[Discord] Failed to start gateway:",
        error instanceof Error ? error.message : String(error),
      );
      this.discordGatewayClient = null;
      this.discordRouter = null;
      this.discordResponseHandler = null;
    }
  }

  /**
   * Stop the Discord Gateway client.
   */
  private stopDiscordGateway(): void {
    if (this.discordRouter) {
      this.discordRouter.stop();
      this.discordRouter = null;
    }
    if (this.discordGatewayClient) {
      this.discordGatewayClient.disconnect();
      this.discordGatewayClient = null;
    }
    this.discordResponseHandler = null;
    this.discordConversationMapper = null;
  }

  /**
   * Restart the Discord Gateway.
   */
  async restartDiscordGateway(): Promise<void> {
    this.stopDiscordGateway();
    await this.startDiscordGateway();
  }

  /**
   * Persist an individual Discord message to the DB (for lurk mode display).
   * These messages appear in the channel view even when the entity doesn't respond.
   */
  private async handleDiscordMessage(
    channelId: string,
    message: import("../discord/router.ts").AccumulatedMessage,
  ): Promise<void> {
    const mapper = this.getDiscordConversationMapper();
    if (!mapper) return;

    const serverId = this.getServerIdForChannel(channelId);
    const serverName = this.getServerNameForChannel(channelId);

    const conversationId = await mapper.getOrCreateConversation(
      channelId,
      serverId,
      serverName,
      channelId,
      channelId,
      false,
      message.authorUsername,
    );

    const botTag = message.authorBot ? " [BOT]" : "";
    const replyTag = message.referenceMessageId
      ? ` (replying to ${message.referenceMessageId})`
      : "";
    const content =
      `**${message.authorUsername}** (<@${message.authorId}>)${botTag} (${
        new Date(message.timestamp).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      }) [msg:${message.messageId}]${replyTag}:\n${message.content}`;

    this.db.addMessage(conversationId, {
      role: "user",
      content,
    });
  }

  private getServerIdForChannel(channelId: string): string | null {
    for (const server of this.discordGatewayConfig.servers) {
      if (server.channels.some((c) => c.channelId === channelId)) {
        return server.serverId;
      }
    }
    return null;
  }

  private getServerNameForChannel(channelId: string): string | null {
    for (const server of this.discordGatewayConfig.servers) {
      if (server.channels.some((c) => c.channelId === channelId)) {
        return server.serverName;
      }
    }
    return null;
  }

  /**
   * Handle a Discord turn — process accumulated messages through the entity loop.
   */
  private async handleDiscordTurn(
    conversationId: string,
    userMessage: string,
    context: import("../discord/router.ts").DiscordTurnContext,
  ): Promise<void> {
    if (!this.discordResponseHandler) return;

    // Show typing indicator
    await this.discordResponseHandler.triggerTyping(context.channelId);

    // Build a scoped tool registry with Discord-allowed tools.
    // Always include act_in_discord even if the user's saved config omits it
    // (backwards compat for existing gateway configs).
    const { createDefaultRegistry } = await import("../tools/registry.ts");
    const allowedTools = [...this.discordGatewayConfig.allowedTools];
    if (!allowedTools.includes("act_in_discord")) {
      allowedTools.push("act_in_discord");
    }
    const discordTools = createDefaultRegistry(allowedTools);

    // Build the entity config for this turn
    const activeProfile = this.getActiveLLMProfile();
    const { EntityTurn } = await import("../entity/loop.ts");

    const turn = new EntityTurn(
      this.llm,
      this.db,
      () => discordTools,
      {
        projectRoot: this.config.projectRoot,
        dataRoot: this.config.dataRoot,
        chatRAG: this.chatRAG ?? undefined,
        mcpClient: this.mcpClient ?? undefined,
        lorebookManager: this.lorebookManager,
        vaultManager: this.vaultManager,
        webSearchSettings: this.webSearchSettings,
        discordSettings: this.discordSettings,
        discordGatewayConfig: this.discordGatewayConfig,
        discordContext: context,
        homeSettings: this.homeSettings,
        imageGenSettings: this.imageGenSettings,
        lovenseSettings: this.lovenseSettings,
        buttplugSettings: this.buttplugSettings,
        bleSettings: this.bleSettings,
        deviceStatusCache: this.deviceCache,
        contextLength: activeProfile?.contextLength,
        maxTokens: activeProfile?.maxTokens,
      },
    );

    // Run the entity turn — act_in_discord tool calls handle sending
    // messages directly. Accumulated text content is NOT sent to Discord;
    // it's persisted in the DB for conversation continuity but only tool
    // calls produce visible Discord output.
    try {
      // Prepend context header so the entity understands what the user message is
      const location = context.isDM
        ? `DM with ${context.senderUsername}`
        : `#${context.channelName}` +
          (context.serverName ? ` in the ${context.serverName} server` : "");
      const botId = this.discordGatewayClient?.getBotUserId();
      const botName = this.discordGatewayClient?.getBotUsername();
      const identity = botId
        ? ` My Discord identity is <@${botId}> (${botName ?? "unknown"}).`
        : "";
      const header =
        `[System Message: The following messages are piped in from a connected Discord channel (${location}). Each message shows the author, mention ID, timestamp, and message ID.${identity}]\n\n`;
      const contextualizedMessage = header + userMessage;

      for await (
        const _ of turn.process(conversationId, contextualizedMessage, {
          sourceType: "discord",
          discordContext: context,
          skipStickyDecrement: true,
          skipUserPersist: context.skipUserMessagePersist,
        })
      ) {
        // Consume the generator — tool calls within the loop handle Discord output
      }
    } catch (error) {
      console.error(
        "[Discord] Entity turn error:",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (context.activeTier) {
      console.log(
        `[Discord] Channel ${context.channelId}: entity turn completed (tier: ${context.activeTier})`,
      );
    }
  }

  /**
   * Get the Discord Gateway client (for status checks).
   */
  getDiscordGateway(): DiscordGatewayClient | null {
    return this.discordGatewayClient;
  }

  /**
   * Get the Discord conversation mapper (for DM queue management).
   */
  getDiscordConversationMapper(): ConversationMapper | null {
    return this.discordConversationMapper;
  }

  /**
   * Get the current Home settings.
   */
  getHomeSettings(): HomeSettings {
    return this.homeSettings;
  }

  /**
   * Update Home settings, persist to disk, and reload tool registry.
   */
  async updateHomeSettings(settings: HomeSettings): Promise<void> {
    this.homeSettings = settings;
    await saveHomeSettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Get the current Lovense settings.
   */
  getLovenseSettings(): LovenseSettings {
    return this.lovenseSettings;
  }

  /**
   * Update Lovense settings, persist to disk, and reload tool registry.
   */
  async updateLovenseSettings(settings: LovenseSettings): Promise<void> {
    this.lovenseSettings = settings;
    await saveLovenseSettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Get the current Buttplug settings.
   */
  getButtplugSettings(): ButtplugSettings {
    return this.buttplugSettings;
  }

  /**
   * Update Buttplug settings, persist to disk, and reload tool registry.
   */
  async updateButtplugSettings(settings: ButtplugSettings): Promise<void> {
    this.buttplugSettings = settings;
    await saveButtplugSettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Get the current BLE device bridge settings.
   */
  getBLESettings(): BLESettings {
    return this.bleSettings;
  }

  /**
   * Update BLE device bridge settings, persist to disk, and reload tool registry.
   */
  async updateBLESettings(settings: BLESettings): Promise<void> {
    this.bleSettings = settings;
    await saveBLESettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Get the device status cache for the SA system.
   */
  getDeviceStatusCache(): DeviceStatusCache {
    return this.deviceCache;
  }

  /**
   * Get the current image gen settings.
   */
  getImageGenSettings(): ImageGenSettings {
    return this.imageGenSettings;
  }

  /**
   * Update image gen settings, persist to disk, and reload tool registry.
   */
  async updateImageGenSettings(settings: ImageGenSettings): Promise<void> {
    this.imageGenSettings = settings;
    await saveImageGenSettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Update voice chat settings. The Deno-native walkie-talkie pipeline has
   * no subprocess lifecycle to manage — settings take effect on the next
   * session start.
   */
  async updateVoiceSettings(settings: VoiceSettings): Promise<void> {
    const wasEnabled = this.voiceSettings.enabled;
    // saveVoiceSettings returns the corrected settings (with masked API
    // keys replaced by the real ones from disk). Use that for the in-memory
    // state so the next voice session sees the real keys, not the masked
    // display values that came back from the UI.
    const corrected = await saveVoiceSettings(this.config.dataRoot, settings);
    this.voiceSettings = corrected;

    // If voice was just disabled, close any in-flight voice sessions.
    if (!corrected.enabled && wasEnabled) {
      VoiceSessionManager.getInstance().closeAll();
    }
  }

  /**
   * Get the current entity-core LLM settings.
   */
  getEntityCoreLLMSettings(): EntityCoreLLMSettings {
    return this.entityCoreLLMSettings;
  }

  /**
   * Update entity-core LLM settings, persist to disk, and restart MCP client.
   */
  async updateEntityCoreLLMSettings(
    settings: EntityCoreLLMSettings,
  ): Promise<void> {
    this.entityCoreLLMSettings = settings;
    await saveEntityCoreLLMSettings(this.config.dataRoot, settings);

    // Restart entity-core with updated LLM settings
    if (this.mcpClient) {
      const active = getActiveProfile(this.llmProfileSettings);
      if (active) {
        const ecTemperature = settings.temperature ?? 0.3;
        const ecMaxTokens = settings.maxTokens ?? 8000;

        console.log(
          "[Server] Restarting entity-core with updated LLM settings...",
        );
        try {
          await this.mcpClient.restart({
            ENTITY_CORE_LLM_MODEL: settings.model || active.model,
            ENTITY_CORE_LLM_TEMPERATURE: String(ecTemperature),
            ENTITY_CORE_LLM_MAX_TOKENS: String(ecMaxTokens),
          });
          console.log("[Server] entity-core restarted successfully");
        } catch (error) {
          console.error(
            "[Server] Failed to restart entity-core:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  /**
   * Get the current tools settings.
   */
  getToolSettings(): ToolsSettings {
    return this.toolSettings;
  }

  /**
   * Update tools settings, persist to disk, and reload tool registry.
   */
  async updateToolSettings(settings: ToolsSettings): Promise<void> {
    this.toolSettings = settings;
    await saveToolsSettings(this.config.dataRoot, settings);
    this.reloadToolRegistry();
  }

  /**
   * Re-create the LLM client from the active profile.
   */
  private reloadLLMClient(): void {
    const active = getActiveProfile(this.llmProfileSettings);
    if (active && active.apiKey) {
      this.llm = createClientFromProfile(active);
    }
    // If no active profile or no API key, keep the existing client (from env vars)
  }

  /**
   * Re-create the tool registry from current allowed tools.
   * Merges built-in tools with custom tools and resolves enabled list
   * from env var, user overrides, and auto-enabled tools.
   */
  private reloadToolRegistry(): void {
    // Build merged catalog: built-in + custom
    const allTools: Record<string, import("../tools/types.ts").Tool> = {
      ...AVAILABLE_TOOLS,
      ...this.customTools,
    };
    const allNames = Object.keys(allTools);

    // Determine auto-enabled tools (e.g. web_search when provider is configured)
    const autoEnabled: string[] = [];
    if (
      this.webSearchSettings.provider === "tavily" ||
      this.webSearchSettings.provider === "brave"
    ) {
      autoEnabled.push("web_search");
    }
    if (this.discordSettings.enabled && this.discordSettings.botToken) {
      autoEnabled.push("send_discord_dm");
    }
    if (this.discordSettings.gatewayEnabled && this.discordSettings.botToken) {
      autoEnabled.push("act_in_discord");
    }
    if (this.homeSettings.devices.some((d) => d.enabled)) {
      autoEnabled.push("control_device");
    }
    if (
      this.lovenseSettings.enabled && this.lovenseSettings.connection.domain
    ) {
      autoEnabled.push("control_lovense");
    }
    if (this.buttplugSettings.enabled) {
      autoEnabled.push("control_toy");
    }
    if (this.imageGenSettings.generators.some((g) => g.enabled)) {
      autoEnabled.push("generate_image");
    }
    if (this.imageGenSettings.captioning?.provider) {
      autoEnabled.push("describe_image");
      autoEnabled.push("look_closer");
    }

    // Resolve the final enabled list
    const enabledNames = getEnabledToolNames(
      this.toolSettings,
      allNames,
      this.config.allowedTools ?? [],
      autoEnabled,
    );

    // Build registry from resolved list
    const enabledSet = new Set(enabledNames.map((n) => n.toLowerCase()));
    const registry = new ToolRegistry();
    for (const [name, tool] of Object.entries(allTools)) {
      if (enabledSet.has(name.toLowerCase())) {
        registry.register(tool);
      }
    }
    this.tools = registry;
  }

  /**
   * Start the server.
   *
   * Begins listening for HTTP requests on the configured port.
   * Also starts the keepalive timer for persistent SSE connections.
   * If RAG is enabled, indexes memories on startup.
   */
  async start(): Promise<void> {
    setServerStartTime(new Date());
    const hostname = this.config.hostname || "localhost";
    const port = this.config.port;

    console.log(`Starting Psycheros server on http://${hostname}:${port}`);

    // Set data root on wearable connection manager for stream discovery
    getWearableConnectionManager().setDataRoot(this.config.dataRoot);

    // Initialize event rules engine and wire into wearable connection manager
    this.eventRulesEngine = new EventRulesEngine(this.config.dataRoot);
    await this.eventRulesEngine.reload();
    getWearableConnectionManager().setEventEngine(this.eventRulesEngine);

    // Ensure identity directories exist
    const identityDirs = ["self", "user", "relationship", "custom"];
    for (const dir of identityDirs) {
      try {
        const identityDir = join(this.config.dataRoot, "identity", dir);
        await Deno.mkdir(identityDir, { recursive: true });
      } catch {
        // Directory already exists, ignore
      }
    }

    // Ensure image generation directories exist
    const imageDirs = [
      ".psycheros/generated-images",
      ".psycheros/anchors",
      ".psycheros/chat-attachments",
    ];
    for (const dir of imageDirs) {
      try {
        await Deno.mkdir(join(this.config.dataRoot, dir), {
          recursive: true,
        });
      } catch {
        // Directory already exists, ignore
      }
    }

    // Set up the durable scheduler. It owns the `schedules` and `job_runs`
    // tables and a 5-second ticker. Every scheduled or event-triggered
    // task in Psycheros — daily memory summarization, identity snapshots,
    // identity-change pushes to entity-core, every flavour of Pulse
    // trigger — routes through it.
    this.scheduler = new Scheduler({
      db: this.db.getRawDb(),
      workerId: `psycheros-${Deno.pid}-${Date.now()}`,
    });

    // MCP identity sync — durable push (event-driven, one job per change)
    // and scheduled pull (every 5 minutes).
    if (this.mcpClient) {
      const mcp = this.mcpClient;
      mcp.setScheduler(this.scheduler);

      this.scheduler.register("mcp.push-identity-change", async (ctx) => {
        const { category, filename, content } = ctx.payload as {
          category: "self" | "user" | "relationship" | "custom";
          filename: string;
          content: string;
        };
        await mcp.pushIdentityChange(category, filename, content);
        return {
          status: "success",
          result: `Pushed ${category}/${filename}`,
        };
      });

      this.scheduler.register("mcp.pull-canonical-identity", async () => {
        // Skip-on-disconnect rather than fail-on-disconnect. The MCP
        // client owns reconnection; the 5-min tick handles recovery.
        // Failing the job here turns transient transport drops into
        // stderr noise + retry pressure with no benefit.
        if (!mcp.isConnected()) {
          return {
            status: "skipped",
            result: "MCP transport not connected; next tick will retry",
          };
        }
        try {
          await mcp.pull();
          return { status: "success", result: "Pulled canonical identity" };
        } catch (err) {
          // If the transport dropped between our isConnected() check
          // and callTool returning, the client's onclose handler has
          // already cleared `this.client` — so isConnected() now reads
          // false. Use that to detect the race instead of string-
          // matching SDK error messages, which would silently regress
          // if the SDK changed its wording.
          if (!mcp.isConnected()) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              status: "skipped",
              result: `MCP transport dropped mid-pull: ${msg}`,
            };
          }
          throw err;
        }
      });
      this.scheduler.defineSchedule({
        id: "mcp-pull-canonical-identity",
        kind: "recurring",
        handler: "mcp.pull-canonical-identity",
        intervalSeconds: 300,
        catchupPolicy: "skip_missed",
        maxAttempts: 3,
        metadata: {
          name: "MCP Canonical Identity Pull",
          description: "Pull identity changes from entity-core every 5 minutes",
        },
      });
    }

    // Register memory summarization + identity snapshot handlers and
    // schedules. Both depend on MCP being available; without an MCP
    // connection there are no canonical memories to summarize into and
    // no canonical identity store to snapshot.
    if (this.config.memoryEnabled !== false && this.mcpClient) {
      const memoryTz = getDisplayTimezone();
      const memoryConfig = memoryTz
        ? { timezone: memoryTz, cutoffHour: DEFAULT_CUTOFF_HOUR }
        : undefined;
      const mcp = this.mcpClient;

      let memoryCronPattern: string;
      if (memoryTz) {
        const { utcHour, utcMin } = localTimeToUtcCron(
          DEFAULT_CUTOFF_HOUR,
          0,
          memoryTz,
        );
        memoryCronPattern = `${utcMin} ${utcHour} * * *`;
        console.log(
          `[Memory] Timezone-aware scheduling: daily summary at ${DEFAULT_CUTOFF_HOUR}:00 ${memoryTz} (${utcHour}:${
            String(utcMin).padStart(2, "0")
          } UTC)`,
        );
      } else {
        const memoryHour = parseInt(
          Deno.env.get("PSYCHEROS_MEMORY_HOUR") || "4",
        );
        memoryCronPattern = `0 ${memoryHour} * * *`;
        console.log(
          `[Memory] No timezone configured, using UTC fallback: daily summary at ${memoryHour}:00 UTC`,
        );
      }

      // Same body runs both as the scheduled handler and as the
      // startup catch-up — catchUpSummarization is idempotent on dates
      // it has already summarized.
      const runDailySummarization = async (): Promise<HandlerResult> => {
        const count = await catchUpSummarization(
          this.db,
          mcp,
          this.config.dataRoot,
          memoryConfig,
          this.getActiveLLMProfile() ?? undefined,
        );
        return {
          status: "success",
          result: count > 0
            ? `Summarized ${count} day(s)`
            : "No unsummarized dates found",
        };
      };

      this.scheduler.register(
        "memory.summarize-daily",
        () => runDailySummarization(),
      );
      this.scheduler.defineSchedule({
        id: "memory-daily",
        kind: "recurring",
        handler: "memory.summarize-daily",
        cronExpr: memoryCronPattern,
        catchupPolicy: "fire_once_then_align",
        maxAttempts: 1,
        metadata: {
          name: "Daily Memory Summarization",
          description: "Summarize conversations into daily memory files",
          manualTrigger: true,
        },
      });

      // Startup integrity check + first summarization pass. Fire-and-forget
      // so it doesn't gate the HTTP server coming up; the scheduler will
      // still fire on schedule regardless.
      (async () => {
        try {
          await repairOrphanedSummaries(this.db, mcp);
        } catch (error) {
          console.error(
            "[Memory] Integrity check failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          await runDailySummarization();
        } catch (error) {
          console.error(
            "[Memory] Startup catch-up failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      })();

      // Weekly / monthly / yearly consolidation runs in entity-core, not
      // here — see packages/entity-core/src/mod.ts.

      const snapshotHour = parseInt(
        Deno.env.get("PSYCHEROS_SNAPSHOT_HOUR") || "3",
      );

      const runIdentitySnapshot = async (): Promise<HandlerResult> => {
        // Snapshots must go through MCP so they land in entity-core's
        // canonical data directory. If MCP is unavailable I skip rather
        // than create local-only snapshots the UI never reads.
        if (!this.mcpClient) {
          return {
            status: "skipped",
            result: "MCP not connected (snapshots require entity-core)",
          };
        }
        const result = await this.mcpClient.createSnapshot();
        if (result.success) {
          const count = result.snapshots?.length ?? 0;
          return {
            status: "success",
            result:
              `Created ${count} snapshots via MCP (cleanup handled by entity-core)`,
          };
        }
        throw new Error(result.error || "Unknown error");
      };

      this.scheduler.register(
        "identity.snapshot",
        () => runIdentitySnapshot(),
      );
      this.scheduler.defineSchedule({
        id: "identity-snapshot",
        kind: "recurring",
        handler: "identity.snapshot",
        cronExpr: `0 ${snapshotHour} * * *`,
        catchupPolicy: "fire_once_then_align",
        maxAttempts: 1,
        metadata: {
          name: "Daily Identity Snapshot",
          description: "Snapshot identity files and clean up old snapshots",
          manualTrigger: true,
        },
      });
    }

    // TTS keep-alive: prevents voice deletion on providers like Minimax.
    // Fires daily, checks each profile's ttsKeepAliveDays.
    if (this.voiceSettings.enabled) {
      this.scheduler.register(
        "voice.tts-keep-alive",
        async () => {
          const settings = this.voiceSettings;
          let kept = 0;
          let skipped = 0;

          for (const profile of settings.profiles) {
            if (!profile.enabled || profile.ttsKeepAliveDays <= 0) continue;

            const now = Date.now();
            const lastKeep = profile.lastKeepAlive
              ? new Date(profile.lastKeepAlive).getTime()
              : 0;
            const daysSince = (now - lastKeep) / (1000 * 60 * 60 * 24);

            if (daysSince >= profile.ttsKeepAliveDays) {
              try {
                await callTTS(profile);
                profile.lastKeepAlive = new Date().toISOString();
                kept++;
                console.log(
                  `[Voice] TTS keep-alive success for profile "${profile.name}"`,
                );
              } catch (err) {
                console.error(
                  `[Voice] TTS keep-alive failed for profile "${profile.name}":`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            } else {
              skipped++;
            }
          }

          // Persist updated timestamps
          await this.updateVoiceSettings(settings);

          return {
            status: "success",
            result: kept > 0
              ? `Keep-alive sent for ${kept} profile(s), ${skipped} not due`
              : `${skipped} profile(s) not due, 0 sent`,
          };
        },
      );

      this.scheduler.defineSchedule({
        id: "voice-tts-keep-alive",
        kind: "recurring",
        handler: "voice.tts-keep-alive",
        cronExpr: "0 4 * * *",
        catchupPolicy: "fire_once_then_align",
        maxAttempts: 1,
        metadata: {
          name: "TTS Voice Keep-Alive",
          description:
            "Periodic TTS call to prevent voice deletion on providers like Minimax",
          manualTrigger: true,
        },
      });
    }

    // Start keepalive timer for persistent SSE connections
    const broadcaster = getBroadcaster();
    this.keepaliveInterval = setInterval(() => {
      broadcaster.sendKeepalive();
    }, KEEPALIVE_INTERVAL_MS);

    // Start device status cache refresh for SA system
    this.deviceCache.start();

    // Initialize Pulse engine for autonomous entity prompts. The engine
    // registers its `pulse.execute` handler with the scheduler in start().
    this.pulseEngine = new PulseEngine(
      this.db,
      this.scheduler,
      () => this.llm,
      () => this.tools,
      {
        projectRoot: this.config.projectRoot,
        dataRoot: this.config.dataRoot,
        chatRAG: this.chatRAG ?? undefined,
        mcpClient: this.mcpClient ?? undefined,
        lorebookManager: this.lorebookManager,
        vaultManager: this.vaultManager,
        webSearchSettings: () => this.webSearchSettings,
        discordSettings: () => this.discordSettings,
        homeSettings: () => this.homeSettings,
        lovenseSettings: () => this.lovenseSettings,
        buttplugSettings: () => this.buttplugSettings,
        bleSettings: () => this.bleSettings,
        imageGenSettings: () => this.imageGenSettings,
        contextLength: () => this.getActiveLLMProfile()?.contextLength,
        maxTokens: () => this.getActiveLLMProfile()?.maxTokens,
        deviceStatusCache: () => this.deviceCache,
      },
    );
    this.pulseEngine.start();

    // Wire pulse engine into the entity-facing pulse tool
    setPulseEngine(this.pulseEngine);

    // Wire pulse engine into event rules engine
    if (this.eventRulesEngine) {
      this.eventRulesEngine.setPulseEngine(this.pulseEngine);
    }

    // All handlers registered — start the scheduler ticker.
    this.scheduler.start();

    // Initialize Discord Gateway if enabled (non-blocking — don't prevent HTTP server start)
    this.startDiscordGateway().catch((error) => {
      console.error(
        "[Discord] Gateway startup failed:",
        error instanceof Error ? error.message : String(error),
      );
    });

    // Bind with retry to ride out the launchd KeepAlive restart race
    // where the previous instance hasn't fully released the port yet.
    // 5×500ms = 2.5s covers the macOS TIME_WAIT gap in practice; if we
    // still can't bind after that, something other than our prior self
    // is holding the port and the AddrInUse propagates cleanly.
    const maxBindAttempts = 5;
    const bindRetryDelayMs = 500;
    for (let attempt = 1; attempt <= maxBindAttempts; attempt++) {
      try {
        await Deno.serve(
          {
            port,
            hostname,
            signal: this.abortController.signal,
            onListen: ({ hostname, port }) => {
              console.log(
                `Psycheros server listening on http://${hostname}:${port}`,
              );
            },
          },
          (request) => this.handleRequest(request),
        ).finished;
        return;
      } catch (err) {
        if (
          err instanceof Deno.errors.AddrInUse && attempt < maxBindAttempts
        ) {
          console.error(
            `[Server] Port ${port} busy (attempt ${attempt}/${maxBindAttempts}), retrying in ${bindRetryDelayMs}ms — likely a previous instance still releasing.`,
          );
          await new Promise((r) => setTimeout(r, bindRetryDelayMs));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Stop the server gracefully.
   *
   * Aborts the server, clears the keepalive timer, and closes the database connection.
   */
  stop(): void {
    console.log("Stopping Psycheros server...");

    // Stop Discord Gateway
    this.stopDiscordGateway();

    // Stop pulse engine
    if (this.pulseEngine) {
      this.pulseEngine.stop();
    }

    // Stop the scheduler — clears the ticker and aborts in-flight handlers.
    if (this.scheduler) {
      this.scheduler.stop();
    }

    // Stop device status cache refresh
    this.deviceCache.stop();

    // Close device bridge WebSocket connections
    getDeviceBridge().closeAll();

    // Close wearable connection manager WebSocket connections
    getWearableConnectionManager().closeAll();

    // Stop voice subsystem
    VoiceSessionManager.getInstance().closeAll();

    // Clear keepalive timer
    if (this.keepaliveInterval !== null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    this.abortController.abort();
    this.db.close();
    console.log("Psycheros server stopped.");
  }

  /**
   * Get the route context for handlers.
   */
  private getContext(): RouteContext {
    return {
      db: this.db,
      llm: this.llm,
      tools: () => this.tools,
      projectRoot: this.config.projectRoot,
      dataRoot: this.config.dataRoot,
      chatRAG: this.chatRAG ?? undefined,
      ragConfig: this.ragConfig,
      memoryEnabled: this.config.memoryEnabled ?? true,
      mcpClient: this.mcpClient ?? undefined,
      lorebookManager: this.lorebookManager,
      vaultManager: this.vaultManager,
      pulseEngine: this.pulseEngine ?? undefined,
      scheduler: this.scheduler ?? undefined,
      getLLMSettings: () => this.getLLMSettings(),
      updateLLMSettings: (settings) => this.updateLLMSettings(settings),
      getLLMProfileSettings: () => this.llmProfileSettings,
      updateLLMProfileSettings: (settings) =>
        this.updateLLMProfileSettings(settings),
      getActiveLLMProfile: () => this.getActiveLLMProfile(),
      setActiveProfile: (profileId) => this.setActiveProfile(profileId),
      getWebSearchSettings: () => this.webSearchSettings,
      updateWebSearchSettings: (settings) =>
        this.updateWebSearchSettings(settings),
      getDiscordSettings: () => this.discordSettings,
      updateDiscordSettings: (settings) => this.updateDiscordSettings(settings),
      getDiscordGatewayConfig: () => this.discordGatewayConfig,
      updateDiscordGatewayConfig: (config) =>
        this.updateDiscordGatewayConfig(config),
      getDiscordGateway: () => this.discordGatewayClient,
      getDiscordConversationMapper: () => this.discordConversationMapper,
      restartDiscordGateway: () => this.restartDiscordGateway(),
      getHomeSettings: () => this.homeSettings,
      updateHomeSettings: (settings) => this.updateHomeSettings(settings),
      getLovenseSettings: () => this.lovenseSettings,
      updateLovenseSettings: (settings) => this.updateLovenseSettings(settings),
      getButtplugSettings: () => this.buttplugSettings,
      updateButtplugSettings: (settings) =>
        this.updateButtplugSettings(settings),
      getBLESettings: () => this.bleSettings,
      updateBLESettings: (settings) => this.updateBLESettings(settings),
      getImageGenSettings: () => this.imageGenSettings,
      updateImageGenSettings: (settings) =>
        this.updateImageGenSettings(settings),
      getToolSettings: () => this.toolSettings,
      updateToolSettings: (settings) => this.updateToolSettings(settings),
      getEntityCoreLLMSettings: () => this.entityCoreLLMSettings,
      updateEntityCoreLLMSettings: (settings) =>
        this.updateEntityCoreLLMSettings(settings),
      getDeviceStatusCache: () => this.deviceCache,
      getEventRulesEngine: () => this.eventRulesEngine!,
      customTools: this.customTools,
      updateCustomTools: (tools) => {
        this.customTools = tools;
        this.reloadToolRegistry();
      },
      getVoiceSettings: () => this.voiceSettings,
      updateVoiceSettings: (settings) => this.updateVoiceSettings(settings),
    };
  }

  /**
   * Route incoming requests to the appropriate handler.
   *
   * @param request - The incoming HTTP request
   * @returns HTTP Response
   */
  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const ctx = this.getContext();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleCORS();
    }

    // Health check (lightweight, no middleware)
    if (method === "GET" && path === "/health") {
      return handleHealth();
    }

    // Enforce request body size limits
    if (method !== "GET" && method !== "OPTIONS" && method !== "HEAD") {
      const contentLength = request.headers.get("content-length");
      if (contentLength) {
        const size = parseInt(contentLength);
        const isUpload = path === "/api/backgrounds" ||
          path === "/api/chat-attachments" || path === "/api/anchor-images" ||
          path === "/api/admin/data-migration/memories" ||
          path === "/api/admin/data-migration/chats" ||
          path === "/api/admin/data-migration/graph" ||
          path === "/api/admin/entity-data/import" ||
          path === "/api/admin/entity-data/restore-conversations";
        const limit = isUpload ? MAX_UPLOAD_BODY_SIZE : MAX_REQUEST_BODY_SIZE;
        if (size > limit) {
          return new Response(
            JSON.stringify({
              error: `Request body too large (max ${
                Math.round(limit / 1024 / 1024)
              }MB)`,
            }),
            {
              status: 413,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }
    }

    try {
      // API Routes
      if (path.startsWith("/api/")) {
        return await this.handleAPIRoute(ctx, request, method, path);
      }

      // Static file and UI routes
      return await this.handleStaticRoute(ctx, method, path, url);
    } catch (error) {
      console.error("[Server] Request error:", error);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  }

  /**
   * Handle API routes.
   */
  private async handleAPIRoute(
    ctx: RouteContext,
    request: Request,
    method: string,
    path: string,
  ): Promise<Response> {
    // POST /api/chat/retry - Retry a failed turn without re-persisting user message
    if (method === "POST" && path === "/api/chat/retry") {
      return await handleChatRetry(ctx, request);
    }

    // POST /api/chat/stop - Mark in-flight turn as user-stopped so cancel()
    // can distinguish stop from network disconnect
    if (method === "POST" && path === "/api/chat/stop") {
      return await handleChatStop(ctx, request);
    }

    // POST /api/chat - Stream chat response
    if (method === "POST" && path === "/api/chat") {
      return await handleChat(ctx, request);
    }

    // GET /api/events - Persistent SSE event stream
    if (method === "GET" && path === "/api/events") {
      return handleEvents(ctx, request);
    }

    // GET /api/device-bridge - WebSocket endpoint for BLE device bridge
    if (method === "GET" && path === "/api/device-bridge") {
      return handleDeviceBridge(ctx, request);
    }

    // GET /api/voice/status - Voice subsystem status
    if (method === "GET" && path === "/api/voice/status") {
      return handleGetVoiceStatus(ctx);
    }

    // GET /api/voice/settings - Voice chat settings
    if (method === "GET" && path === "/api/voice/settings") {
      return handleGetVoiceSettings(ctx);
    }

    // POST /api/voice/settings - Save voice chat settings
    if (method === "POST" && path === "/api/voice/settings") {
      return await handleSaveVoiceSettings(ctx, request);
    }

    // POST /api/voice/test-tts - Test TTS connection (returns audio bytes)
    if (method === "POST" && path === "/api/voice/test-tts") {
      return await handleTestTTSConnection(ctx, request);
    }

    // GET /api/voice/ws - WebSocket endpoint for voice chat
    if (method === "GET" && path.match(/^\/api\/voice\/ws/)) {
      return handleVoiceWebSocket(ctx, request);
    }

    // POST /api/device/command - Send command to BLE device via bridge
    if (method === "POST" && path === "/api/device/command") {
      return handleDeviceCommand(ctx, request);
    }

    // GET /api/device/stream - WebSocket endpoint for entity-plexus wearable streaming
    if (method === "GET" && path === "/api/device/stream") {
      return handleWearableStream(ctx, request);
    }

    // POST /api/device/data - HTTP fallback for entity-plexus wearable data
    if (method === "POST" && path === "/api/device/data") {
      return await handleWearableData(ctx, request);
    }

    // /api/ingest routes — same handlers, aliased for Authelia bearer-auth gating
    // Authelia is configured to only allow client_credentials tokens on /api/ingest
    if (method === "POST" && path === "/api/ingest") {
      return await handleWearableData(ctx, request);
    }
    if (method === "GET" && path === "/api/ingest/stream") {
      return handleWearableStream(ctx, request);
    }

    // GET /api/ble-settings - BLE device bridge settings
    if (method === "GET" && path === "/api/ble-settings") {
      return handleGetBLESettings(ctx);
    }

    // POST /api/ble-settings - Save BLE device bridge settings
    if (method === "POST" && path === "/api/ble-settings") {
      return await handleSaveBLESettings(ctx, request);
    }

    // GET /api/ble-status - Currently connected BLE device IDs (for live polling)
    if (method === "GET" && path === "/api/ble-status") {
      return handleGetBLEStatus(ctx);
    }

    // Event Rules CRUD
    if (method === "GET" && path === "/api/event-rules") {
      return handleGetEventRules(ctx);
    }
    if (method === "POST" && path === "/api/event-rules") {
      return await handleCreateEventRule(ctx, request);
    }
    const eventRuleIdMatch = path.match(/^\/api\/event-rules\/([^/]+)$/);
    if (eventRuleIdMatch) {
      const ruleId = eventRuleIdMatch[1];
      if (method === "PUT") {
        return await handleUpdateEventRule(ctx, request, ruleId);
      }
      if (method === "DELETE") return await handleDeleteEventRule(ctx, ruleId);
    }

    // GET /api/conversations - List conversations (JSON)
    if (method === "GET" && path === "/api/conversations") {
      return handleListConversations(ctx);
    }

    // POST /api/conversations - Create conversation
    if (method === "POST" && path === "/api/conversations") {
      return await handleCreateConversation(ctx, request);
    }

    // GET /api/conversations/:id/context/latest - Get latest context snapshot
    const contextLatestMatch = path.match(
      /^\/api\/conversations\/([^/]+)\/context\/latest$/,
    );
    if (method === "GET" && contextLatestMatch) {
      return handleGetContextSnapshots(ctx, contextLatestMatch[1], true);
    }

    // GET /api/conversations/:id/context - Get all context snapshots
    const contextAllMatch = path.match(
      /^\/api\/conversations\/([^/]+)\/context$/,
    );
    if (method === "GET" && contextAllMatch) {
      return handleGetContextSnapshots(ctx, contextAllMatch[1], false);
    }

    // GET /api/conversations/:id/messages - Get messages
    const messagesMatch = path.match(
      /^\/api\/conversations\/([^/]+)\/messages$/,
    );
    if (method === "GET" && messagesMatch) {
      const conversationId = messagesMatch[1];
      return handleGetMessages(ctx, conversationId);
    }

    // GET /api/conversations/:id/messages/paginated - Paginated messages
    const paginatedMessagesMatch = path.match(
      /^\/api\/conversations\/([^/]+)\/messages\/paginated$/,
    );
    if (method === "GET" && paginatedMessagesMatch) {
      const conversationId = paginatedMessagesMatch[1];
      const url = new URL(request.url);
      const before = url.searchParams.get("before") || undefined;
      const beforeId = url.searchParams.get("beforeId") || undefined;
      const limit = url.searchParams.get("limit")
        ? parseInt(url.searchParams.get("limit")!)
        : undefined;
      return handleMessagesPaginated(
        ctx,
        conversationId,
        before,
        beforeId,
        limit,
      );
    }

    // PUT /api/messages/:id - Update message content
    const updateMessageMatch = path.match(/^\/api\/messages\/([^/]+)$/);
    if (method === "PUT" && updateMessageMatch) {
      const messageId = updateMessageMatch[1];
      return await handleUpdateMessage(ctx, messageId, request);
    }

    // PATCH /api/conversations/:id/title - Update title
    const titleMatch = path.match(/^\/api\/conversations\/([^/]+)\/title$/);
    if (method === "PATCH" && titleMatch) {
      const conversationId = titleMatch[1];
      return await handleUpdateTitle(ctx, conversationId, request);
    }

    // DELETE /api/conversations - Batch delete conversations
    if (method === "DELETE" && path === "/api/conversations") {
      return await handleBatchDeleteConversations(ctx, request);
    }

    // DELETE /api/conversations/:id - Delete single conversation
    const deleteMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const conversationId = deleteMatch[1];
      return handleDeleteConversation(ctx, conversationId, request);
    }

    // POST /api/conversations/:id/clear-context - Insert context divider
    const clearContextMatch = path.match(
      /^\/api\/conversations\/([^/]+)\/clear-context$/,
    );
    if (method === "POST" && clearContextMatch) {
      const conversationId = clearContextMatch[1];
      return await handleClearConversationContext(ctx, conversationId);
    }

    // POST /api/settings/file/:directory/:filename - Save settings file
    const settingsFileMatch = path.match(
      /^\/api\/settings\/file\/([^/]+)\/([^/]+)$/,
    );
    if (method === "POST" && settingsFileMatch) {
      const directory = settingsFileMatch[1];
      const filename = settingsFileMatch[2];
      return await handleSaveSettingsFile(ctx, directory, filename, request);
    }

    // POST /api/settings/prompt-label/:directory/:filename - Save prompt label
    const promptLabelMatch = path.match(
      /^\/api\/settings\/prompt-label\/([^/]+)\/([^/]+)$/,
    );
    if (method === "POST" && promptLabelMatch) {
      const directory = promptLabelMatch[1];
      const filename = promptLabelMatch[2];
      return await handleSavePromptLabel(ctx, directory, filename, request);
    }

    // POST /api/settings/custom/create - Create custom file
    if (method === "POST" && path === "/api/settings/custom/create") {
      return await handleCreateCustomFile(ctx, request);
    }

    // POST /api/settings/identity/upload - Upload identity file
    if (method === "POST" && path === "/api/settings/identity/upload") {
      return await handleUploadIdentityFile(ctx, request);
    }

    // DELETE /api/settings/file/custom/:filename - Delete custom file
    const deleteCustomMatch = path.match(
      /^\/api\/settings\/file\/custom\/([^/]+)$/,
    );
    if (method === "DELETE" && deleteCustomMatch) {
      return await handleDeleteCustomFile(ctx, deleteCustomMatch[1]);
    }

    // POST /api/memory/consolidate/:granularity - Trigger memory consolidation
    const memoryConsolidateMatch = path.match(
      /^\/api\/memory\/consolidate\/(weekly|monthly|yearly)$/,
    );
    if (method === "POST" && memoryConsolidateMatch) {
      const granularity = memoryConsolidateMatch[1];
      return await handleMemoryConsolidate(ctx, granularity);
    }

    // POST /api/memories/consolidation/run - Run catch-up consolidation
    if (method === "POST" && path === "/api/memories/consolidation/run") {
      return await handleConsolidationRun(ctx);
    }

    // POST /api/memories/instructions - Save custom daily memory instructions
    if (method === "POST" && path === "/api/memories/instructions") {
      return await handleSaveMemoryInstructions(ctx, request);
    }

    // POST /api/entity-core/consolidation/run - removed: consolidation runs automatically on startup
    // if (method === "POST" && path === "/api/entity-core/consolidation/run") {
    //   return await handleEntityCoreConsolidationRun(ctx);
    // }

    // POST /api/entity-core/embeddings/purge - Purge orphaned memory embeddings
    if (
      method === "POST" && path === "/api/entity-core/embeddings/purge"
    ) {
      return await handleEntityCoreEmbeddingPurge(ctx);
    }

    // POST /api/entity-core/embeddings/rebuild - Rebuild all memory embeddings
    if (
      method === "POST" && path === "/api/entity-core/embeddings/rebuild"
    ) {
      return await handleEntityCoreEmbeddingRebuild(ctx);
    }

    // POST /api/entity-core/sync - Manual sync (pull + push)
    if (method === "POST" && path === "/api/entity-core/sync") {
      return await handleEntityCoreSync(ctx);
    }

    // POST /api/entity-core/actions/embed-memories - Run embed-existing-memories script
    if (
      method === "POST" && path === "/api/entity-core/actions/embed-memories"
    ) {
      const body = await request.json() as Record<string, unknown>;
      return await handleEmbedMemories(ctx, body);
    }

    // GET /api/entity-core-llm-settings - Get entity-core LLM settings
    if (method === "GET" && path === "/api/entity-core-llm-settings") {
      return handleGetEntityCoreLLMSettings(ctx);
    }

    // POST /api/entity-core-llm-settings - Save entity-core LLM settings
    if (method === "POST" && path === "/api/entity-core-llm-settings") {
      return await handleSaveEntityCoreLLMSettings(ctx, request);
    }

    // ========================================
    // Memories API Routes
    // ========================================

    // POST /api/memories/significant/create - Create new significant memory
    // Must be before the :granularity/:date catch-all
    if (method === "POST" && path === "/api/memories/significant/create") {
      return await handleCreateSignificantMemory(ctx, request);
    }

    // DELETE /api/memories/significant/:filename - Delete a significant memory
    const deleteSignificantMatch = path.match(
      /^\/api\/memories\/significant\/(.+)$/,
    );
    if (method === "DELETE" && deleteSignificantMatch) {
      const filename = deleteSignificantMatch[1];
      return await handleDeleteSignificantMemory(ctx, filename);
    }

    // POST /api/memories/:granularity/:date - Save edited memory
    const saveMemoryMatch = path.match(
      /^\/api\/memories\/(daily|weekly|monthly|yearly|significant)\/([^/]+)$/,
    );
    if (method === "POST" && saveMemoryMatch) {
      const granularity = saveMemoryMatch[1];
      const date = saveMemoryMatch[2];
      return await handleSaveMemory(ctx, granularity, date, request);
    }

    // POST /api/mcp/sync - Manually trigger MCP sync
    if (method === "POST" && path === "/api/mcp/sync") {
      return await handleMcpSync(ctx);
    }

    // GET /api/snapshots - List all snapshots
    if (method === "GET" && path === "/api/snapshots") {
      return await handleListSnapshots(ctx);
    }

    // POST /api/snapshots/create - Create manual snapshot
    if (method === "POST" && path === "/api/snapshots/create") {
      return await handleCreateSnapshot(ctx);
    }

    // GET /api/snapshots/:id - Get snapshot content
    const snapshotMatch = path.match(/^\/api\/snapshots\/(.+)$/);
    if (method === "GET" && snapshotMatch) {
      return await handleGetSnapshot(ctx, snapshotMatch[1]);
    }

    // POST /api/snapshots/:id/restore - Restore snapshot
    const snapshotRestoreMatch = path.match(
      /^\/api\/snapshots\/(.+)\/restore$/,
    );
    if (method === "POST" && snapshotRestoreMatch) {
      return await handleRestoreSnapshot(ctx, snapshotRestoreMatch[1]);
    }

    // Lorebook Routes
    // GET /api/lorebooks - List lorebooks
    if (method === "GET" && path === "/api/lorebooks") {
      return handleListLorebooks(ctx);
    }

    // POST /api/lorebooks - Create lorebook
    if (method === "POST" && path === "/api/lorebooks") {
      return await handleCreateLorebook(ctx, request);
    }

    // POST /api/lorebooks/import-sillytavern - Import from SillyTavern
    if (method === "POST" && path === "/api/lorebooks/import-sillytavern") {
      return await handleImportSillyTavernLorebook(ctx, request);
    }

    // Lorebook entry routes - must match before :id routes
    // GET /api/lorebooks/:id/entries - List entries
    const lorebookEntriesMatch = path.match(
      /^\/api\/lorebooks\/([^/]+)\/entries$/,
    );
    if (lorebookEntriesMatch) {
      const lorebookId = lorebookEntriesMatch[1];
      if (method === "GET") {
        return handleListLorebookEntries(ctx, lorebookId);
      }
      if (method === "POST") {
        return await handleCreateLorebookEntry(ctx, lorebookId, request);
      }
    }

    // Entry-specific routes
    const lorebookEntryMatch = path.match(
      /^\/api\/lorebooks\/([^/]+)\/entries\/([^/]+)$/,
    );
    if (lorebookEntryMatch) {
      const lorebookId = lorebookEntryMatch[1];
      const entryId = lorebookEntryMatch[2];
      if (method === "PUT") {
        return await handleUpdateLorebookEntry(
          ctx,
          lorebookId,
          entryId,
          request,
        );
      }
      if (method === "DELETE") {
        return handleDeleteLorebookEntry(ctx, lorebookId, entryId);
      }
    }

    // GET /api/lorebooks/:id - Get lorebook
    // PUT /api/lorebooks/:id - Update lorebook
    // DELETE /api/lorebooks/:id - Delete lorebook
    const lorebookMatch = path.match(/^\/api\/lorebooks\/([^/]+)$/);
    if (lorebookMatch) {
      const lorebookId = lorebookMatch[1];
      if (method === "GET") {
        return handleGetLorebook(ctx, lorebookId);
      }
      if (method === "PUT") {
        return await handleUpdateLorebook(ctx, lorebookId, request);
      }
      if (method === "DELETE") {
        return handleDeleteLorebook(ctx, lorebookId);
      }
    }

    // DELETE /api/lorebooks/state/:conversationId - Reset sticky state
    const lorebookStateMatch = path.match(/^\/api\/lorebooks\/state\/([^/]+)$/);
    if (method === "DELETE" && lorebookStateMatch) {
      return handleResetLorebookState(ctx, lorebookStateMatch[1]);
    }

    // ========================================
    // Knowledge Graph API Routes
    // ========================================

    // GET /api/graph - Get full graph data
    if (method === "GET" && path === "/api/graph") {
      return await handleGetGraphData(ctx);
    }

    // POST /api/graph/nodes - Create node
    if (method === "POST" && path === "/api/graph/nodes") {
      return await handleCreateGraphNode(ctx, request);
    }

    // POST /api/graph/edges - Create edge
    if (method === "POST" && path === "/api/graph/edges") {
      return await handleCreateGraphEdge(ctx, request);
    }

    // PUT/DELETE /api/graph/nodes/:id - Update or delete node
    const graphNodeMatch = path.match(/^\/api\/graph\/nodes\/([^/]+)$/);
    if (graphNodeMatch) {
      if (method === "PUT") {
        return await handleUpdateGraphNode(ctx, request, graphNodeMatch[1]);
      }
      if (method === "DELETE") {
        return await handleDeleteGraphNode(ctx, graphNodeMatch[1]);
      }
    }

    // PUT/DELETE /api/graph/edges/:id - Update or delete edge
    const graphEdgeMatch = path.match(/^\/api\/graph\/edges\/([^/]+)$/);
    if (graphEdgeMatch) {
      if (method === "PUT") {
        return await handleUpdateGraphEdge(ctx, request, graphEdgeMatch[1]);
      }
      if (method === "DELETE") {
        return await handleDeleteGraphEdge(ctx, graphEdgeMatch[1]);
      }
    }

    // ========================================
    // Background Image API Routes
    // ========================================

    // GET /api/backgrounds - List background images
    // POST /api/backgrounds - Upload background image
    if (path === "/api/backgrounds") {
      if (method === "GET") {
        return await handleListBackgrounds(ctx);
      }
      if (method === "POST") {
        return await handleUploadBackground(ctx, request);
      }
    }

    // DELETE /api/backgrounds/:filename - Delete background image
    const backgroundDeleteMatch = path.match(/^\/api\/backgrounds\/([^/]+)$/);
    if (method === "DELETE" && backgroundDeleteMatch) {
      const filename = backgroundDeleteMatch[1];
      return await handleDeleteBackground(ctx, filename);
    }

    // ========================================
    // LLM Settings API Routes
    // ========================================

    // ========================================
    // General Settings API Routes
    // ========================================

    // GET /api/general-settings - Get current general settings
    if (method === "GET" && path === "/api/general-settings") {
      return await handleGetGeneralSettings(ctx);
    }

    // POST /api/general-settings - Save general settings
    if (method === "POST" && path === "/api/general-settings") {
      return await handleSaveGeneralSettings(ctx, request);
    }

    // ========================================
    // Situational Awareness Settings API Routes
    // ========================================

    // GET /api/sa-settings - Get current SA settings
    if (method === "GET" && path === "/api/sa-settings") {
      return await handleGetSASettings(ctx);
    }

    // POST /api/sa-settings - Save SA settings
    if (method === "POST" && path === "/api/sa-settings") {
      return await handleSaveSASettings(ctx, request);
    }

    // ========================================
    // Appearance Settings API Routes
    // ========================================

    // GET /api/appearance-settings - Get current appearance settings
    if (method === "GET" && path === "/api/appearance-settings") {
      return await handleGetAppearanceSettings(ctx);
    }

    // POST /api/appearance-settings - Save appearance settings
    if (method === "POST" && path === "/api/appearance-settings") {
      return await handleSaveAppearanceSettings(ctx, request);
    }

    // ========================================
    // LLM Settings API Routes
    // ========================================

    // GET /api/llm-settings - Get current settings
    if (method === "GET" && path === "/api/llm-settings") {
      return handleGetLLMSettings(ctx);
    }

    // POST /api/llm-settings - Save settings (bulk, used by delete)
    if (method === "POST" && path === "/api/llm-settings") {
      return await handleSaveLLMSettings(ctx, request);
    }

    // POST /api/llm-settings/profile - Add or update a single profile
    if (method === "POST" && path === "/api/llm-settings/profile") {
      return await handleSaveLLMProfile(ctx, request);
    }

    // POST /api/llm-settings/reset - Reset to defaults
    if (method === "POST" && path === "/api/llm-settings/reset") {
      const { handleResetLLMSettings } = await import("./routes.ts");
      return await handleResetLLMSettings(ctx);
    }

    // POST /api/llm-settings/test - Test connection
    if (method === "POST" && path === "/api/llm-settings/test") {
      return await handleTestLLMConnection(ctx, request);
    }

    // POST /api/llm-settings/set-active - Set active profile
    if (method === "POST" && path === "/api/llm-settings/set-active") {
      return await handleSetActiveProfile(ctx, request);
    }

    // ========================================
    // Web Search Settings API Routes
    // ========================================

    // GET /api/web-search-settings - Get current web search settings
    if (method === "GET" && path === "/api/web-search-settings") {
      return handleGetWebSearchSettings(ctx);
    }

    // POST /api/web-search-settings - Save web search settings
    if (method === "POST" && path === "/api/web-search-settings") {
      return await handleSaveWebSearchSettings(ctx, request);
    }

    // POST /api/web-search-settings/reset - Reset to defaults
    if (method === "POST" && path === "/api/web-search-settings/reset") {
      const { handleResetWebSearchSettings } = await import("./routes.ts");
      return await handleResetWebSearchSettings(ctx);
    }

    // ========================================
    // Discord Settings API Routes
    // ========================================

    // GET /api/discord-settings - Get current Discord settings
    if (method === "GET" && path === "/api/discord-settings") {
      return handleGetDiscordSettings(ctx);
    }

    // POST /api/discord-settings - Save Discord settings
    if (method === "POST" && path === "/api/discord-settings") {
      return await handleSaveDiscordSettings(ctx, request);
    }

    // POST /api/discord-settings/reset - Reset to defaults
    if (method === "POST" && path === "/api/discord-settings/reset") {
      const { handleResetDiscordSettings } = await import("./routes.ts");
      return await handleResetDiscordSettings(ctx);
    }

    // ========================================
    // Discord Gateway API Routes
    // ========================================

    // GET /api/discord/status - Gateway connection status
    if (method === "GET" && path === "/api/discord/status") {
      const { handleGetDiscordStatus } = await import("./routes.ts");
      return handleGetDiscordStatus(ctx);
    }

    // GET /api/discord/gateway-config - Get gateway configuration
    if (method === "GET" && path === "/api/discord/gateway-config") {
      const { handleGetDiscordGatewayConfig } = await import("./routes.ts");
      return handleGetDiscordGatewayConfig(ctx);
    }

    // POST /api/discord/gateway-config - Save gateway configuration
    if (method === "POST" && path === "/api/discord/gateway-config") {
      const { handleSaveDiscordGatewayConfig } = await import("./routes.ts");
      return await handleSaveDiscordGatewayConfig(ctx, request);
    }

    // POST /api/discord/gateway/restart - Restart gateway connection
    if (method === "POST" && path === "/api/discord/gateway/restart") {
      const { handleRestartDiscordGateway } = await import("./routes.ts");
      return await handleRestartDiscordGateway(ctx);
    }

    // GET /api/discord/conversations - List Discord conversations
    if (method === "GET" && path === "/api/discord/conversations") {
      const { handleGetDiscordConversations } = await import("./routes.ts");
      return handleGetDiscordConversations(ctx);
    }

    // GET /api/discord/dm-whitelist - Get DM whitelist
    if (method === "GET" && path === "/api/discord/dm-whitelist") {
      const { handleGetDmWhitelist } = await import("./routes.ts");
      return handleGetDmWhitelist(ctx);
    }

    // POST /api/discord/dm-whitelist - Add entry to DM whitelist
    if (method === "POST" && path === "/api/discord/dm-whitelist") {
      const { handleAddDmWhitelistEntry } = await import("./routes.ts");
      return await handleAddDmWhitelistEntry(ctx, request);
    }

    // DELETE /api/discord/dm-whitelist/:userId - Remove from DM whitelist
    if (
      method === "DELETE" &&
      path.match(/^\/api\/discord\/dm-whitelist\/([^/]+)$/)
    ) {
      const { handleRemoveDmWhitelistEntry } = await import("./routes.ts");
      const userId = path.match(/^\/api\/discord\/dm-whitelist\/([^/]+)$/)?.[1];
      return await handleRemoveDmWhitelistEntry(ctx, userId!);
    }

    // PATCH /api/discord/dm-whitelist/:userId - Update whitelist entry notes
    if (
      method === "PATCH" &&
      path.match(/^\/api\/discord\/dm-whitelist\/([^/]+)$/)
    ) {
      const { handleUpdateDmWhitelistNotes } = await import("./routes.ts");
      const userId = path.match(/^\/api\/discord\/dm-whitelist\/([^/]+)$/)?.[1];
      return await handleUpdateDmWhitelistNotes(ctx, userId!, request);
    }

    // ========================================
    // Home Settings API Routes
    // ========================================

    // GET /api/home-settings - Get current home settings
    if (method === "GET" && path === "/api/home-settings") {
      return handleGetHomeSettings(ctx);
    }

    // POST /api/home-settings - Save home settings
    if (method === "POST" && path === "/api/home-settings") {
      return await handleSaveHomeSettings(ctx, request);
    }

    // POST /api/home-device/control - Direct user device control (safety override)
    if (method === "POST" && path === "/api/home-device/control") {
      return await handleControlHomeDevice(ctx, request);
    }

    // ========================================
    // Lovense Settings API Routes
    // ========================================

    // GET /api/lovense-settings - Get current Lovense settings
    if (method === "GET" && path === "/api/lovense-settings") {
      return handleGetLovenseSettings(ctx);
    }

    // POST /api/lovense-settings - Save Lovense settings
    if (method === "POST" && path === "/api/lovense-settings") {
      return await handleSaveLovenseSettings(ctx, request);
    }

    // POST /api/lovense-settings/test - Test Lovense connection
    if (method === "POST" && path === "/api/lovense-settings/test") {
      return await handleTestLovenseConnection(ctx, request);
    }

    // GET /api/lovense-status - Quick Lovense connection check for header icon
    if (method === "GET" && path === "/api/lovense-status") {
      return await handleLovenseStatus(ctx);
    }

    // ========================================
    // Buttplug Settings API Routes
    // ========================================

    // GET /api/buttplug-settings - Get current Buttplug settings
    if (method === "GET" && path === "/api/buttplug-settings") {
      return handleGetButtplugSettings(ctx);
    }

    // POST /api/buttplug-settings - Save Buttplug settings
    if (method === "POST" && path === "/api/buttplug-settings") {
      return await handleSaveButtplugSettings(ctx, request);
    }

    // POST /api/buttplug-settings/test - Test Buttplug connection
    if (method === "POST" && path === "/api/buttplug-settings/test") {
      return await handleTestButtplugConnection(ctx, request);
    }

    // GET /api/buttplug-status - Quick Buttplug connection check
    if (method === "GET" && path === "/api/buttplug-status") {
      return await handleButtplugStatus(ctx);
    }

    // ========================================
    // Image Gen Settings API Routes
    // ========================================

    // GET /api/image-gen-settings - Get current image gen settings
    if (method === "GET" && path === "/api/image-gen-settings") {
      return handleGetImageGenSettings(ctx);
    }

    // POST /api/image-gen-settings - Save image gen settings
    if (method === "POST" && path === "/api/image-gen-settings") {
      return await handleSaveImageGenSettings(ctx, request);
    }

    // POST /api/image-gen-settings/slot - Save a single generator slot (preserves API keys)
    if (method === "POST" && path === "/api/image-gen-settings/slot") {
      return await handleSaveImageGenSlot(ctx, request);
    }

    // POST /api/image-gen-settings/delete - Delete a single generator slot
    if (method === "POST" && path === "/api/image-gen-settings/delete") {
      return await handleDeleteImageGenSlot(ctx, request);
    }

    // POST /api/image-gen-settings/reset - Reset to defaults
    if (method === "POST" && path === "/api/image-gen-settings/reset") {
      const { handleResetImageGenSettings } = await import("./routes.ts");
      return await handleResetImageGenSettings(ctx);
    }

    // GET /api/anchor-images - List anchor images
    if (method === "GET" && path === "/api/anchor-images") {
      return handleListAnchorImages(ctx);
    }

    // POST /api/anchor-images - Upload anchor image
    if (method === "POST" && path === "/api/anchor-images") {
      return await handleUploadAnchorImage(ctx, request);
    }

    // PATCH /api/anchor-images/:id - Update anchor image
    const anchorUpdateMatch = path.match(/^\/api\/anchor-images\/([^/]+)$/);
    if (method === "PATCH" && anchorUpdateMatch) {
      return await handleUpdateAnchorImage(ctx, anchorUpdateMatch[1], request);
    }

    // DELETE /api/anchor-images/:id - Delete anchor image
    const anchorDeleteMatch = path.match(/^\/api\/anchor-images\/([^/]+)$/);
    if (method === "DELETE" && anchorDeleteMatch) {
      return await handleDeleteAnchorImage(ctx, anchorDeleteMatch[1]);
    }

    // GET /api/chat-attachments - Upload chat attachment
    if (method === "POST" && path === "/api/chat-attachments") {
      return await handleUploadChatAttachment(ctx, request);
    }

    // GET /api/gallery/images - List gallery images with pagination
    if (method === "GET" && path === "/api/gallery/images") {
      return await handleGalleryImages(ctx, request);
    }

    // ========================================
    // Tools Settings API Routes
    // ========================================

    // GET /api/tools-settings - Get current tools settings
    if (method === "GET" && path === "/api/tools-settings") {
      return handleGetToolsSettings(ctx);
    }

    // POST /api/tools-settings - Save tools settings
    if (method === "POST" && path === "/api/tools-settings") {
      return await handleSaveToolsSettings(ctx, request);
    }

    // POST /api/custom-tools/upload - Upload a custom tool .js file
    if (method === "POST" && path === "/api/custom-tools/upload") {
      return await handleUploadCustomTool(ctx, request);
    }

    // DELETE /api/custom-tools/:name - Delete a custom tool
    if (method === "DELETE" && path.startsWith("/api/custom-tools/")) {
      const toolName = path.slice("/api/custom-tools/".length);
      if (toolName && toolName !== "upload" && toolName !== "list") {
        return await handleDeleteCustomTool(ctx, toolName);
      }
    }

    // GET /api/custom-tools/list - Custom tools list HTML for in-place refresh
    if (method === "GET" && path === "/api/custom-tools/list") {
      return handleCustomToolsListFragment(ctx);
    }

    // ========================================
    // Admin API Routes
    // ========================================

    // GET /api/admin/logs - JSON log entries with filtering
    if (method === "GET" && path === "/api/admin/logs") {
      return handleAdminLogsAPI(ctx, new URL(request.url));
    }

    // GET /api/admin/logs/entries - HTML partial of log entries
    if (method === "GET" && path === "/api/admin/logs/entries") {
      return handleAdminLogEntriesAPI(ctx, new URL(request.url));
    }

    // GET /api/admin/diagnostics - JSON diagnostics snapshot
    if (method === "GET" && path === "/api/admin/diagnostics") {
      return await handleAdminDiagnosticsAPI(ctx);
    }

    // GET /api/admin/jobs - JSON scheduled jobs status
    if (method === "GET" && path === "/api/admin/jobs") {
      return handleAdminJobsAPI(ctx);
    }

    // GET /api/admin/jobs/rows - HTML partial of job table rows
    if (method === "GET" && path === "/api/admin/jobs/rows") {
      return handleAdminJobRowsFragment(ctx);
    }

    // POST /api/admin/jobs/:id/trigger - Manually trigger a scheduled job
    if (
      method === "POST" && path.startsWith("/api/admin/jobs/") &&
      path.endsWith("/trigger")
    ) {
      const jobId = path.slice("/api/admin/jobs/".length, -"/trigger".length);
      return await handleAdminJobTriggerAPI(ctx, jobId);
    }

    // POST /api/admin/actions/batch-populate - Run batch-populate-graph script
    if (method === "POST" && path === "/api/admin/actions/batch-populate") {
      const body = await request.json().catch(() => ({}));
      return await handleAdminBatchPopulate(ctx, body);
    }

    // POST /api/admin/actions/add-instance-suffix - Add instance suffix to memory files
    if (
      method === "POST" && path === "/api/admin/actions/add-instance-suffix"
    ) {
      const body = await request.json().catch(() => ({}));
      return await handleAdminAddInstanceSuffix(ctx, body);
    }

    // POST /api/admin/entity-data/export - Export entity data as zip
    if (method === "POST" && path === "/api/admin/entity-data/export") {
      const url = new URL(request.url);
      const skipEntityCore = url.searchParams.get("partial") === "1";
      return await handleAdminEntityDataExport(ctx, skipEntityCore);
    }

    // POST /api/admin/entity-data/import - Import entity data from zip
    if (method === "POST" && path === "/api/admin/entity-data/import") {
      const body = await request.arrayBuffer();
      return await handleAdminEntityDataImport(ctx, new Uint8Array(body));
    }

    // POST /api/admin/entity-data/restore-conversations - Restore conversations from JSON
    if (
      method === "POST" &&
      path === "/api/admin/entity-data/restore-conversations"
    ) {
      return await handleAdminEntityDataRestoreConversations(ctx, request);
    }

    // POST /api/admin/data-migration/memories - Import memory .md files
    if (method === "POST" && path === "/api/admin/data-migration/memories") {
      return await handleAdminDataMigrationMemories(ctx, request);
    }

    // POST /api/admin/data-migration/chats - Import conversations from chats.db
    if (method === "POST" && path === "/api/admin/data-migration/chats") {
      return await handleAdminDataMigrationChats(ctx, request);
    }

    // POST /api/admin/data-migration/graph - Import knowledge graph from graph.db
    if (method === "POST" && path === "/api/admin/data-migration/graph") {
      return await handleAdminDataMigrationGraph(ctx, request);
    }

    // ========================================
    // Pulse API Routes
    // ========================================

    // GET /api/pulses - List all pulses
    if (method === "GET" && path === "/api/pulses") {
      return handleListPulses(ctx);
    }

    // POST /api/pulses - Create pulse
    if (method === "POST" && path === "/api/pulses") {
      return await handleCreatePulse(ctx, request);
    }

    // GET /api/pulses/runs - List pulse runs
    if (method === "GET" && path === "/api/pulses/runs") {
      return handleListPulseRuns(ctx, new URL(request.url));
    }

    // POST /api/webhook/pulse/:id - Webhook trigger
    const webhookPulseMatch = path.match(/^\/api\/webhook\/pulse\/([^/]+)$/);
    if (method === "POST" && webhookPulseMatch) {
      return await handleWebhookTrigger(ctx, webhookPulseMatch[1], request);
    }

    // Pulse-specific routes
    const pulseMatch = path.match(/^\/api\/pulses\/([^/]+)$/);
    if (pulseMatch) {
      const pulseId = pulseMatch[1];
      if (method === "GET") {
        return handleGetPulse(ctx, pulseId);
      }
      if (method === "PUT") {
        return await handleUpdatePulse(ctx, pulseId, request);
      }
      if (method === "DELETE") {
        return handleDeletePulse(ctx, pulseId);
      }
    }

    // POST /api/pulses/:id/trigger - Manual trigger
    const pulseTriggerMatch = path.match(/^\/api\/pulses\/([^/]+)\/trigger$/);
    if (method === "POST" && pulseTriggerMatch) {
      return await handleTriggerPulse(ctx, pulseTriggerMatch[1], request);
    }

    // POST /api/pulses/:id/stop - Abort a running Pulse
    const pulseStopMatch = path.match(/^\/api\/pulses\/([^/]+)\/stop$/);
    if (method === "POST" && pulseStopMatch) {
      return await handleStopPulse(ctx, pulseStopMatch[1], request);
    }

    // GET /api/pulses/running/:conversationId - Get running Pulse for conversation
    const pulseRunningMatch = path.match(/^\/api\/pulses\/running\/([^/]+)$/);
    if (method === "GET" && pulseRunningMatch) {
      return handleGetRunningPulse(ctx, pulseRunningMatch[1], request);
    }

    // GET /api/pulses/:id/runs - Runs for a specific pulse
    const pulseRunsMatch = path.match(/^\/api\/pulses\/([^/]+)\/runs$/);
    if (method === "GET" && pulseRunsMatch) {
      return handleListPulseRunsForPulse(
        ctx,
        pulseRunsMatch[1],
        new URL(request.url),
      );
    }

    // GET /api/pulses/runs/:runId - Single run details
    const pulseRunMatch = path.match(/^\/api\/pulses\/runs\/([^/]+)$/);
    if (method === "GET" && pulseRunMatch) {
      return handleGetPulseRun(ctx, pulseRunMatch[1]);
    }

    // ========================================
    // Vault API Routes
    // ========================================

    // GET /api/vault - List vault documents
    // POST /api/vault - Upload vault document
    if (path === "/api/vault") {
      if (method === "GET") {
        return handleListVault(ctx);
      }
      if (method === "POST") {
        return await handleUploadVault(ctx, request);
      }
    }

    // POST /api/vault/search - Search vault
    if (method === "POST" && path === "/api/vault/search") {
      return await handleSearchVault(ctx, request);
    }

    // Vault document CRUD
    const vaultMatch = path.match(/^\/api\/vault\/([^/]+)$/);
    if (vaultMatch) {
      const vaultId = vaultMatch[1];
      if (method === "GET") {
        return handleGetVault(ctx, vaultId);
      }
      if (method === "PUT") {
        return await handleUpdateVault(ctx, vaultId, request);
      }
      if (method === "DELETE") {
        return handleDeleteVault(ctx, vaultId, request);
      }
    }

    // ========================================
    // Push Notification API Routes
    // ========================================

    // GET /api/push/vapid-key - Get VAPID public key
    if (method === "GET" && path === "/api/push/vapid-key") {
      return await handlePushVapidKey(ctx);
    }

    // POST /api/push/subscribe - Store push subscription
    if (method === "POST" && path === "/api/push/subscribe") {
      return await handlePushSubscribe(ctx, request);
    }

    // POST /api/push/unsubscribe - Remove push subscription
    if (method === "POST" && path === "/api/push/unsubscribe") {
      return await handlePushUnsubscribe(ctx, request);
    }

    // 404 for unknown API routes
    return new Response(
      JSON.stringify({ error: "API endpoint not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  /**
   * Handle static file and UI routes.
   */
  private async handleStaticRoute(
    ctx: RouteContext,
    method: string,
    path: string,
    url?: URL,
  ): Promise<Response> {
    // Only allow GET for static files
    if (method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // GET / - Serve app shell
    if (path === "/" || path === "/index.html") {
      return handleIndex(ctx);
    }

    // GET /sw.js - Version-stamped service worker. Substitutes the running
    // VERSION into the cache-name so each release evicts stale offline assets.
    if (path === "/sw.js") {
      return await handleServiceWorker(ctx);
    }

    // GET /c/:id - Serve conversation page (always full app shell)
    const convMatch = path.match(/^\/c\/([^/]+)$/);
    if (convMatch) {
      return handleConversationView(ctx, convMatch[1]);
    }

    // Fragment routes (HTML partials for HTMX)
    // GET /fragments/chat/:id - Chat view fragment
    const chatFragmentMatch = path.match(/^\/fragments\/chat\/([^/]+)$/);
    if (chatFragmentMatch) {
      return handleChatFragment(ctx, chatFragmentMatch[1]);
    }

    // GET /fragments/conv-list - Conversation list fragment
    if (path === "/fragments/conv-list") {
      return handleConversationListFragment(ctx);
    }

    // GET /fragments/settings - Settings hub page fragment
    if (path === "/fragments/settings") {
      return handleSettingsHubFragment(ctx);
    }

    // GET /fragments/settings/general - General settings fragment
    if (path === "/fragments/settings/general") {
      return await handleGeneralSettingsFragment(ctx);
    }

    // GET /fragments/settings/sa - Situational Awareness settings fragment
    if (path === "/fragments/settings/sa") {
      return await handleSASettingsFragment(ctx);
    }

    // GET /fragments/settings/core-prompts - Settings page fragment
    if (path === "/fragments/settings/core-prompts") {
      return handleSettingsFragment(ctx);
    }

    // GET /fragments/settings/core-prompts/:directory - File list fragment
    const settingsDirMatch = path.match(
      /^\/fragments\/settings\/core-prompts\/([^/]+)$/,
    );
    if (settingsDirMatch) {
      return await handleSettingsFileListFragment(ctx, settingsDirMatch[1]);
    }

    // GET /fragments/settings/file/:directory/:filename - File editor fragment
    const settingsFileMatch = path.match(
      /^\/fragments\/settings\/file\/([^/]+)\/([^/]+)$/,
    );
    if (settingsFileMatch) {
      return await handleSettingsFileEditorFragment(
        ctx,
        settingsFileMatch[1],
        settingsFileMatch[2],
      );
    }

    // GET /fragments/settings/snapshots - Snapshots list fragment
    if (path === "/fragments/settings/snapshots") {
      return await handleSnapshotsFragment(ctx);
    }

    // GET /fragments/settings/snapshots/:id - Snapshot preview fragment
    const snapshotPreviewMatch = path.match(
      /^\/fragments\/settings\/snapshots\/(.+)$/,
    );
    if (snapshotPreviewMatch) {
      return await handleSnapshotPreviewFragment(ctx, snapshotPreviewMatch[1]);
    }

    // Lorebook Fragment Routes
    // GET /fragments/settings/lorebooks - Lorebooks list fragment
    if (path === "/fragments/settings/lorebooks") {
      return handleLorebooksFragment(ctx);
    }

    // GET /fragments/settings/lorebooks/:id - Single lorebook view
    const lorebookDetailMatch = path.match(
      /^\/fragments\/settings\/lorebooks\/([^/]+)$/,
    );
    if (lorebookDetailMatch) {
      return handleLorebookDetailFragment(ctx, lorebookDetailMatch[1]);
    }

    // GET /fragments/settings/lorebooks/:bookId/entries/:entryId/edit - Entry editor
    const lorebookEntryEditMatch = path.match(
      /^\/fragments\/settings\/lorebooks\/([^/]+)\/entries\/([^/]+)\/edit$/,
    );
    if (lorebookEntryEditMatch) {
      return handleLorebookEntryEditFragment(
        ctx,
        lorebookEntryEditMatch[1],
        lorebookEntryEditMatch[2],
      );
    }

    // ========================================
    // Knowledge Graph Fragment Routes
    // ========================================

    // ========================================
    // Entity Core Fragment Routes
    // ========================================

    // GET /fragments/settings/entity-core - Entity Core hub
    if (path === "/fragments/settings/entity-core") {
      return handleEntityCoreFragment(ctx);
    }

    // GET /fragments/settings/entity-core/overview
    if (path === "/fragments/settings/entity-core/overview") {
      return await handleEntityCoreOverview(ctx);
    }

    // GET /fragments/settings/entity-core/llm
    if (path === "/fragments/settings/entity-core/llm") {
      return handleEntityCoreLLM(ctx);
    }

    // GET /fragments/settings/entity-core/graph
    if (path === "/fragments/settings/entity-core/graph") {
      return await handleEntityCoreGraph(ctx);
    }

    // GET /fragments/settings/entity-core/maintenance
    if (path === "/fragments/settings/entity-core/maintenance") {
      return handleEntityCoreMaintenance(ctx);
    }

    // GET /fragments/settings/entity-core/snapshots
    if (path === "/fragments/settings/entity-core/snapshots") {
      return await handleEntityCoreSnapshots(ctx);
    }

    // GET /fragments/entity-core/snapshots/:id - Snapshot preview in Entity Core context
    if (path.startsWith("/fragments/entity-core/snapshots/")) {
      const snapshotId = decodeURIComponent(
        path.slice("/fragments/entity-core/snapshots/".length),
      );
      return await handleEntityCoreSnapshotPreview(ctx, snapshotId);
    }

    // ========================================
    // Memories Fragment Routes
    // ========================================

    // GET /fragments/settings/memories - Memories tabbed view
    if (path === "/fragments/settings/memories") {
      return handleMemoriesFragment(ctx);
    }

    // GET /fragments/settings/memories/consolidation - Consolidation catch-up tab
    if (path === "/fragments/settings/memories/consolidation") {
      return await handleConsolidationFragment(ctx);
    }

    // GET /fragments/settings/memories/instructions - Custom daily memory instructions tab
    if (path === "/fragments/settings/memories/instructions") {
      return await handleInstructionsFragment(ctx);
    }

    // GET /fragments/settings/memories/search?q=... - Search memories
    if (path === "/fragments/settings/memories/search") {
      return await handleMemoriesSearchFragment(
        ctx,
        url ?? new URL("http://localhost"),
      );
    }

    // GET /fragments/settings/memories/:granularity - Memory file list
    const memoriesListMatch = path.match(
      /^\/fragments\/settings\/memories\/([^/]+)$/,
    );
    if (memoriesListMatch) {
      return await handleMemoriesListFragment(
        ctx,
        memoriesListMatch[1],
        url ?? new URL("http://localhost"),
      );
    }

    // GET /fragments/settings/memories/:granularity/:date - Memory editor
    const memoriesEditorMatch = path.match(
      /^\/fragments\/settings\/memories\/([^/]+)\/([^/]+)$/,
    );
    if (memoriesEditorMatch) {
      return await handleMemoriesEditorFragment(
        ctx,
        memoriesEditorMatch[1],
        memoriesEditorMatch[2],
      );
    }

    // ========================================
    // Vault Fragment Routes
    // ========================================

    // GET /fragments/settings/vault - Vault management fragment
    if (path === "/fragments/settings/vault") {
      return handleVaultFragment(ctx);
    }

    // GET /fragments/settings/vault/:id - Vault document detail fragment
    const vaultDetailMatch = path.match(
      /^\/fragments\/settings\/vault\/([^/]+)$/,
    );
    if (vaultDetailMatch) {
      return await handleVaultDetailFragment(ctx, vaultDetailMatch[1]);
    }

    // ========================================
    // LLM Settings Fragment Route
    // ========================================

    // GET /fragments/settings/llm - LLM settings hub (profile cards)
    if (path === "/fragments/settings/llm") {
      return handleLLMSettingsFragment(ctx);
    }

    // GET /fragments/settings/llm/new - New profile form
    if (path === "/fragments/settings/llm/new") {
      return handleLLMProfileEditFragment(ctx);
    }

    // GET /fragments/settings/llm/:id - Edit existing profile form
    const llmProfileMatch = path.match(/^\/fragments\/settings\/llm\/([^/]+)$/);
    if (llmProfileMatch && method === "GET") {
      return handleLLMProfileEditFragment(ctx, llmProfileMatch[1]);
    }

    // GET /fragments/settings/connections - External connections hub fragment
    if (path === "/fragments/settings/connections") {
      return handleConnectionsSettingsFragment(ctx);
    }

    // GET /fragments/settings/connections/discord - Discord connection settings fragment
    if (path === "/fragments/settings/connections/discord") {
      return handleConnectionsDiscordFragment(ctx);
    }

    // ========================================
    // Discord Gateway Fragment Routes
    // ========================================

    // GET /fragments/discord - Discord hub view
    if (path === "/fragments/discord") {
      const { renderDiscordHub } = await import("./templates.ts");
      const conversations = ctx.db.listConversationsBySource("discord");
      const gateway = ctx.getDiscordGateway();
      // Fix up conversation titles that contain channel IDs instead of names
      if (gateway) {
        for (const conv of conversations) {
          const ch = conv.sourceChannelId
            ? gateway.getChannels().get(conv.sourceChannelId)
            : undefined;
          if (ch?.name && conv.sourceServerName) {
            conv.title = `${conv.sourceServerName} > #${ch.name}`;
          } else if (ch?.name && !conv.sourceServerId) {
            conv.title = `DM > ${ch.name}`;
          }
        }
      }

      // Group channels by guild for hub display
      const channelsByGuild = new Map<
        string,
        Array<{ id: string; name: string }>
      >();
      if (gateway) {
        for (const [, ch] of gateway.getChannels()) {
          if (ch.type === 0 && ch.guild_id) {
            const list = channelsByGuild.get(ch.guild_id) ?? [];
            list.push({ id: ch.id, name: ch.name });
            channelsByGuild.set(ch.guild_id, list);
          }
        }
      }

      const html = renderDiscordHub({
        connected: gateway?.isConnected() ?? false,
        botUsername: gateway?.getBotUsername() ?? null,
        guildCount: gateway?.getGuilds().size ?? 0,
        guilds: [...(gateway?.getGuilds().entries() ?? [])].map(([id, g]) => ({
          id,
          name: g.name,
          memberCount: g.member_count,
          channels: channelsByGuild.get(id) ?? [],
        })),
        conversations,
        gatewayConfig: ctx.getDiscordGatewayConfig(),
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET /fragments/discord/channel/:channelId - Discord channel chat view
    if (path.match(/^\/fragments\/discord\/channel\//)) {
      const { renderDiscordChannelView } = await import("./templates.ts");
      const channelId = path.replace("/fragments/discord/channel/", "");
      const conv = ctx.db.getConversationByChannel(channelId);
      const messages = conv ? ctx.db.getMessages(conv.id) : [];
      let entityName = "Assistant";
      try {
        const gs = JSON.parse(
          await Deno.readTextFile(
            `${this.config.dataRoot}/.psycheros/general-settings.json`,
          ),
        );
        if (gs.entityName) entityName = gs.entityName;
      } catch {
        // fall back to default entityName if settings file is missing or malformed
      }
      // Look up channel mode and real name from gateway
      let channelMode: string | undefined;
      let realChannelName: string | undefined;
      const gwConfig = ctx.getDiscordGatewayConfig();
      const gateway = ctx.getDiscordGateway();
      if (channelId) {
        // Look up real name from gateway channel cache
        const cached = gateway?.getChannels()?.get(channelId);
        if (cached?.name) realChannelName = cached.name;
        // Look up mode from config
        if (gwConfig) {
          for (const server of gwConfig.servers) {
            const ch = server.channels.find((c) => c.channelId === channelId);
            if (ch) {
              channelMode = ch.mode;
              break;
            }
          }
        }
      }
      const html = renderDiscordChannelView(
        conv,
        messages,
        entityName,
        channelMode,
        realChannelName,
      );
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET /fragments/discord/dm-queue - DM approval queue view

    // GET /fragments/settings/connections/home - Home automation settings fragment
    if (path === "/fragments/settings/connections/home") {
      return handleConnectionsHomeFragment(ctx);
    }

    // GET /fragments/settings/connections/lovense - Lovense settings fragment
    if (path === "/fragments/settings/connections/lovense") {
      return handleConnectionsLovenseFragment(ctx);
    }

    // GET /fragments/settings/connections/buttplug - Buttplug settings fragment
    if (path === "/fragments/settings/connections/buttplug") {
      return handleConnectionsButtplugFragment(ctx);
    }

    // GET /fragments/settings/vision - Vision settings fragment
    if (path === "/fragments/settings/vision") {
      return handleVisionSettingsFragment(ctx);
    }

    // GET /fragments/settings/vision/generators - Generators tab content
    if (path === "/fragments/settings/vision/generators") {
      return handleVisionGeneratorsFragment(ctx);
    }

    // GET /fragments/settings/vision/anchors - Anchors tab content
    if (path === "/fragments/settings/vision/anchors") {
      return handleVisionAnchorsFragment(ctx);
    }

    // GET /fragments/settings/vision/gallery - Gallery tab content
    if (path === "/fragments/settings/vision/gallery") {
      return handleVisionGalleryFragment(ctx);
    }

    // GET /fragments/settings/vision/image-gen/new - Create new generator slot
    if (path === "/fragments/settings/vision/image-gen/new") {
      return handleVisionImageGenSlotFragment(ctx, crypto.randomUUID());
    }

    // GET /fragments/settings/vision/image-gen/:id - Image gen slot settings fragment
    const visionImageGenSlotMatch = path.match(
      /^\/fragments\/settings\/vision\/image-gen\/([^/]+)$/,
    );
    if (visionImageGenSlotMatch) {
      return handleVisionImageGenSlotFragment(ctx, visionImageGenSlotMatch[1]);
    }

    // Serve generated images from .psycheros/generated-images/
    if (path.startsWith("/generated-images/")) {
      return handleServeImageFile(ctx, path);
    }

    // Serve anchor images from .psycheros/anchors/
    if (path.startsWith("/anchors/")) {
      return handleServeImageFile(ctx, path);
    }

    // Serve chat attachments from .psycheros/chat-attachments/
    if (path.startsWith("/chat-attachments/")) {
      return handleServeImageFile(ctx, path);
    }

    // GET /fragments/settings/tools - Tools settings UI fragment
    if (path === "/fragments/settings/tools") {
      return handleToolsSettingsFragment(ctx);
    }

    // ========================================
    // Pulse Fragment Routes
    // ========================================

    // GET /fragments/settings/pulse - Main Pulse tabbed view
    if (path === "/fragments/settings/pulse") {
      return handlePulseFragment(ctx);
    }

    // GET /fragments/settings/pulse/new - New Pulse editor
    if (path === "/fragments/settings/pulse/new") {
      return handlePulseNewFragment(ctx);
    }

    // GET /fragments/settings/pulse/log - Execution log
    if (path === "/fragments/settings/pulse/log") {
      return handlePulseLogFragment(ctx, new URL(`http://localhost${path}`));
    }

    // GET /fragments/settings/pulse/list - Prompt list partial
    if (path === "/fragments/settings/pulse/list") {
      return handlePulseListFragment(ctx);
    }

    // GET /fragments/settings/pulse/:id/edit - Edit Pulse editor
    const pulseEditMatch = path.match(
      /^\/fragments\/settings\/pulse\/([^/]+)\/edit$/,
    );
    if (pulseEditMatch) {
      return handlePulseEditFragment(ctx, pulseEditMatch[1]);
    }

    // ========================================
    // Admin Panel Fragment Routes
    // ========================================

    // GET /fragments/admin - Admin hub
    if (path === "/fragments/admin") {
      return handleAdminFragment(ctx);
    }

    // GET /fragments/admin/logs - Log viewer
    if (path === "/fragments/admin/logs") {
      return handleAdminLogsFragment(ctx);
    }

    // GET /fragments/admin/diagnostics - Diagnostics dashboard
    if (path === "/fragments/admin/diagnostics") {
      return await handleAdminDiagnosticsFragment(ctx);
    }

    // GET /fragments/admin/jobs - Scheduled jobs dashboard
    if (path === "/fragments/admin/jobs") {
      return handleAdminJobsFragment(ctx);
    }

    // GET /fragments/admin/actions - Actions panel
    if (path === "/fragments/admin/actions") {
      return handleAdminActionsFragment(ctx);
    }

    // GET /fragments/admin/entity-data - Entity Data tab
    if (path === "/fragments/admin/entity-data") {
      return handleAdminEntityDataFragment(ctx);
    }

    // GET /fragments/voice-call/:conversationId - Voice call overlay fragment
    const voiceCallMatch = path.match(/^\/fragments\/voice-call\/([^/]+)$/);
    if (voiceCallMatch) {
      return handleVoiceCallFragment(ctx, voiceCallMatch[1]);
    }

    // GET /fragments/settings/voice - Voice profile hub
    if (path === "/fragments/settings/voice") {
      return handleVoiceSettingsHubFragment(ctx);
    }

    // GET /fragments/settings/voice/new - New voice profile form
    if (path === "/fragments/settings/voice/new") {
      return handleVoiceProfileEditFragment(ctx, null);
    }

    // GET /fragments/settings/voice/:id - Edit voice profile
    const voiceProfileMatch = path.match(
      /^\/fragments\/settings\/voice\/([^/]+)$/,
    );
    if (voiceProfileMatch) {
      return handleVoiceProfileEditFragment(ctx, voiceProfileMatch[1]);
    }

    // GET /backgrounds/:filename - Serve background image files
    if (path.startsWith("/backgrounds/")) {
      const filename = path.replace("/backgrounds/", "");
      return await handleServeBackground(ctx, filename);
    }

    // Serve static files from web/ directory
    return await handleStaticFile(ctx, path);
  }
}
