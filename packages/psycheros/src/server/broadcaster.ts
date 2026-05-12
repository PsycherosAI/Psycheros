/**
 * Event Broadcaster
 *
 * Singleton that manages persistent SSE connections and broadcasts
 * UI updates to connected clients. This enables background operations
 * (like auto-title generation) to push DOM updates at any time.
 *
 * @module
 */

import type { UIUpdate } from "../types.ts";

/**
 * Represents a connected SSE client.
 */
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController<string>;
  conversationId: string | null;
}

/**
 * Manages persistent SSE connections and broadcasts updates to clients.
 *
 * This singleton enables background operations to push DOM updates
 * to connected clients without being tied to the chat request lifecycle.
 */
export class EventBroadcaster {
  private static instance: EventBroadcaster | null = null;
  private clients: Map<string, SSEClient> = new Map();
  private nextClientId = 1;

  private constructor() {}

  /**
   * Get the singleton instance.
   */
  static getInstance(): EventBroadcaster {
    if (!EventBroadcaster.instance) {
      EventBroadcaster.instance = new EventBroadcaster();
    }
    return EventBroadcaster.instance;
  }

  /**
   * Add a new SSE client connection.
   *
   * @param controller - The stream controller for sending events
   * @param conversationId - Optional conversation ID to filter updates
   * @returns The client ID for later reference
   */
  addClient(
    controller: ReadableStreamDefaultController<string>,
    conversationId: string | null,
  ): string {
    const clientId = `client_${this.nextClientId++}`;
    this.clients.set(clientId, {
      id: clientId,
      controller,
      conversationId,
    });
    console.debug(
      `EventBroadcaster: Client ${clientId} connected (conversation: ${
        conversationId || "global"
      })`,
    );
    return clientId;
  }

  /**
   * Remove a client connection.
   *
   * @param clientId - The client ID to remove
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.clients.delete(clientId);
      console.debug(`EventBroadcaster: Client ${clientId} disconnected`);
    }
  }

  /**
   * Broadcast a single UI update to relevant clients.
   *
   * @param update - The UI update to broadcast
   * @param conversationId - Target conversation ID (null for global updates)
   */
  broadcastUpdate(update: UIUpdate, conversationId: string | null): void {
    this.broadcastUpdates([update], conversationId);
  }

  /**
   * Broadcast a typed SSE event to relevant clients.
   * Used for streaming Pulse responses where content needs real-time delivery.
   *
   * @param eventType - The SSE event type (e.g., "content", "done")
   * @param data - The event data to send
   * @param conversationId - Target conversation ID (null for global updates)
   */
  broadcastEvent(
    eventType: string,
    data: unknown,
    conversationId: string | null,
  ): void {
    const deadClients: string[] = [];

    for (const [clientId, client] of this.clients) {
      const shouldSend = conversationId === null ||
        client.conversationId === null ||
        client.conversationId === conversationId;

      if (!shouldSend) continue;

      try {
        const event = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        client.controller.enqueue(event);
      } catch (error) {
        console.debug(
          `EventBroadcaster: Failed to send to ${clientId}, marking for removal:`,
          error instanceof Error ? error.message : String(error),
        );
        deadClients.push(clientId);
      }
    }

    for (const clientId of deadClients) {
      this.clients.delete(clientId);
    }
  }

  /**
   * Broadcast multiple UI updates to relevant clients.
   *
   * When conversationId is null (global update): send to ALL clients.
   * When conversationId is set: send to global listeners + matching clients.
   *
   * @param updates - Array of UI updates to broadcast
   * @param conversationId - Target conversation ID (null = send to ALL clients)
   */
  broadcastUpdates(updates: UIUpdate[], conversationId: string | null): void {
    if (updates.length === 0) return;

    const deadClients: string[] = [];

    for (const [clientId, client] of this.clients) {
      // Determine if this client should receive the update:
      // - If broadcast is global (null): send to ALL clients
      // - If broadcast targets a conversation: send to global listeners + that conversation
      const shouldSend = conversationId === null || // Global broadcast → all clients
        client.conversationId === null || // Client is global listener
        client.conversationId === conversationId; // Client matches target

      if (!shouldSend) continue;

      try {
        for (const update of updates) {
          const event = `event: dom_update\ndata: ${
            JSON.stringify(update)
          }\n\n`;
          client.controller.enqueue(event);
        }
      } catch (error) {
        // Client likely disconnected
        console.debug(
          `EventBroadcaster: Failed to send to ${clientId}, marking for removal:`,
          error instanceof Error ? error.message : String(error),
        );
        deadClients.push(clientId);
      }
    }

    // Clean up dead clients
    for (const clientId of deadClients) {
      this.clients.delete(clientId);
    }
  }

  /**
   * Send keepalive ping to all connected clients.
   * This prevents proxies and browsers from closing idle connections.
   */
  sendKeepalive(): void {
    const deadClients: string[] = [];

    for (const [clientId, client] of this.clients) {
      try {
        // SSE comment format for keepalive (not a real event)
        client.controller.enqueue(": keepalive\n\n");
      } catch {
        deadClients.push(clientId);
      }
    }

    // Clean up dead clients
    for (const clientId of deadClients) {
      this.clients.delete(clientId);
    }
  }

  /**
   * Get the current number of connected clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }
}

/**
 * Get the global EventBroadcaster instance.
 *
 * @returns The singleton EventBroadcaster
 */
export function getBroadcaster(): EventBroadcaster {
  return EventBroadcaster.getInstance();
}
