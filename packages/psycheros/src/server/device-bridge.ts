/**
 * Device Bridge
 *
 * Singleton that manages WebSocket connections from BLE gateway clients
 * (browser tabs, Android apps) and routes commands between the entity's
 * tools and connected BLE devices.
 *
 * Follows the same singleton pattern as EventBroadcaster in broadcaster.ts.
 *
 * Communication flow:
 *   Entity tool --> sendCommand() --> WebSocket --> Gateway client --> BLE device
 *   BLE device --> Gateway client --> WebSocket --> handleMessage() --> inbound buffer
 */

// =============================================================================
// Types
// =============================================================================

/** A connected WebSocket gateway client. */
interface BridgeClient {
  /** Unique client ID */
  id: string;
  /** The WebSocket connection */
  socket: WebSocket;
  /** BLE device IDs this client can reach */
  deviceIds: string[];
}

/** A pending command awaiting a response from the BLE device. */
interface PendingRequest {
  resolve: (result: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Response from a BLE device through the bridge. */
export interface BridgeResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** An inbound data point pushed by a BLE device. */
export interface InboundMessage {
  deviceId: string;
  timestamp: number;
  type: string;
  data: unknown;
}

/** Info about a currently connected device. */
export interface ConnectedDeviceInfo {
  id: string;
  name: string;
  type: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for awaiting device responses (ms). */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/** Maximum entries per device in the inbound buffer. */
const MAX_BUFFER_SIZE = 100;

// =============================================================================
// Device Bridge
// =============================================================================

/**
 * Manages WebSocket connections from BLE gateway clients and routes
 * commands between the entity's tools and connected BLE devices.
 */
export class DeviceBridge {
  private static instance: DeviceBridge | null = null;
  private clients: Map<string, BridgeClient> = new Map();
  private deviceToClient: Map<string, string> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private inboundBuffer: Map<string, InboundMessage[]> = new Map();
  private nextClientId = 1;
  private nextRequestId = 1;

  private constructor() {}

  /**
   * Get the singleton instance.
   */
  static getInstance(): DeviceBridge {
    if (!DeviceBridge.instance) {
      DeviceBridge.instance = new DeviceBridge();
    }
    return DeviceBridge.instance;
  }

  // ===========================================================================
  // Client Lifecycle
  // ===========================================================================

  /**
   * Register a new WebSocket gateway client.
   *
   * The client starts with no devices. It sends a "register" message
   * after opening to declare which BLE devices it can reach.
   *
   * @param socket - The WebSocket connection from the gateway client
   * @returns The client ID for later reference
   */
  addClient(socket: WebSocket): string {
    const clientId = `bridge_${this.nextClientId++}`;
    this.clients.set(clientId, {
      id: clientId,
      socket,
      deviceIds: [],
    });

    socket.onmessage = (event) => {
      this.handleMessage(clientId, event.data);
    };

    socket.onclose = () => {
      this.removeClient(clientId);
    };

    socket.onerror = () => {
      this.removeClient(clientId);
    };

    console.log(`[DeviceBridge] Client ${clientId} connected`);
    return clientId;
  }

  /**
   * Remove a client connection and clean up all its device mappings
   * and pending requests.
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove device-to-client mappings
    for (const deviceId of client.deviceIds) {
      if (this.deviceToClient.get(deviceId) === clientId) {
        this.deviceToClient.delete(deviceId);
      }
    }

    // Reject all pending requests for this client's devices
    this.cleanupPendingRequests(clientId);

    this.clients.delete(clientId);
    console.log(`[DeviceBridge] Client ${clientId} disconnected`);
  }

  /**
   * Register which BLE devices a gateway client can reach.
   * Called when the client sends a "register" message.
   */
  registerClientDevices(
    clientId: string,
    devices: Array<{ id: string; name: string; type: string }>,
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove old device mappings for this client
    for (const deviceId of client.deviceIds) {
      if (this.deviceToClient.get(deviceId) === clientId) {
        this.deviceToClient.delete(deviceId);
      }
    }

    // Set new device mappings
    const deviceIds = devices.map((d) => d.id);
    for (const deviceId of deviceIds) {
      this.deviceToClient.set(deviceId, clientId);
    }

    client.deviceIds = deviceIds;
    console.log(
      `[DeviceBridge] Client ${clientId} registered devices: ${
        deviceIds.join(", ") || "(none)"
      }`,
    );
  }

  // ===========================================================================
  // Command Routing
  // ===========================================================================

  /**
   * Send a command to a BLE device and await the response.
   *
   * Routes the command to the correct gateway client via the
   * device-to-client mapping. Returns a promise that resolves
   * when the device responds or rejects on timeout.
   *
   * @param deviceId - The stable ID of the target device
   * @param command - The command string to send
   * @param params - Optional parameters for the command
   * @param timeoutMs - Timeout in milliseconds (default 10s)
   */
  sendCommand(
    deviceId: string,
    command: string,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<BridgeResponse> {
    const clientId = this.deviceToClient.get(deviceId);
    const client = clientId ? this.clients.get(clientId) : undefined;

    if (!client || !clientId) {
      return Promise.resolve({
        requestId: "",
        success: false,
        error:
          `Device "${deviceId}" is not connected through any bridge client`,
      });
    }

    const requestId = `req_${this.nextRequestId++}`;

    const promise = new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
    });

    // Send command to the gateway client
    const message = JSON.stringify({
      type: "command",
      requestId,
      deviceId,
      command,
      params: params ?? {},
    });

    try {
      client.socket.send(message);
    } catch (error) {
      this.pendingRequests.delete(requestId);
      return Promise.resolve({
        requestId,
        success: false,
        error: `Failed to send to gateway client: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    return promise;
  }

  // ===========================================================================
  // Inbound Data
  // ===========================================================================

  /**
   * Get recent inbound data for a device from the circular buffer.
   *
   * @param deviceId - The device ID to query
   * @param limit - Maximum number of entries to return (default 50)
   */
  getRecentData(deviceId: string, limit: number = 50): InboundMessage[] {
    const buffer = this.inboundBuffer.get(deviceId);
    if (!buffer) return [];
    return buffer.slice(-limit);
  }

  /**
   * Clear the inbound buffer for a device.
   */
  clearBuffer(deviceId: string): void {
    this.inboundBuffer.delete(deviceId);
  }

  // ===========================================================================
  // Presence
  // ===========================================================================

  /**
   * Get info about all currently connected BLE devices.
   */
  getConnectedDevices(): ConnectedDeviceInfo[] {
    const devices: ConnectedDeviceInfo[] = [];
    const seenIds = new Set<string>();

    for (const [deviceId, clientId] of this.deviceToClient) {
      if (seenIds.has(deviceId)) continue;
      seenIds.add(deviceId);

      const client = this.clients.get(clientId);
      if (!client) continue;

      // Check the WebSocket is actually open
      if (client.socket.readyState !== WebSocket.OPEN) continue;

      // Basic info — the full device info comes from the register message
      // which the client sends, but we store minimal data here
      devices.push({
        id: deviceId,
        name: deviceId, // Client should provide name in register
        type: "unknown",
      });
    }

    return devices;
  }

  /**
   * Check if a specific device is currently connected.
   */
  isDeviceConnected(deviceId: string): boolean {
    const clientId = this.deviceToClient.get(deviceId);
    if (!clientId) return false;
    const client = this.clients.get(clientId);
    if (!client) return false;
    return client.socket.readyState === WebSocket.OPEN;
  }

  // ===========================================================================
  // Shutdown
  // ===========================================================================

  /**
   * Close all WebSocket connections and clean up.
   * Called during server shutdown.
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

    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Device bridge shutting down"));
    }
    this.pendingRequests.clear();

    console.log("[DeviceBridge] All connections closed");
  }

  // ===========================================================================
  // Internal Message Handling
  // ===========================================================================

  /**
   * Handle an incoming message from a gateway client.
   */
  private handleMessage(clientId: string, rawData: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(rawData as string) as Record<string, unknown>;
    } catch {
      console.error(
        `[DeviceBridge] Invalid JSON from client ${clientId}`,
      );
      return;
    }

    const type = msg.type as string;

    switch (type) {
      case "register": {
        const devices =
          (msg.devices as Array<{ id: string; name: string; type: string }>) ??
            [];
        this.registerClientDevices(clientId, devices);

        // Update the connected devices cache with full info
        this.updateDeviceCache(devices);
        break;
      }

      case "response": {
        const requestId = msg.requestId as string;
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(requestId);
          pending.resolve({
            requestId,
            success: (msg.success as boolean) ?? false,
            data: msg.data,
            error: msg.error as string | undefined,
          });
        }
        break;
      }

      case "device_data": {
        const deviceId = msg.deviceId as string;
        const dataType = msg.dataType as string;
        const data = msg.data;

        // Push to circular buffer
        let buffer = this.inboundBuffer.get(deviceId);
        if (!buffer) {
          buffer = [];
          this.inboundBuffer.set(deviceId, buffer);
        }

        buffer.push({
          deviceId,
          timestamp: Date.now(),
          type: dataType,
          data,
        });

        // Trim to max size
        if (buffer.length > MAX_BUFFER_SIZE) {
          this.inboundBuffer.set(deviceId, buffer.slice(-MAX_BUFFER_SIZE));
        }
        break;
      }

      default:
        console.warn(
          `[DeviceBridge] Unknown message type "${type}" from client ${clientId}`,
        );
    }
  }

  /**
   * Update cached device info with names/types from registration.
   * Stored on the bridge so getConnectedDevices() can return full info.
   */
  private deviceInfoCache: Map<string, ConnectedDeviceInfo> = new Map();

  private updateDeviceCache(
    devices: Array<{ id: string; name: string; type: string }>,
  ): void {
    for (const d of devices) {
      this.deviceInfoCache.set(d.id, { id: d.id, name: d.name, type: d.type });
    }
  }

  /**
   * Override getConnectedDevices to use cached device info.
   * (Replaces the basic version above with enriched data.)
   */
  get connectedDeviceList(): ConnectedDeviceInfo[] {
    const result: ConnectedDeviceInfo[] = [];
    for (const [deviceId, clientId] of this.deviceToClient) {
      const client = this.clients.get(clientId);
      if (!client || client.socket.readyState !== WebSocket.OPEN) continue;

      const cached = this.deviceInfoCache.get(deviceId);
      result.push(cached ?? { id: deviceId, name: deviceId, type: "unknown" });
    }
    return result;
  }

  /**
   * Clean up all pending requests.
   * Called when a gateway client disconnects — rejects all pending
   * requests since the disconnecting client's devices are unreachable.
   */
  private cleanupPendingRequests(_clientId: string): void {
    const dead: string[] = [];
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Gateway client disconnected"));
      dead.push(requestId);
    }
    for (const requestId of dead) {
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * Get the number of connected gateway clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }
}

/**
 * Get the global DeviceBridge instance.
 */
export function getDeviceBridge(): DeviceBridge {
  return DeviceBridge.getInstance();
}
