/**
 * Entity Loom — SSE Broadcaster
 *
 * Server-Sent Events broadcaster for real-time progress updates.
 * Each connected client receives all events. Events are also stored
 * in a ring buffer for late-joining clients.
 */

export interface SSEMessage {
  type: string;
  stage?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

const MAX_BUFFER = 200;

export class SSEBroadcaster {
  private clients: Set<ReadableStreamDefaultController<Uint8Array>> = new Set();
  private buffer: SSEMessage[] = [];

  /** Send an event to all connected clients and buffer it */
  broadcast(event: SSEMessage): void {
    event.timestamp = event.timestamp || new Date().toISOString();
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
    }

    const data = `data: ${JSON.stringify(event)}\n\n`;
    const encoded = new TextEncoder().encode(data);

    for (const client of this.clients) {
      try {
        client.enqueue(encoded);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Create a new SSE stream for a client */
  createStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.add(controller);

        // Send buffered events on connect
        for (const event of this.buffer) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          const encoded = new TextEncoder().encode(data);
          controller.enqueue(encoded);
        }
      },
      cancel: (controller) => {
        this.clients.delete(controller);
      },
    });
  }

  /** Get current client count */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Log helper — broadcasts a log event */
  log(level: string, message: string, meta?: Record<string, unknown>): void {
    this.broadcast({
      type: "log",
      data: { level, message, ...meta },
      timestamp: new Date().toISOString(),
    });
  }
}

/** Global broadcaster instance */
export const sse = new SSEBroadcaster();
