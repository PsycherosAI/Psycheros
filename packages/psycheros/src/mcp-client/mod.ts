/**
 * MCP Client Module
 *
 * Client for connecting to the entity-core MCP server.
 * Allows Psycheros harness to sync identity and memories with my core.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { join } from "@std/path";
import type { Granularity } from "../memory/types.ts";
import { getBroadcaster } from "../server/broadcaster.ts";
import type { PluginStatus } from "../../../plugin-api/src/mod.ts";

/**
 * Read the entity-core child's PID out of the MCP SDK's StdioClientTransport.
 * The SDK doesn't expose the child publicly — we reach into `_process` so
 * we can self-heal orphans across runs. If the field moves, we just lose the
 * orphan-reaping safety net and fall back on the SDK's own close path.
 */
function readChildPid(transport: Transport | null): number | null {
  if (!transport) return null;
  const t = transport as unknown as { _process?: { pid?: number } };
  return t._process?.pid ?? null;
}

/**
 * Extract text content from an MCP tool result.
 * Handles the union type that the SDK returns.
 */
function extractTextContent(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const r = result as Record<string, unknown>;
  if (!r.content || !Array.isArray(r.content)) {
    return null;
  }
  const firstBlock = r.content[0] as Record<string, unknown> | undefined;
  if (
    firstBlock && firstBlock.type === "text" &&
    typeof firstBlock.text === "string"
  ) {
    return firstBlock.text;
  }
  return null;
}

/**
 * Identity file structure from entity-core.
 */
export interface IdentityFile {
  category: "self" | "user" | "relationship" | "custom";
  filename: string;
  content: string;
  version: number;
  lastModified: string;
  modifiedBy: string;
  promptLabel?: string;
}

/**
 * All identity files grouped by category.
 */
export interface IdentityContent {
  self: IdentityFile[];
  user: IdentityFile[];
  relationship: IdentityFile[];
  custom: IdentityFile[];
}

/**
 * Memory entry for syncing with entity-core.
 */
export interface MemoryEntry {
  id: string;
  granularity: Granularity;
  date: string;
  content: string;
  chatIds: string[];
  sourceInstance: string;
  participatingInstances?: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  slug?: string;
}

/**
 * Extraction health diagnostics from entity-core.
 */
export interface ExtractionHealth {
  llmAvailable: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  attemptsTotal: number;
  successesTotal: number;
  nodesCreatedTotal: number;
  edgesCreatedTotal: number;
}

/**
 * Configuration for the MCP client.
 */
export interface MCPClientConfig {
  /** Command to run the MCP server */
  command: string;
  /** Arguments for the MCP server command */
  args?: string[];
  /** Environment variables for the MCP server */
  env?: Record<string, string>;
  /** This embodiment's ID */
  instanceId: string;
  /** Whether to pull canonical identity on connect. Default true. */
  syncOnStartup?: boolean;
  /** Fall back to local files if MCP is unavailable */
  offlineFallback?: boolean;
  /** Full path to deno executable (default: auto-detect) */
  denoPath?: string;
  /** Local project root — identity files synced here after pull (e.g. projectRoot) */
  localBasePath?: string;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Partial<MCPClientConfig> = {
  syncOnStartup: true,
  offlineFallback: true,
  denoPath: "deno",
};

/**
 * Local cache of identity content.
 */
interface LocalCache {
  identity: IdentityContent | null;
  lastSync: string | null;
}

/**
 * MCP Client for connecting to entity-core.
 */
export class MCPClient {
  private readonly config: MCPClientConfig;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private cache: LocalCache = {
    identity: null,
    lastSync: null,
  };
  private intentionalClose = false;
  private lastPingSuccess: Date | null = null;
  private lastPingAttempt: Date | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingInterval = 30000; // 30 seconds
  private wasAlive = true;
  private toolCallTimeoutMs = 60_000; // 60 seconds default for tool calls
  private pingTimeoutMs = 5_000; // 5 seconds for health probes
  /**
   * Auto-reconnect state. When the health ping detects entity-core is
   * dead, the watchdog schedules a restart with exponential backoff.
   */
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectBaseDelayMs = 5_000; // doubles each attempt
  private isReconnecting = false;
  /**
   * In-flight restart promise. Both the scheduled-reconnect timer and any
   * direct `restart()` caller share this so we never spawn two entity-core
   * subprocesses at once — that race was the root cause of the Windows
   * "database is locked" crash (two StdioClientTransport children opening
   * the same graph.db). Subsequent callers await the existing promise.
   */
  private restartInProgress: Promise<boolean> | null = null;
  /**
   * Number of MCP tool calls currently in flight. Used to suppress health-ping
   * reconnects — if a tool call is pending, entity-core is alive but busy.
   */
  private activeToolCalls = 0;
  /**
   * Scheduler used to durably enqueue identity-push jobs. Injected after
   * construction by the server (the scheduler is created later in the
   * startup sequence). When null I fall back to direct push attempts —
   * this only happens before the scheduler is wired up.
   */
  private scheduler:
    | import("../scheduler/mod.ts").Scheduler
    | null = null;

  constructor(config: MCPClientConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as MCPClientConfig;
  }

  /**
   * Wire the durable scheduler so identity-change pushes survive
   * crashes. Called by the server after both pieces are constructed.
   */
  setScheduler(
    scheduler: import("../scheduler/mod.ts").Scheduler,
  ): void {
    this.scheduler = scheduler;
  }

  /**
   * Call an MCP tool with a timeout. If entity-core hangs, the call
   * rejects after `timeoutMs` instead of blocking forever.
   */
  private async callToolWithTimeout(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!this.client) throw new Error("[MCP] Not connected");
    const ms = timeoutMs ?? this.toolCallTimeoutMs;
    this.activeToolCalls++;
    try {
      const result = await Promise.race([
        this.client.callTool({ name, arguments: args }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `[MCP] Tool call '${name}' timed out after ${ms}ms`,
                ),
              ),
            ms,
          )
        ),
      ]);
      return result;
    } finally {
      this.activeToolCalls--;
    }
  }

  /**
   * Broadcast an MCP status event to all connected SSE clients so the
   * UI can surface reconnection state to the user.
   */
  private broadcastMcpStatus(status: {
    connected: boolean;
    alive: boolean;
    reconnecting: boolean;
    attempt?: number;
    maxAttempts?: number;
    message?: string;
  }): void {
    try {
      getBroadcaster().broadcastEvent("mcp_status", status, null);
    } catch {
      // Broadcaster not initialized yet (early startup) — ignore
    }
  }

  /**
   * Path to the sidecar PID file we use to self-heal entity-core orphans
   * across psycheros runs. Returns `null` when localBasePath is unset.
   */
  private getChildPidFile(): string | null {
    if (!this.config.localBasePath) return null;
    return join(this.config.localBasePath, ".psycheros", "mcp-child.pid");
  }

  /**
   * If a prior psycheros run left a PID file behind, the previous entity-core
   * subprocess may be orphaned (reparented to init/launchd) and still holding
   * SQLite locks on the shared data dir. Reap it before we spawn a fresh one.
   */
  private async reapOrphanChild(): Promise<void> {
    const pidFile = this.getChildPidFile();
    if (!pidFile) return;
    let pid: number | undefined;
    try {
      const text = await Deno.readTextFile(pidFile);
      pid = parseInt(text.trim(), 10);
    } catch {
      return;
    }
    if (!pid || Number.isNaN(pid)) {
      await Deno.remove(pidFile).catch(() => {});
      return;
    }

    // Verify it's actually OUR entity-core before killing — PIDs get recycled,
    // and a different install dir's entity-core could legitimately exist on
    // the same machine. We match on the entity-core entry-point path that
    // was in our spawn args, falling back to a substring of "entity-core"
    // only when we can't derive a more specific marker. Path-separator-
    // agnostic so Windows backslash paths match too.
    const entityCoreScript = this.config.args?.find((a) =>
      a.endsWith("/mod.ts") || a.endsWith("\\mod.ts") ||
      a.endsWith("/src/mod.ts") || a.endsWith("\\src\\mod.ts")
    );
    const marker = entityCoreScript ?? "entity-core";
    const isOurs = await this.orphanBelongsToUs(pid, marker);

    if (isOurs) {
      try {
        Deno.kill(pid, "SIGKILL");
        console.log(`[MCP] Reaped orphan entity-core (pid=${pid})`);
      } catch {
        // Process already gone — no-op.
      }
    }

    await Deno.remove(pidFile).catch(() => {});
  }

  /**
   * Cross-platform "is this PID our entity-core?" check. POSIX uses `ps`,
   * Windows uses PowerShell's CIM provider (`ps` doesn't exist there, so
   * the previous Unix-only path silently skipped orphans on Windows and
   * let them hold SQLite locks forever).
   */
  private async orphanBelongsToUs(
    pid: number,
    marker: string,
  ): Promise<boolean> {
    try {
      if (Deno.build.os === "windows") {
        const cmd = new Deno.Command("powershell.exe", {
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
          ],
          stdout: "piped",
          stderr: "null",
        });
        const { code, stdout } = await cmd.output();
        if (code !== 0) return false;
        const cmdline = new TextDecoder().decode(stdout).trim();
        if (!cmdline) return false; // PID not found
        return cmdline.includes(marker);
      }
      const ps = new Deno.Command("ps", {
        args: ["-o", "command=", "-p", pid.toString()],
        stdout: "piped",
        stderr: "null",
      });
      const { code, stdout } = await ps.output();
      if (code !== 0) return false;
      const cmdline = new TextDecoder().decode(stdout);
      return cmdline.includes(marker);
    } catch {
      // Inspection tool unavailable — don't kill a PID we can't verify.
      return false;
    }
  }

  private async writeChildPid(): Promise<void> {
    const pidFile = this.getChildPidFile();
    if (!pidFile) return;
    const pid = readChildPid(this.transport);
    if (!pid) return;
    try {
      await Deno.mkdir(join(this.config.localBasePath!, ".psycheros"), {
        recursive: true,
      });
      await Deno.writeTextFile(pidFile, String(pid));
    } catch {
      // Best-effort — not having the file just means no self-heal next run.
    }
  }

  private async clearChildPid(): Promise<void> {
    const pidFile = this.getChildPidFile();
    if (!pidFile) return;
    await Deno.remove(pidFile).catch(() => {});
  }

  /**
   * Connect to the MCP server.
   *
   * @param options.skipSync - Skip the initial identity pull after
   *   connecting. Useful when reconnecting after a direct DB write
   *   (e.g. graph import) where entity-core may still be initialising
   *   and a premature pull could race with startup.
   */
  async connect(options?: { skipSync?: boolean }): Promise<boolean> {
    // Reset reconnect state for a fresh connection attempt.
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    try {
      this.intentionalClose = false;
      await this.reapOrphanChild();
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
      });

      this.client = new Client({
        name: "psycheros",
        version: "0.1.0",
      });

      // Listen for unexpected transport closes to keep state consistent
      this.transport.onclose = () => {
        if (!this.intentionalClose) {
          console.error(
            "[MCP] Transport closed unexpectedly — marking as disconnected",
          );
        }
        this.client = null;
        this.transport = null;
        this.intentionalClose = false;
      };

      await this.client.connect(this.transport);

      // Record the child PID so we can reap it next run if we crash mid-shutdown.
      await this.writeChildPid();

      console.log(
        `[MCP] Connected to entity-core as ${this.config.instanceId}`,
      );

      // Pull initial state if configured and not explicitly skipped.
      // Skipping is useful when reconnecting after a direct DB write
      // (e.g. graph import) where entity-core may still be initializing
      // and a premature pull could race with startup.
      if (this.config.syncOnStartup && !options?.skipSync) {
        await this.pull();
      }

      // Start health pings — pure liveness probe, not state mutation.
      // Periodic identity sync is now scheduler-driven; see server.ts.
      this.startHealthPing(30000);

      return true;
    } catch (error) {
      console.error("[MCP] Failed to connect:", error);

      // Clean up partially-created transport/client
      try {
        if (this.client) await this.client.close();
      } catch { /* ignore */ }
      this.client = null;
      this.transport = null;

      if (this.config.offlineFallback) {
        console.log("[MCP] Falling back to local files mode");
        return false;
      }

      throw error;
    }
  }

  /**
   * Disconnect from the MCP server. Pending identity-push jobs live in
   * the scheduler queue — they retry automatically on next boot — so I
   * have nothing to flush here.
   */
  async disconnect(): Promise<void> {
    // Stop health pings
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.lastPingSuccess = null;
    this.lastPingAttempt = null;
    this.wasAlive = true;

    // Close connection
    if (this.client) {
      this.intentionalClose = true;
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
      this.transport = null;
    }

    // Clean shutdown — remove the PID file so the next start doesn't try to
    // reap a process that no longer exists.
    await this.clearChildPid();

    console.log("[MCP] Disconnected from entity-core");
  }

  /**
   * Restart the MCP server connection with updated environment variables.
   * Disconnects (with sync), updates env vars, and reconnects.
   *
   * Mutex-guarded: if a restart is already in flight (scheduled reconnect
   * or another caller), awaits and returns its result instead of spawning
   * a second entity-core subprocess.
   *
   * @param newEnv - Environment variables to merge into the existing config
   */
  async restart(newEnv?: Record<string, string>): Promise<boolean> {
    if (this.restartInProgress) {
      // Another caller beat us to it. Merge any new env into the in-flight
      // restart's config — disconnect already ran, so the merge takes
      // effect on the next connect cycle if one follows.
      if (newEnv) this.config.env = { ...this.config.env, ...newEnv };
      return this.restartInProgress;
    }
    const p = this.doRestart(newEnv);
    this.restartInProgress = p;
    try {
      return await p;
    } finally {
      this.restartInProgress = null;
    }
  }

  private async doRestart(newEnv?: Record<string, string>): Promise<boolean> {
    console.log("[MCP] Restarting entity-core connection...");

    // Manual restart always gets a fresh attempt budget.
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    // Update env vars if provided
    if (newEnv) {
      this.config.env = { ...this.config.env, ...newEnv };
    }

    // Disconnect (marks as intentional so onclose doesn't log an error)
    this.intentionalClose = true;
    try {
      await this.disconnect();
    } catch {
      // Ignore disconnect errors during restart
    }

    // Reconnect
    return await this.connect();
  }

  /**
   * Check if connected to MCP server.
   */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Check if entity-core is alive (responding to pings).
   * Falls back to transport check if no ping has been sent yet.
   * Allows up to 2 missed pings before considering dead.
   */
  isAlive(): boolean {
    if (!this.client) return false;
    if (!this.lastPingAttempt) return true; // no ping yet, trust transport
    if (!this.lastPingSuccess) return false; // attempted but never succeeded
    const age = Date.now() - this.lastPingSuccess.getTime();
    return age < this.pingInterval * 2;
  }

  /**
   * Send a lightweight ping to entity-core by calling sync_status.
   * Returns true if entity-core responded, false otherwise.
   */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.callToolWithTimeout("sync_status", {}, this.pingTimeoutMs);
      this.lastPingSuccess = new Date();
      return true;
    } catch {
      return false;
    } finally {
      this.lastPingAttempt = new Date();
    }
  }

  /**
   * Start periodic health pings to entity-core.
   * Only logs state transitions to avoid flooding the log ring buffer.
   * When entity-core dies, triggers automatic reconnection with backoff.
   */
  private startHealthPing(intervalMs = 30000): void {
    this.pingInterval = intervalMs;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);

    this.pingTimer = setInterval(async () => {
      const ok = await this.ping();
      if (ok && !this.wasAlive) {
        this.wasAlive = true;
        this.reconnectAttempts = 0;
        console.error("[MCP] Entity-core is responsive again");
        this.broadcastMcpStatus({
          connected: true,
          alive: true,
          reconnecting: false,
          message: "Entity-core reconnected",
        });
      } else if (!ok && this.wasAlive) {
        // Don't declare entity-core dead while a tool call is in flight —
        // it's alive but busy processing the request and can't answer
        // pings (single-threaded stdio JSON-RPC). The tool call's own
        // timeout will handle the real hang.
        if (this.activeToolCalls > 0) {
          console.log(
            "[MCP] Health ping failed but tool call in progress — skipping reconnect",
          );
          return;
        }
        this.wasAlive = false;
        console.error("[MCP] Entity-core is not responding to pings");
        this.broadcastMcpStatus({
          connected: false,
          alive: false,
          reconnecting: false,
          message:
            "Entity-core disconnected — attempting automatic reconnect\u2026",
        });
        this.scheduleReconnect();
      }
    }, intervalMs);
  }

  /**
   * Schedule an automatic reconnection attempt with exponential backoff.
   * Caps at maxReconnectAttempts to avoid restart storms. A successful
   * ping or manual restart resets the counter.
   */
  private scheduleReconnect(): void {
    if (this.isReconnecting) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[MCP] Max reconnect attempts (${this.maxReconnectAttempts}) reached. ` +
          "Entity-core requires manual intervention.",
      );
      this.broadcastMcpStatus({
        connected: false,
        alive: false,
        reconnecting: false,
        attempt: this.maxReconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
        message:
          `Entity-core could not be recovered after ${this.maxReconnectAttempts} attempts. Restart required.`,
      });
      return;
    }

    const delay = this.reconnectBaseDelayMs *
      Math.pow(2, this.reconnectAttempts);
    const attempt = this.reconnectAttempts + 1;
    console.log(
      `[MCP] Reconnect attempt ${attempt}/${this.maxReconnectAttempts} in ${delay}ms`,
    );

    this.isReconnecting = true;
    this.broadcastMcpStatus({
      connected: false,
      alive: false,
      reconnecting: true,
      attempt,
      maxAttempts: this.maxReconnectAttempts,
      message:
        `Reconnecting to entity-core (attempt ${attempt}/${this.maxReconnectAttempts})\u2026`,
    });

    setTimeout(async () => {
      try {
        const ok = await this.restart();
        if (ok) {
          this.reconnectAttempts = 0;
          console.log("[MCP] Auto-reconnect succeeded");
        } else {
          this.reconnectAttempts++;
          console.error(
            `[MCP] Auto-reconnect attempt ${attempt} failed`,
          );
        }
      } catch (err) {
        this.reconnectAttempts++;
        console.error(
          `[MCP] Auto-reconnect attempt ${attempt} threw:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        this.isReconnecting = false;
        // If still dead after this attempt, scheduleReconnect will be
        // called again by the next ping cycle that detects failure.
      }
    }, delay);
  }

  /**
   * Get ping health data for diagnostics.
   */
  getPingHealth(): {
    lastPingSuccess: string | null;
    lastPingAttempt: string | null;
    alive: boolean;
    reconnecting: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
  } {
    return {
      lastPingSuccess: this.lastPingSuccess?.toISOString() ?? null,
      lastPingAttempt: this.lastPingAttempt?.toISOString() ?? null,
      alive: this.isAlive(),
      reconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
    };
  }

  /**
   * Get the timestamp of the last successful sync (pull or push).
   */
  getLastSyncTime(): string | null {
    return this.cache.lastSync;
  }

  /**
   * Pull identity and memories from entity-core.
   */
  async pull(): Promise<IdentityContent | null> {
    if (!this.client) {
      if (this.config.offlineFallback) {
        return this.cache.identity;
      }
      throw new Error("[MCP] Not connected to entity-core");
    }

    try {
      const result = await this.callToolWithTimeout("sync_pull", {
        instanceId: this.config.instanceId,
      }, 300_000);

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);

        if (response.success && response.identityFiles) {
          // Empty entity-core = "no opinion", not "authoritative
          // deletion". On a fresh install, src/init/mod.ts has just
          // templated identity files from
          // packages/psycheros/templates/identity/ with the wizard's
          // entity name substituted. Treating an empty pull response
          // as authoritative would have syncIdentityToLocal() then
          // wipe those templates, leaving the user with no identity
          // and the wrong name across the UI. Skip the local sync
          // entirely when entity-core has nothing to say; the
          // templated files stay sovereign until a real push happens.
          //
          // Users who *want* a clean identity reset use the launcher's
          // separate Re-init flow (which also re-runs the templates).
          const totalFiles = (response.identityFiles.self?.length ?? 0) +
            (response.identityFiles.user?.length ?? 0) +
            (response.identityFiles.relationship?.length ?? 0) +
            (response.identityFiles.custom?.length ?? 0);
          if (totalFiles === 0) {
            this.cache.lastSync = new Date().toISOString();
            console.log(
              "[MCP] entity-core has no identity files; keeping local templates",
            );
            return this.cache.identity;
          }

          // Suppress the no-op log: the scheduler fires this every 5
          // minutes and the admin log UI tails stderr directly, so an
          // unconditional line here buries real diagnostics inside a
          // couple of minutes. Only announce pulls that actually moved
          // state — first pull (cache null) or content differing.
          const prev = this.cache.identity;
          const changed = prev === null ||
            JSON.stringify(prev) !== JSON.stringify(response.identityFiles);

          this.cache.identity = response.identityFiles;
          this.cache.lastSync = new Date().toISOString();

          if (changed) {
            console.log("[MCP] Pulled identity from entity-core");
          }

          // Sync to local disk so Core Prompts UI stays current
          await this.syncIdentityToLocal();

          return this.cache.identity;
        }
      }

      return null;
    } catch (error) {
      console.error("[MCP] Pull failed:", error);

      if (this.config.offlineFallback) {
        return this.cache.identity;
      }

      throw error;
    }
  }

  /**
   * Sync cached identity files to local disk so the Core Prompts UI
   * (which reads from projectRoot/identity/) reflects MCP-canonical data.
   * Non-fatal — logs errors but never throws.
   */
  private async syncIdentityToLocal(): Promise<void> {
    if (!this.config.localBasePath || !this.cache.identity) return;

    const categories = ["self", "user", "relationship", "custom"] as const;
    let synced = 0;

    for (const category of categories) {
      const files = this.cache.identity[category] ?? [];
      const dir = `${this.config.localBasePath}/identity/${category}`;
      try {
        await Deno.mkdir(dir, { recursive: true });
      } catch { /* already exists */ }

      for (const file of files) {
        try {
          await Deno.writeTextFile(`${dir}/${file.filename}`, file.content);
          synced++;
        } catch (error) {
          console.error(
            `[MCP] Failed to sync ${category}/${file.filename} to local:`,
            error,
          );
        }
      }
    }

    if (synced > 0) {
      console.log(`[MCP] Synced ${synced} identity file(s) to local disk`);
    }
  }

  /**
   * Push a single identity change to entity-core. Called by the
   * `mcp.push-identity-change` scheduler handler — each queued change is
   * its own durable job, so this method handles exactly one write.
   *
   * Throws on connection failure or push rejection so the scheduler
   * marks the job `error` and retries (or `dead` after max_attempts).
   */
  async pushIdentityChange(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("[MCP] Not connected to entity-core");
    }

    const result = await this.callToolWithTimeout("sync_push", {
      instance: {
        id: this.config.instanceId,
        type: "psycheros",
        version: 1,
      },
      identityChanges: [{
        category,
        filename,
        content,
        version: 1,
        lastModified: new Date().toISOString(),
        modifiedBy: this.config.instanceId,
      }],
    });

    const textContent = extractTextContent(result);
    if (!textContent) {
      throw new Error("[MCP] sync_push returned no response");
    }
    const response = JSON.parse(textContent);
    if (!response.success) {
      throw new Error(
        `[MCP] sync_push rejected: ${response.error ?? "unknown error"}`,
      );
    }
    this.cache.lastSync = new Date().toISOString();
    if (response.conflicts && response.conflicts.length > 0) {
      console.warn("[MCP] Conflicts detected:", response.conflicts);
    }
  }

  /**
   * Load identity content (from cache or MCP).
   */
  async loadIdentity(): Promise<IdentityContent | null> {
    if (this.cache.identity) {
      return this.cache.identity;
    }

    return await this.pull();
  }

  /**
   * Write an identity file through MCP (source of truth).
   *
   * This is the primary method for writing identity files when MCP is enabled.
   * It pushes to entity-core, updates the local cache, and writes to local files
   * as an offline cache.
   *
   * @param category - The identity category (self, user, relationship, custom)
   * @param filename - The filename to write
   * @param content - The file content
   * @param localBasePath - Base path for local file storage (project root)
   */
  async writeIdentityFile(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    localBasePath: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const change = {
      category,
      filename,
      content,
      version: 1,
      lastModified: now,
      modifiedBy: this.config.instanceId,
    };

    let pushSucceeded = false;

    // Try to push to entity-core if connected
    if (this.client) {
      try {
        const result = await this.callToolWithTimeout("sync_push", {
          instance: {
            id: this.config.instanceId,
            type: "psycheros",
            version: 1,
          },
          identityChanges: [change],
          memoryChanges: [],
        });

        const textContent = extractTextContent(result);
        if (textContent) {
          const response = JSON.parse(textContent);
          if (!response.success) {
            console.error(
              "[MCP] Failed to push identity change:",
              response.error,
            );
            // Queue for retry
            this.queueIdentityChange(category, filename, content);
          } else {
            console.log(`[MCP] Pushed ${category}/${filename} to entity-core`);
            pushSucceeded = true;
          }
        } else {
          console.error("[MCP] Push returned empty response, queuing change");
          this.queueIdentityChange(category, filename, content);
        }
      } catch (error) {
        console.error("[MCP] Push failed, queuing change:", error);
        // Queue for later sync
        this.queueIdentityChange(category, filename, content);
      }
    } else {
      // Not connected - queue for later sync
      console.log(
        `[MCP] Not connected, queuing ${category}/${filename} for later sync`,
      );
      this.queueIdentityChange(category, filename, content);
    }

    // Update local cache
    this.updateLocalCache(category, filename, content, now);

    // Write to local file (offline cache)
    try {
      const filePath = `${localBasePath}/identity/${category}/${filename}`;
      await Deno.writeTextFile(filePath, content);
      console.log(`[MCP] Wrote ${category}/${filename} to local cache`);
    } catch (error) {
      console.error(
        `[MCP] Failed to write local cache for ${category}/${filename}:`,
        error,
      );
      // Don't fail - the MCP push/queue is more important
    }

    return pushSucceeded;
  }

  /**
   * Append content to an identity file via MCP.
   * Calls the identity_append tool on entity-core for server-side manipulation.
   */
  async appendIdentityFile(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; content?: string; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("identity_append", {
        category,
        filename,
        content,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          // Update local cache
          await Deno.writeTextFile(
            `${localBasePath}/identity/${category}/${filename}`,
            response.content,
          );
          this.updateLocalCache(
            category,
            filename,
            response.content,
            new Date().toISOString(),
          );
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_append failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Prepend content to an identity file via MCP.
   * Calls the identity_prepend tool on entity-core for server-side manipulation.
   */
  async prependIdentityFile(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; content?: string; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("identity_prepend", {
        category,
        filename,
        content,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          await Deno.writeTextFile(
            `${localBasePath}/identity/${category}/${filename}`,
            response.content,
          );
          this.updateLocalCache(
            category,
            filename,
            response.content,
            new Date().toISOString(),
          );
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_prepend failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Update a section in an identity file via MCP.
   * Calls the identity_update_section tool on entity-core for server-side manipulation.
   */
  async updateIdentitySection(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    section: string,
    content: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; content?: string; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("identity_update_section", {
        category,
        filename,
        section,
        content,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          await Deno.writeTextFile(
            `${localBasePath}/identity/${category}/${filename}`,
            response.content,
          );
          this.updateLocalCache(
            category,
            filename,
            response.content,
            new Date().toISOString(),
          );
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_update_section failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Rewrite a section in an identity file via MCP.
   * Calls the identity_rewrite_section tool on entity-core.
   */
  async rewriteIdentitySection(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    section: string,
    content: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; content?: string; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout(
        "identity_rewrite_section",
        {
          category,
          filename,
          section,
          content,
          instanceId: this.config.instanceId,
        },
      );

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          await Deno.writeTextFile(
            `${localBasePath}/identity/${category}/${filename}`,
            response.content,
          );
          this.updateLocalCache(
            category,
            filename,
            response.content,
            new Date().toISOString(),
          );
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_rewrite_section failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Get prompt labels for identity files via MCP.
   */
  async getIdentityMeta(
    category?: "self" | "user" | "relationship" | "custom",
  ): Promise<Record<string, string>> {
    if (!this.client) {
      return {};
    }

    try {
      const result = await this.callToolWithTimeout("identity_get_meta", {
        category,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success) {
          return response.meta;
        }
      }
      return {};
    } catch (error) {
      console.error("[MCP] identity_get_meta failed:", error);
      return {};
    }
  }

  /**
   * Set the prompt label for an identity file via MCP.
   */
  async setIdentityMeta(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    promptLabel: string,
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("identity_set_meta", {
        category,
        filename,
        promptLabel,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_set_meta failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Delete a custom identity file via MCP.
   * Calls the identity_delete_custom tool on entity-core.
   * Only custom files can be deleted.
   */
  async deleteCustomFile(
    filename: string,
    localBasePath?: string,
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.client) {
      return { success: false, message: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("identity_delete_custom", {
        filename,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && localBasePath) {
          // Delete from local cache
          if (this.cache.identity?.custom) {
            this.cache.identity.custom = this.cache.identity.custom.filter(
              (f) => f.filename !== filename,
            );
          }
          // Delete local file
          try {
            await Deno.remove(`${localBasePath}/identity/custom/${filename}`);
          } catch {
            // File may not exist locally, that's fine
          }
        }
        return response;
      }
      return { success: false, message: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] identity_delete_custom failed:", error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Update the local cache with a new/modified file.
   */
  private updateLocalCache(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
    lastModified: string,
  ): void {
    if (!this.cache.identity) {
      // Initialize empty cache structure
      this.cache.identity = {
        self: [],
        user: [],
        relationship: [],
        custom: [],
      };
    }

    const files = this.cache.identity[category];
    const existingIndex = files.findIndex((f) => f.filename === filename);

    const fileEntry: IdentityFile = {
      category,
      filename,
      content,
      version: existingIndex >= 0 ? files[existingIndex].version + 1 : 1,
      lastModified,
      modifiedBy: this.config.instanceId,
    };

    if (existingIndex >= 0) {
      files[existingIndex] = fileEntry;
    } else {
      files.push(fileEntry);
    }
  }

  /**
   * Queue an identity-file change for push to entity-core. Updates my
   * local cache immediately (so subsequent reads see the change) and
   * enqueues a durable job in the scheduler that pushes via MCP.
   *
   * Durability: if the process dies before the push lands, the job
   * stays `pending` and retries on next boot. There is no in-memory
   * write buffer to lose.
   */
  queueIdentityChange(
    category: "self" | "user" | "relationship" | "custom",
    filename: string,
    content: string,
  ): void {
    // Update local cache so subsequent reads see the change.
    if (this.cache.identity) {
      const files = this.cache.identity[category];
      const existingIndex = files.findIndex((f) => f.filename === filename);

      if (existingIndex >= 0) {
        files[existingIndex].content = content;
      } else {
        files.push({
          filename,
          content,
          version: 1,
          lastModified: new Date().toISOString(),
          modifiedBy: this.config.instanceId,
          category,
        });
      }
    }

    if (this.scheduler) {
      this.scheduler.enqueue({
        handler: "mcp.push-identity-change",
        payload: { category, filename, content },
        maxAttempts: 5,
      });
    } else {
      console.warn(
        "[MCP] Scheduler not wired; identity change for " +
          `${category}/${filename} cached locally but not enqueued for push`,
      );
    }
  }

  /**
   * Create a memory entry via MCP.
   */
  async createMemory(
    granularity: Granularity,
    date: string,
    content: string,
    chatIds: string[] = [],
    slug?: string,
  ): Promise<boolean> {
    if (!this.client) {
      console.error("[MCP] Not connected, cannot create memory");
      return false;
    }

    try {
      const result = await this.callToolWithTimeout("memory_create", {
        granularity,
        date,
        content,
        chatIds,
        instanceId: this.config.instanceId,
        ...(slug ? { slug } : {}),
      });

      // Check for MCP-level error
      const r = result as Record<string, unknown>;
      if (r.isError) {
        const errorText = extractTextContent(result) || "Unknown MCP error";
        throw new Error(errorText);
      }

      const textContent = extractTextContent(result);
      if (textContent) {
        try {
          const response = JSON.parse(textContent);
          return response.success;
        } catch {
          // Response wasn't JSON — treat as error
          throw new Error(textContent);
        }
      }

      return false;
    } catch (error) {
      console.error(
        "[MCP] Create memory failed:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Read a single memory entry via MCP.
   * Falls back to local file if MCP is not connected.
   */
  async readMemory(
    granularity: Granularity,
    date: string,
    slug?: string,
  ): Promise<MemoryEntry | null> {
    if (this.client) {
      try {
        const result = await this.callToolWithTimeout("memory_read", {
          granularity,
          date,
          ...(slug ? { slug } : {}),
        });

        const r = result as Record<string, unknown>;
        if (r.isError) {
          const errorText = extractTextContent(result) || "Unknown MCP error";
          console.error("[MCP] memory_read error:", errorText);
          return null;
        }

        const textContent = extractTextContent(result);
        if (textContent) {
          const response = JSON.parse(textContent);
          if (response.success && response.memory) {
            return response.memory;
          }
        }
        return null;
      } catch (error) {
        console.error(
          "[MCP] memory_read failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return null;
  }

  /**
   * Update (overwrite) a memory entry via MCP.
   */
  async updateMemory(
    granularity: Granularity,
    date: string,
    content: string,
    slug?: string,
  ): Promise<boolean> {
    if (!this.client) {
      console.error("[MCP] Not connected, cannot update memory");
      return false;
    }

    try {
      const result = await this.callToolWithTimeout("memory_update", {
        granularity,
        date,
        content,
        editedBy: this.config.instanceId,
        instanceId: this.config.instanceId,
        ...(slug ? { slug } : {}),
      });

      const r = result as Record<string, unknown>;
      if (r.isError) {
        const errorText = extractTextContent(result) || "Unknown MCP error";
        throw new Error(errorText);
      }

      const textContent = extractTextContent(result);
      if (textContent) {
        try {
          const response = JSON.parse(textContent);
          return response.success;
        } catch {
          throw new Error(textContent);
        }
      }

      return false;
    } catch (error) {
      console.error(
        "[MCP] memory_update failed:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Search memories via MCP.
   */
  async searchMemories(
    query: string,
    options?: {
      minScore?: number;
      maxResults?: number;
    },
  ): Promise<
    Array<{
      granularity: string;
      date: string;
      score: number;
      excerpt: string;
    }>
  > {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot search memories");
      return [];
    }

    try {
      const result = await this.callToolWithTimeout("memory_search", {
        query,
        instanceId: this.config.instanceId,
        minScore: options?.minScore,
        maxResults: options?.maxResults,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.results ?? [];
      }

      return [];
    } catch (error) {
      console.error("[MCP] Memory search failed:", error);
      return [];
    }
  }

  /**
   * Grep memories via MCP (plain-text keyword search).
   */
  async grepMemories(
    query: string,
    options?: {
      maxResults?: number;
    },
  ): Promise<
    Array<{
      granularity: string;
      date: string;
      slug?: string;
      title: string;
      score: number;
      context: string;
    }>
  > {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot grep memories");
      return [];
    }

    try {
      const result = await this.callToolWithTimeout("memory_grep", {
        query,
        maxResults: options?.maxResults,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.results ?? [];
      }

      return [];
    } catch (error) {
      console.error("[MCP] Memory grep failed:", error);
      return [];
    }
  }

  /**
   * List memories via MCP, optionally filtered by granularity.
   */
  async listMemories(
    granularity?: Granularity,
    limit: number = 50,
    options?: { offset?: number; beforeDate?: string; afterDate?: string },
  ): Promise<
    {
      memories: Array<
        {
          granularity: string;
          date: string;
          preview: string;
          sourceInstance?: string;
        }
      >;
      total: number;
    }
  > {
    if (!this.client) {
      console.error("[MCP] Not connected, cannot list memories");
      return { memories: [], total: 0 };
    }

    try {
      const result = await this.callToolWithTimeout("memory_list", {
        ...(granularity ? { granularity } : {}),
        limit,
        ...(options?.offset !== undefined ? { offset: options.offset } : {}),
        ...(options?.beforeDate ? { beforeDate: options.beforeDate } : {}),
        ...(options?.afterDate ? { afterDate: options.afterDate } : {}),
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          memories: response.memories ?? [],
          total: response.total ?? 0,
        };
      }

      return { memories: [], total: 0 };
    } catch (error) {
      console.error("[MCP] Memory list failed:", error);
      return { memories: [], total: 0 };
    }
  }

  /**
   * Delete a memory entry via MCP.
   */
  async deleteMemory(
    granularity: Granularity,
    date: string,
    slug?: string,
  ): Promise<boolean> {
    if (!this.client) {
      console.error("[MCP] Not connected, cannot delete memory");
      return false;
    }

    try {
      const result = await this.callToolWithTimeout("memory_delete", {
        granularity,
        date,
        ...(slug ? { slug } : {}),
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.success;
      }

      return false;
    } catch (error) {
      console.error("[MCP] Memory delete failed:", error);
      return false;
    }
  }

  /**
   * Get pending identity-push count, derived from the scheduler's
   * pending `mcp.push-identity-change` jobs.
   */
  getPendingCount(): { identity: number } {
    if (!this.scheduler) return { identity: 0 };
    const { total } = this.scheduler.listJobRuns({
      handler: "mcp.push-identity-change",
      status: "pending",
      limit: 1,
    });
    return { identity: total };
  }

  /**
   * Create a snapshot of all identity files via MCP.
   */
  async createSnapshot(): Promise<{
    success: boolean;
    snapshots?: Array<{
      id: string;
      category: string;
      filename: string;
      timestamp: string;
    }>;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("snapshot_create", {});

      const textContent = extractTextContent(result);
      if (textContent) {
        return JSON.parse(textContent);
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] snapshot_create failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * List available snapshots via MCP.
   */
  async listSnapshots(options?: {
    category?: string;
    filename?: string;
  }): Promise<{
    success: boolean;
    snapshots?: Array<{
      id: string;
      category: string;
      filename: string;
      timestamp: string;
      date: string;
      reason: string;
    }>;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("snapshot_list", {
        category: options?.category,
        filename: options?.filename,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        return JSON.parse(textContent);
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] snapshot_list failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get snapshot content via MCP.
   */
  async getSnapshotContent(snapshotId: string): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("snapshot_get", {
        snapshotId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success && response.content) {
          return { success: true, content: response.content };
        }
        return {
          success: false,
          error: response.error || "Failed to get snapshot content",
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] getSnapshotContent failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Restore a snapshot via MCP.
   */
  async restoreSnapshot(snapshotId: string): Promise<{
    success: boolean;
    message?: string;
    error?: string;
  }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("snapshot_restore", {
        snapshotId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        if (response.success) {
          // Pull to update local cache
          await this.pull();
        }
        return response;
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] snapshot_restore failed:", error);
      return { success: false, error: String(error) };
    }
  }

  // ========================================
  // GRAPH METHODS
  // ========================================

  /**
   * Get graph statistics via MCP.
   */
  async getGraphStats(): Promise<
    {
      totalNodes: number;
      totalEdges: number;
      nodesByType: Record<string, number>;
      edgesByType: Record<string, number>;
      vectorSearchAvailable: boolean;
    } | null
  > {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot get graph stats");
      return null;
    }

    try {
      const result = await this.callToolWithTimeout("graph_stats", {});

      const textContent = extractTextContent(result);
      if (textContent) {
        return JSON.parse(textContent);
      }
      return null;
    } catch (error) {
      console.error("[MCP] Graph stats failed:", error);
      return null;
    }
  }

  /**
   * Get extraction health diagnostics from entity-core.
   * Calls sync_status and returns the extraction sub-object.
   */
  async getExtractionHealth(): Promise<ExtractionHealth | null> {
    if (!this.client) {
      return null;
    }

    try {
      const result = await this.callToolWithTimeout("sync_status", {});

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.extraction ?? null;
      }
      return null;
    } catch (error) {
      console.error("[MCP] Get extraction health failed:", error);
      return null;
    }
  }

  /**
   * Get trusted local plugin activation status from entity-core.
   */
  async getPluginStatuses(): Promise<PluginStatus[]> {
    if (!this.client) return [];

    try {
      const result = await this.callToolWithTimeout("plugin_status", {});
      const textContent = extractTextContent(result);
      return textContent ? JSON.parse(textContent) : [];
    } catch (error) {
      console.error("[MCP] Get plugin status failed:", error);
      return [];
    }
  }

  /**
   * Get all nodes via MCP.
   */
  async getGraphNodes(options?: {
    type?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      type: string;
      label: string;
      description: string;
      confidence: number;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot get graph nodes");
      return [];
    }

    try {
      const result = await this.callToolWithTimeout("graph_node_list", {
        type: options?.type,
        limit: options?.limit ?? 500,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.nodes ?? [];
      }
      return [];
    } catch (error) {
      console.error("[MCP] Get graph nodes failed:", error);
      return [];
    }
  }

  /**
   * Get edges via MCP.
   */
  async getGraphEdges(options?: {
    fromId?: string;
    toId?: string;
    type?: string;
  }): Promise<
    Array<{
      id: string;
      fromId: string;
      toId: string;
      type: string;
      customType?: string;
      weight: number;
    }>
  > {
    if (!this.client) {
      console.log("[MCP] Not connected, cannot get graph edges");
      return [];
    }

    try {
      const result = await this.callToolWithTimeout("graph_edge_get", {
        fromId: options?.fromId,
        toId: options?.toId,
        type: options?.type,
        onlyValid: true,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return response.edges ?? [];
      }
      return [];
    } catch (error) {
      console.error("[MCP] Get graph edges failed:", error);
      return [];
    }
  }

  /**
   * Create a graph node via MCP.
   */
  async createGraphNode(input: {
    type: string;
    label: string;
    description?: string;
    properties?: Record<string, unknown>;
    confidence?: number;
    sourceMemoryId?: string;
    embedding?: number[];
  }): Promise<{ success: boolean; nodeId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      // Auto-generate embedding if not provided
      let embedding = input.embedding;
      if (!embedding) {
        try {
          const { getEmbedder } = await import("../rag/embedder.ts");
          const embedder = getEmbedder();
          embedding = await embedder.embed(
            `${input.label} ${input.description || ""}`,
          );
        } catch (e) {
          console.warn("[MCP] Failed to generate embedding for graph node:", e);
        }
      }

      const result = await this.callToolWithTimeout("graph_node_create", {
        type: input.type,
        label: input.label,
        description: input.description,
        properties: input.properties ?? {},
        confidence: input.confidence ?? 0.5,
        sourceMemoryId: input.sourceMemoryId,
        embedding,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          nodeId: response.node?.id,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Create graph node failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Create a graph edge via MCP.
   */
  async createGraphEdge(input: {
    fromId: string;
    toId: string;
    type: string;
    customType?: string;
    weight?: number;
    evidence?: string;
  }): Promise<{ success: boolean; edgeId?: string; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("graph_edge_create", {
        fromId: input.fromId,
        toId: input.toId,
        type: input.type,
        customType: input.customType,
        weight: input.weight ?? 0.5,
        evidence: input.evidence,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          edgeId: response.edge?.id,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Create graph edge failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Delete a graph node via MCP.
   */
  async deleteGraphNode(
    nodeId: string,
    permanent = false,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("graph_node_delete", {
        id: nodeId,
        permanent,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Delete graph node failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Delete a graph edge via MCP.
   */
  async deleteGraphEdge(
    edgeId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("graph_edge_delete", {
        id: edgeId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Delete graph edge failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get a single graph node by ID via MCP.
   */
  async getGraphNode(nodeId: string): Promise<
    {
      id: string;
      type: string;
      label: string;
      description: string;
      confidence: number;
    } | null
  > {
    if (!this.client) {
      return null;
    }

    try {
      const result = await this.callToolWithTimeout("graph_node_get", {
        id: nodeId,
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return null;
      }

      const response = JSON.parse(textContent);
      return response.node ?? null;
    } catch (error) {
      console.error("[MCP] Get graph node failed:", error);
      return null;
    }
  }

  /**
   * Search graph nodes via MCP.
   */
  async searchGraphNodes(
    query: string,
    type?: string,
    limit?: number,
    minScore?: number,
  ): Promise<
    Array<{
      id: string;
      type: string;
      label: string;
      description: string;
      confidence: number;
      createdAt: string;
      updatedAt: string;
      score: number;
    }>
  > {
    if (!this.client) {
      return [];
    }

    try {
      // Generate query embedding for semantic search
      let queryEmbedding: number[] | undefined;
      try {
        const { getEmbedder } = await import("../rag/embedder.ts");
        const embedder = getEmbedder();
        queryEmbedding = await embedder.embed(query);
      } catch (e) {
        console.warn(
          "[MCP] Failed to generate query embedding, falling back to text search:",
          e,
        );
      }

      const result = await this.callToolWithTimeout("graph_node_search", {
        query,
        queryEmbedding,
        type,
        limit: limit ?? 10,
        minScore: minScore ?? 0.3,
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return [];
      }

      const response = JSON.parse(textContent);
      return (response.results ?? []).map((
        r: {
          node: {
            id: string;
            type: string;
            label: string;
            description: string;
            confidence: number;
            createdAt: string;
            updatedAt: string;
          };
          score: number;
        },
      ) => ({
        id: r.node.id,
        type: r.node.type,
        label: r.node.label,
        description: r.node.description,
        confidence: r.node.confidence,
        createdAt: r.node.createdAt,
        updatedAt: r.node.updatedAt,
        score: r.score,
      }));
    } catch (error) {
      console.error("[MCP] Search graph nodes failed:", error);
      return [];
    }
  }

  /**
   * Traverse graph from a starting node.
   */
  async traverseGraph(
    startNodeId: string,
    direction?: "out" | "in" | "both",
    maxDepth?: number,
    edgeTypes?: string[],
  ): Promise<{
    startNode?: { id: string; label: string; type: string };
    results: Array<{
      node: { id: string; label: string; type: string; description?: string };
      path: string[];
      depth: number;
    }>;
  }> {
    if (!this.client) {
      return { startNode: undefined, results: [] };
    }

    try {
      const result = await this.callToolWithTimeout("graph_traverse", {
        startNodeId,
        direction: direction ?? "both",
        maxDepth: maxDepth ?? 2,
        edgeTypes,
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return { startNode: undefined, results: [] };
      }

      const response = JSON.parse(textContent);
      return {
        startNode: response.startNode
          ? {
            id: response.startNode.id,
            label: response.startNode.label,
            type: response.startNode.type,
          }
          : undefined,
        results: (response.results ?? []).map((
          r: {
            node: {
              id: string;
              label: string;
              type: string;
              description?: string;
            };
            path: string[];
            depth: number;
          },
        ) => ({
          node: {
            id: r.node.id,
            label: r.node.label,
            type: r.node.type,
            description: r.node.description,
          },
          path: r.path,
          depth: r.depth,
        })),
      };
    } catch (error) {
      console.error("[MCP] Traverse graph failed:", error);
      return { startNode: undefined, results: [] };
    }
  }

  /**
   * Get a subgraph centered on a node.
   */
  async getGraphSubgraph(
    nodeId: string,
    depth?: number,
  ): Promise<{
    node?: { id: string; label: string; type: string };
    nodes: Array<
      { id: string; label: string; type: string; description?: string }
    >;
    edges: Array<
      {
        id: string;
        fromId: string;
        toId: string;
        type: string;
        customType?: string;
        weight: number;
      }
    >;
  }> {
    if (!this.client) {
      return { node: undefined, nodes: [], edges: [] };
    }

    try {
      const result = await this.callToolWithTimeout("graph_subgraph", {
        nodeId,
        depth: depth ?? 2,
      });

      const textContent = extractTextContent(result);
      if (!textContent) {
        return { node: undefined, nodes: [], edges: [] };
      }

      const response = JSON.parse(textContent);
      return {
        node: response.node
          ? {
            id: response.node.id,
            label: response.node.label,
            type: response.node.type,
          }
          : undefined,
        nodes: (response.nodes ?? []).map((
          n: { id: string; label: string; type: string; description?: string },
        ) => ({
          id: n.id,
          label: n.label,
          type: n.type,
          description: n.description,
        })),
        edges: (response.edges ?? []).map((
          e: {
            id: string;
            fromId: string;
            toId: string;
            type: string;
            customType?: string;
            weight: number;
          },
        ) => ({
          id: e.id,
          fromId: e.fromId,
          toId: e.toId,
          type: e.type,
          customType: e.customType,
          weight: e.weight ?? 0.5,
        })),
      };
    } catch (error) {
      console.error("[MCP] Get graph subgraph failed:", error);
      return { node: undefined, nodes: [], edges: [] };
    }
  }

  /**
   * Update a graph node via MCP.
   */
  async updateGraphNode(id: string, input: {
    type?: string;
    label?: string;
    description?: string;
    properties?: Record<string, unknown>;
    confidence?: number;
    lastConfirmedAt?: string;
    embedding?: number[];
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      // Re-generate embedding if label or description changed
      let embedding = input.embedding;
      if (!embedding && (input.label || input.description)) {
        try {
          const { getEmbedder } = await import("../rag/embedder.ts");
          const embedder = getEmbedder();
          const text = `${input.label || ""} ${input.description || ""}`.trim();
          if (text) {
            embedding = await embedder.embed(text);
          }
        } catch (e) {
          console.warn(
            "[MCP] Failed to generate embedding for node update:",
            e,
          );
        }
      }

      const result = await this.callToolWithTimeout("graph_node_update", {
        id,
        type: input.type,
        label: input.label,
        description: input.description,
        properties: input.properties,
        confidence: input.confidence,
        lastConfirmedAt: input.lastConfirmedAt,
        embedding,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Update graph node failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Update a graph edge via MCP.
   */
  async updateGraphEdge(id: string, input: {
    type?: string;
    customType?: string;
    properties?: Record<string, unknown>;
    weight?: number;
    evidence?: string;
    validUntil?: string;
    lastConfirmedAt?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "MCP not connected" };
    }

    try {
      const result = await this.callToolWithTimeout("graph_edge_update", {
        id,
        ...input,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          error: response.success ? undefined : response.message,
        };
      }
      return { success: false, error: "No response from MCP" };
    } catch (error) {
      console.error("[MCP] Update graph edge failed:", error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Create multiple nodes and edges in a single transaction via MCP.
   * Auto-generates embeddings for each node.
   */
  async writeGraphTransaction(input: {
    nodes?: Array<{
      type: string;
      label: string;
      description?: string;
      properties?: Record<string, unknown>;
      confidence?: number;
      sourceMemoryId?: string;
      firstLearnedAt?: string;
    }>;
    edges?: Array<{
      fromLabel: string;
      toLabel: string;
      type: string;
      customType?: string;
      properties?: Record<string, unknown>;
      weight?: number;
      evidence?: string;
      occurredAt?: string;
      validUntil?: string;
    }>;
  }): Promise<
    {
      success: boolean;
      nodesCreated: number;
      edgesCreated: number;
      error?: string;
    }
  > {
    if (!this.client) {
      return {
        success: false,
        nodesCreated: 0,
        edgesCreated: 0,
        error: "MCP not connected",
      };
    }

    try {
      // Generate embeddings for all nodes
      const nodesWithEmbeddings = [];
      if (input.nodes) {
        let embedder: { embed: (text: string) => Promise<number[]> } | null =
          null;
        try {
          const { getEmbedder } = await import("../rag/embedder.ts");
          embedder = getEmbedder();
        } catch (e) {
          console.warn("[MCP] Failed to load embedder for batch:", e);
        }

        for (const node of input.nodes) {
          let embedding: number[] | undefined;
          if (embedder) {
            try {
              embedding = await embedder.embed(
                `${node.label} ${node.description || ""}`,
              );
            } catch (e) {
              console.warn(`[MCP] Failed to embed node "${node.label}":`, e);
            }
          }
          nodesWithEmbeddings.push({ ...node, embedding });
        }
      }

      const result = await this.callToolWithTimeout("graph_write_transaction", {
        nodes: nodesWithEmbeddings.length > 0 ? nodesWithEmbeddings : undefined,
        edges: input.edges,
        instanceId: this.config.instanceId,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          nodesCreated: response.nodesCreated ?? 0,
          edgesCreated: response.edgesCreated ?? 0,
          error: response.success ? undefined : response.message,
        };
      }
      return {
        success: false,
        nodesCreated: 0,
        edgesCreated: 0,
        error: "No response from MCP",
      };
    } catch (error) {
      console.error("[MCP] Write graph transaction failed:", error);
      return {
        success: false,
        nodesCreated: 0,
        edgesCreated: 0,
        error: String(error),
      };
    }
  }

  /**
   * Run memory consolidation via entity-core's memory_consolidate tool.
   */
  async consolidateMemories(options?: {
    granularity?: "weekly" | "monthly" | "yearly";
    targetDate?: string;
    all?: boolean;
  }): Promise<{
    success: boolean;
    consolidations: Array<
      { granularity: string; dateStr: string; success: boolean; error?: string }
    >;
    message: string;
  }> {
    if (!this.client) {
      return {
        success: false,
        consolidations: [],
        message: "MCP not connected — consolidation requires entity-core",
      };
    }

    try {
      const result = await this.callToolWithTimeout("memory_consolidate", {
        granularity: options?.granularity,
        targetDate: options?.targetDate,
        all: options?.all,
      });

      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: response.success,
          consolidations: response.consolidations ?? [],
          message: response.message ?? "Consolidation complete",
        };
      }
      return {
        success: false,
        consolidations: [],
        message: "No response from MCP",
      };
    } catch (error) {
      console.error("[MCP] Memory consolidation failed:", error);
      return { success: false, consolidations: [], message: String(error) };
    }
  }

  async purgeEmbeddings(): Promise<{
    success: boolean;
    purged: number;
    remaining: number;
    message: string;
  }> {
    if (!this.client) {
      return {
        success: false,
        purged: 0,
        remaining: 0,
        message: "MCP not connected",
      };
    }
    try {
      const result = await this.callToolWithTimeout(
        "memory_embedding_purge",
        {},
      );
      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: true,
          purged: response.purged ?? 0,
          remaining: response.remaining ?? 0,
          message: response.message ?? "Purge complete",
        };
      }
      return {
        success: false,
        purged: 0,
        remaining: 0,
        message: "No response from MCP",
      };
    } catch (error) {
      console.error("[MCP] Embedding purge failed:", error);
      return {
        success: false,
        purged: 0,
        remaining: 0,
        message: String(error),
      };
    }
  }

  async rebuildEmbeddings(): Promise<{
    success: boolean;
    rebuilt: number;
    failed: number;
    total: number;
    message: string;
  }> {
    if (!this.client) {
      return {
        success: false,
        rebuilt: 0,
        failed: 0,
        total: 0,
        message: "MCP not connected",
      };
    }
    try {
      const result = await this.callToolWithTimeout(
        "memory_embedding_rebuild",
        {},
        600000,
      );
      const textContent = extractTextContent(result);
      if (textContent) {
        const response = JSON.parse(textContent);
        return {
          success: true,
          rebuilt: response.rebuilt ?? 0,
          failed: response.failed ?? 0,
          total: response.total ?? 0,
          message: response.message ?? "Rebuild complete",
        };
      }
      return {
        success: false,
        rebuilt: 0,
        failed: 0,
        total: 0,
        message: "No response from MCP",
      };
    } catch (error) {
      console.error("[MCP] Embedding rebuild failed:", error);
      return {
        success: false,
        rebuilt: 0,
        failed: 0,
        total: 0,
        message: String(error),
      };
    }
  }
}

/**
 * Create an MCP client instance.
 */
export function createMCPClient(config: MCPClientConfig): MCPClient {
  return new MCPClient(config);
}
