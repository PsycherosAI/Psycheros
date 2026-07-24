/**
 * Wearable Connection Manager
 *
 * Manages WebSocket connections from entity-plexus (Android app) clients.
 * Ingests sensor readings into the WearableDataCache and exposes a
 * sendCommand() method for routing commands from tools back to the app.
 *
 * Stream discovery: when a device sends data, any new stream types are
 * auto-registered in the BLE device profile. The app can also send a
 * "capabilities" message to pre-declare streams. Both paths persist to
 * BLE settings so config survives device disconnects.
 */

import type {
  SensorReading,
  WearableCapabilities,
  WearableCommand,
} from "./types.ts";
import { getWearableDataCache } from "./cache.ts";
import { extractReadingValue } from "./event-rules.ts";
import type { EventRulesEngine } from "./event-rules-engine.ts";
import {
  ensureStream,
  loadBLESettings,
  saveBLESettings,
} from "../llm/ble-settings.ts";

/** A connected entity-plexus client. */
interface PlexusClient {
  /** Unique client ID */
  id: string;
  /** The WebSocket connection */
  socket: WebSocket;
  /** Device IDs this client reports for */
  deviceIds: Set<string>;
}

export class WearableConnectionManager {
  private static instance: WearableConnectionManager | null = null;
  private clients: Map<string, PlexusClient> = new Map();
  private deviceToClient: Map<string, string> = new Map();
  private nextClientId = 1;
  /** Data root for persisting BLE settings. */
  private dataRoot: string | null = null;
  private eventEngine: EventRulesEngine | null = null;

  private constructor() {}

  static getInstance(): WearableConnectionManager {
    if (!WearableConnectionManager.instance) {
      WearableConnectionManager.instance = new WearableConnectionManager();
    }
    return WearableConnectionManager.instance;
  }

  /**
   * Set the data root for BLE settings persistence.
   * Called once during server startup.
   */
  setDataRoot(dataRoot: string): void {
    this.dataRoot = dataRoot;
  }

  setEventEngine(engine: EventRulesEngine): void {
    this.eventEngine = engine;
  }

  // ===========================================================================
  // Client Lifecycle
  // ===========================================================================

  /**
   * Register a new entity-plexus WebSocket client.
   */
  addClient(socket: WebSocket, initialDeviceId?: string): string {
    const clientId = `plexus_${this.nextClientId++}`;
    const client: PlexusClient = {
      id: clientId,
      socket,
      deviceIds: new Set(),
    };
    this.clients.set(clientId, client);

    if (initialDeviceId) {
      client.deviceIds.add(initialDeviceId);
      this.deviceToClient.set(initialDeviceId, clientId);
    }

    socket.onmessage = (event) => {
      this.handleMessage(clientId, event.data);
    };

    socket.onclose = (ev) => {
      console.log(
        `[Wearable] Client ${clientId} socket closing — code: ${ev.code}, reason: "${ev.reason}", wasClean: ${ev.wasClean}`,
      );
      this.removeClient(clientId);
    };

    socket.onerror = (ev) => {
      console.error(
        `[Wearable] Client ${clientId} socket error: ${
          ev instanceof ErrorEvent ? ev.message : String(ev)
        }`,
      );
      this.removeClient(clientId);
    };

    console.log(
      `[Wearable] Client ${clientId} connected${
        initialDeviceId ? ` (device: ${initialDeviceId})` : ""
      }`,
    );
    return clientId;
  }

  /**
   * Remove a client and clean up device mappings.
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    for (const deviceId of client.deviceIds) {
      if (this.deviceToClient.get(deviceId) === clientId) {
        this.deviceToClient.delete(deviceId);
      }
    }

    this.clients.delete(clientId);
    console.log(`[Wearable] Client ${clientId} disconnected`);
  }

  // ===========================================================================
  // Command Routing
  // ===========================================================================

  /**
   * Send a command to a device through the entity-plexus WebSocket.
   * Fire-and-forget -- no response awaited (the app handles execution).
   *
   * @returns true if the command was sent, false if the device is not connected
   */
  sendCommand(deviceId: string, command: string): boolean {
    const clientId = this.deviceToClient.get(deviceId);
    const client = clientId ? this.clients.get(clientId) : undefined;

    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    const msg: WearableCommand = {
      type: "command",
      device_id: deviceId,
      command,
    };

    try {
      client.socket.send(JSON.stringify(msg));
      console.log(`[Wearable] Command "${command}" sent to ${deviceId}`);
      return true;
    } catch (error) {
      console.error(
        `[Wearable] Failed to send command to ${deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Check if a device is connected through this manager.
   */
  isDeviceConnected(deviceId: string): boolean {
    const clientId = this.deviceToClient.get(deviceId);
    if (!clientId) return false;
    const client = this.clients.get(clientId);
    return client !== undefined && client.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Get list of currently connected device IDs.
   */
  get connectedDeviceIds(): string[] {
    const result: string[] = [];
    for (const [deviceId, clientId] of this.deviceToClient) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        result.push(deviceId);
      }
    }
    return result;
  }

  // ===========================================================================
  // Shutdown
  // ===========================================================================

  /**
   * Close all connections. Called during server shutdown.
   */
  closeAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.socket.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.clients.clear();
    this.deviceToClient.clear();
    console.log("[Wearable] All connections closed");
  }

  // ===========================================================================
  // Stream Discovery
  // ===========================================================================

  /**
   * Register stream types for a device in BLE settings.
   * Only adds new streams — does not overwrite existing config.
   */
  async registerStreams(
    deviceId: string,
    streamIds: string[],
  ): Promise<void> {
    if (!this.dataRoot || streamIds.length === 0) return;

    try {
      const settings = await loadBLESettings(this.dataRoot);
      const device = settings.devices.find((d) => d.id === deviceId);
      if (!device) return; // Device not configured — skip silently

      let changed = false;
      for (const streamId of streamIds) {
        if (!device.streams?.[streamId]) {
          ensureStream(device, streamId);
          changed = true;
        }
      }

      if (changed) {
        await saveBLESettings(this.dataRoot, settings);
        console.log(
          `[Wearable] ${deviceId}: registered new streams [${
            streamIds.join(", ")
          }]`,
        );
      }
    } catch (error) {
      console.error(
        `[Wearable] Failed to register streams for ${deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private handleMessage(clientId: string, rawData: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(rawData as string) as Record<string, unknown>;
    } catch {
      console.error(
        `[Wearable] Invalid JSON from client ${clientId}`,
      );
      return;
    }

    const type = msg.type as string | undefined;

    // Handle capabilities message
    if (type === "capabilities") {
      this.handleCapabilities(clientId, msg as unknown as WearableCapabilities);
      return;
    }

    // Handle sensor readings
    if (!msg.device_id || !Array.isArray(msg.readings)) {
      console.warn(
        `[Wearable] Malformed message from client ${clientId}: missing device_id or readings`,
      );
      return;
    }

    const deviceId = msg.device_id as string;
    const readings = msg.readings as SensorReading[];

    // Register device-to-client mapping (first message establishes it)
    const client = this.clients.get(clientId);
    if (client && !client.deviceIds.has(deviceId)) {
      client.deviceIds.add(deviceId);
      this.deviceToClient.set(deviceId, clientId);
      console.debug(
        `[Wearable] Client ${clientId} registered device: ${deviceId}`,
      );
    }

    // Auto-discover stream types from readings
    const newStreams: string[] = [];
    for (const reading of readings) {
      // Check if this stream type is known for the device
      // (deferred — actual registration is async)
      newStreams.push(reading.type);
    }
    if (newStreams.length > 0) {
      this.registerStreams(deviceId, [...new Set(newStreams)]);
    }

    // Ingest into cache
    const cache = getWearableDataCache();
    cache.ingest(deviceId, readings);

    // Evaluate event rules against each reading
    if (this.eventEngine) {
      for (const reading of readings) {
        const value = extractReadingValue(reading);
        if (value !== undefined) {
          this.eventEngine.evaluate(reading.type, value, deviceId);
        }
      }
    }

    // Log summary
    const types = readings.map((r) => r.type).join(", ");
    console.debug(
      `[Wearable] ${deviceId}: received [${types}] from client ${clientId}`,
    );
  }

  private handleCapabilities(
    clientId: string,
    msg: WearableCapabilities,
  ): void {
    if (!msg.device_id || !Array.isArray(msg.streams)) {
      console.warn(
        `[Wearable] Malformed capabilities from client ${clientId}`,
      );
      return;
    }

    // Register device-to-client mapping
    const client = this.clients.get(clientId);
    if (client && !client.deviceIds.has(msg.device_id)) {
      client.deviceIds.add(msg.device_id);
      this.deviceToClient.set(msg.device_id, clientId);
    }

    // Register declared streams
    const streamIds = msg.streams.map((s) => s.id);
    this.registerStreams(msg.device_id, streamIds);

    console.log(
      `[Wearable] ${msg.device_id}: capabilities declared [${
        streamIds.join(", ")
      }]`,
    );
  }
}

/**
 * Get the global WearableConnectionManager instance.
 */
export function getWearableConnectionManager(): WearableConnectionManager {
  return WearableConnectionManager.getInstance();
}
