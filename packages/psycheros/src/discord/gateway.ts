/**
 * Discord Gateway Client
 *
 * Lightweight Discord Gateway (WebSocket) client using raw WebSocket.
 * Handles heartbeat, reconnect, resume, and event dispatch.
 * No external dependencies — implements the Discord Gateway protocol directly.
 */

import type { DiscordGatewayConfig } from "../llm/discord-settings.ts";

// =============================================================================
// Types
// =============================================================================

export type GatewayEventType =
  | "READY"
  | "RESUMED"
  | "MESSAGE_CREATE"
  | "MESSAGE_UPDATE"
  | "MESSAGE_DELETE"
  | "GUILD_CREATE"
  | "GUILD_DELETE"
  | "CHANNEL_CREATE"
  | "CHANNEL_DELETE"
  | "GUILD_MEMBER_ADD"
  | "INTERACTION_CREATE";

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name: string | null;
  bot: boolean;
}

export interface DiscordMember {
  user: DiscordUser;
  nick: string | null;
  roles: string[];
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author: DiscordUser;
  member: DiscordMember | null;
  content: string;
  mention_everyone: boolean;
  mentions: DiscordUser[];
  mention_roles: string[];
  reference:
    | { message_id: string; channel_id: string; guild_id?: string }
    | null;
  timestamp: string;
  edited_timestamp: string | null;
  type: number;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  member_count: number;
  channels?: DiscordChannel[];
}

export interface DiscordChannel {
  id: string;
  name: string;
  guild_id: string | null;
  type: number;
  topic: string | null;
  parent_id: string | null;
}

export interface GatewayPayload {
  op: number;
  d?: unknown;
  t?: string;
  s?: number;
}

export interface GatewayIdentify {
  token: string;
  intents: number;
  properties: {
    os: string;
    browser: string;
    device: string;
  };
}

export interface GatewayReady {
  user: DiscordUser;
  guilds: Array<{ id: string; unavailable: boolean }>;
  session_id: string;
  resume_gateway_url: string;
}

export type GatewayEventHandler = (
  event: GatewayEventType,
  data: unknown,
) => void;

// =============================================================================
// Intents
// =============================================================================

const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

// Gateway intents needed: guilds, guild messages, DMs, message content
const REQUIRED_INTENTS = INTENTS.GUILDS |
  INTENTS.GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGES |
  INTENTS.MESSAGE_CONTENT;

// =============================================================================
// Gateway Opcodes
// =============================================================================

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  STATUS_UPDATE: 3,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// =============================================================================
// DiscordGatewayClient
// =============================================================================

export class DiscordGatewayClient {
  private ws: WebSocket | null = null;
  private token: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAcked = true;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private sequence: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private closed = false;
  private handlers: Map<string, Set<GatewayEventHandler>> = new Map();
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private guilds: Map<string, DiscordGuild> = new Map();
  private channels: Map<string, DiscordChannel> = new Map();

  constructor(token: string, _config?: DiscordGatewayConfig) {
    this.token = token;
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  on(event: GatewayEventType, handler: GatewayEventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: GatewayEventType, handler: GatewayEventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  private dispatch(event: GatewayEventType, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(event, data);
      } catch (error) {
        console.error(`[Discord] Handler error for ${event}:`, error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.closed = false;
    const gatewayUrl = await this.getGatewayUrl();
    const wsUrl = `${gatewayUrl}/?v=10&encoding=json`;
    return this.connectWs(wsUrl);
  }

  private connectWs(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);
      } catch (error) {
        reject(error);
        return;
      }

      this.ws.onopen = () => {
        console.log("[Discord] WebSocket connected");
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data as string) as GatewayPayload;
          this.handlePayload(payload, resolve);
        } catch (error) {
          console.error("[Discord] Failed to parse message:", error);
        }
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(
          `[Discord] WebSocket closed: code=${event.code}, reason=${event.reason}`,
        );
        this.cleanupHeartbeat();
        if (!this.closed && event.code !== 4004) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (event: Event) => {
        console.error("[Discord] WebSocket error:", event);
        this.cleanupHeartbeat();
        if (!this.closed) {
          this.scheduleReconnect();
        }
      };
    });
  }

  disconnect(): void {
    this.closed = true;
    this.cleanupHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, "Client disconnect");
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.sessionId = null;
    this.sequence = null;
    this.botUserId = null;
    this.guilds.clear();
    this.channels.clear();
    console.log("[Discord] Disconnected");
  }

  // -------------------------------------------------------------------------
  // Gateway URL
  // -------------------------------------------------------------------------

  private async getGatewayUrl(): Promise<string> {
    try {
      const resp = await fetch("https://discord.com/api/v10/gateway", {
        headers: { Authorization: `Bot ${this.token}` },
      });
      if (resp.ok) {
        const data = await resp.json() as { url: string };
        return data.url;
      }
    } catch (error) {
      console.warn(
        "[Discord] Failed to get gateway URL, using default:",
        error,
      );
    }
    return "wss://gateway.discord.gg";
  }

  // -------------------------------------------------------------------------
  // Payload handling
  // -------------------------------------------------------------------------

  private handlePayload(
    payload: GatewayPayload,
    readyResolve?: () => void,
  ): void {
    const { op, d, t, s } = payload;

    if (s !== null && s !== undefined) {
      this.sequence = s;
    }

    switch (op) {
      case OP.HELLO: {
        const hello = d as { heartbeat_interval: number };
        this.startHeartbeat(hello.heartbeat_interval);
        if (this.sessionId && this.resumeUrl) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }

      case OP.HEARTBEAT_ACK:
        this.lastHeartbeatAcked = true;
        break;

      case OP.RECONNECT:
        console.log("[Discord] Server requested reconnect");
        this.closeAndReconnect();
        break;

      case OP.INVALID_SESSION: {
        const resumable = d as boolean;
        console.log(`[Discord] Invalid session, resumable=${resumable}`);
        this.sessionId = null;
        this.sequence = null;
        if (resumable) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }

      case OP.DISPATCH: {
        if (!t) break;
        switch (t) {
          case "READY": {
            const ready = d as GatewayReady;
            this.sessionId = ready.session_id;
            this.resumeUrl = ready.resume_gateway_url;
            this.botUserId = ready.user.id;
            this.botUsername = ready.user.username;
            console.log(
              `[Discord] Ready: logged in as ${ready.user.username} (${ready.user.id})`,
            );
            console.log(`[Discord] ${ready.guilds.length} guild(s) available`);
            readyResolve?.();
            break;
          }
          case "RESUMED":
            console.log("[Discord] Session resumed");
            readyResolve?.();
            break;
          case "GUILD_CREATE": {
            const guild = d as DiscordGuild;
            this.guilds.set(guild.id, guild);
            // Extract channels from the guild payload — Discord sends them in GUILD_CREATE
            const rawChannels = (d as Record<string, unknown>).channels;
            if (Array.isArray(rawChannels)) {
              for (const ch of rawChannels) {
                const c = ch as DiscordChannel;
                if (c.id) {
                  c.guild_id = c.guild_id ?? guild.id;
                  this.channels.set(c.id, c);
                }
              }
            } else {
              console.log(
                `[Discord] GUILD_CREATE ${guild.name}: no channels array in payload, keys:`,
                Object.keys(d as Record<string, unknown>).join(", "),
              );
            }
            break;
          }
          case "GUILD_DELETE": {
            const guild = d as DiscordGuild;
            this.guilds.delete(guild.id);
            break;
          }
          case "CHANNEL_CREATE":
          case "CHANNEL_DELETE": {
            const channel = d as DiscordChannel;
            if (t === "CHANNEL_CREATE") {
              this.channels.set(channel.id, channel);
            } else {
              this.channels.delete(channel.id);
            }
            break;
          }
          default:
            break;
        }
        this.dispatch(t as GatewayEventType, d);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(intervalMs: number): void {
    this.cleanupHeartbeat();
    // Discord recommends a small random jitter
    const jittered = intervalMs * (0.9 + Math.random() * 0.2);

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.cleanupHeartbeat();
        return;
      }
      if (!this.lastHeartbeatAcked) {
        console.warn("[Discord] Heartbeat not ACKed, reconnecting...");
        this.closeAndReconnect();
        return;
      }
      this.lastHeartbeatAcked = false;
      this.send({ op: OP.HEARTBEAT, d: this.sequence });
    }, jittered);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Identify / Resume
  // -------------------------------------------------------------------------

  private sendIdentify(): void {
    const payload: GatewayPayload = {
      op: OP.IDENTIFY,
      d: {
        token: this.token,
        intents: REQUIRED_INTENTS,
        properties: {
          os: "linux",
          browser: "psycheros",
          device: "psycheros",
        },
      },
    };
    this.send(payload);
    console.log("[Discord] Sent IDENTIFY");
  }

  private sendResume(): void {
    if (!this.sessionId) return;
    const payload: GatewayPayload = {
      op: OP.RESUME,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    };
    this.send(payload);
    console.log("[Discord] Sent RESUME");
  }

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  private closeAndReconnect(): void {
    this.cleanupHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(4000, "Reconnecting");
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[Discord] Max reconnect attempts reached, giving up");
      return;
    }
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      30000,
    );
    this.reconnectAttempts++;
    console.log(
      `[Discord] Reconnecting in ${
        Math.round(delay)
      }ms (attempt ${this.reconnectAttempts})`,
    );
    setTimeout(() => {
      if (this.closed) return;
      const url = this.resumeUrl
        ? `${this.resumeUrl}/?v=10&encoding=json`
        : `${"wss://gateway.discord.gg"}/?v=10&encoding=json`;
      this.connectWs(url);
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  private send(payload: GatewayPayload): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // -------------------------------------------------------------------------
  // Public getters
  // -------------------------------------------------------------------------

  getBotUserId(): string | null {
    return this.botUserId;
  }
  getBotUsername(): string | null {
    return this.botUsername;
  }
  getSessionId(): string | null {
    return this.sessionId;
  }
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  getGuilds(): Map<string, DiscordGuild> {
    return this.guilds;
  }
  getChannels(): Map<string, DiscordChannel> {
    return this.channels;
  }

  updateConfig(_config: DiscordGatewayConfig): void {
    // Config stored for future use by the router, not needed by gateway itself
  }
}
