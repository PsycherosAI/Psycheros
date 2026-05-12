/**
 * SSE (Server-Sent Events) Utilities
 *
 * Provides utilities for encoding and streaming Server-Sent Events
 * to clients. Used by the HTTP server to stream LLM responses in
 * real-time.
 *
 * @module
 */

import type { SSEEvent } from "../types.ts";

/**
 * Encode an SSE event into the wire format.
 *
 * SSE wire format (per spec, multi-line data requires multiple data: lines):
 * ```
 * event: <type>
 * data: <line1>
 * data: <line2>
 *
 * ```
 *
 * @param event - The SSE event to encode
 * @returns The encoded SSE event string
 *
 * @example
 * ```typescript
 * const event: SSEEvent = { type: "content", data: "Hello" };
 * const encoded = encodeSSEEvent(event);
 * // "event: content\ndata: Hello\n\n"
 *
 * // Multi-line data:
 * const multiline: SSEEvent = { type: "content", data: "line1\nline2" };
 * const encoded2 = encodeSSEEvent(multiline);
 * // "event: content\ndata: line1\ndata: line2\n\n"
 * ```
 */
export function encodeSSEEvent(event: SSEEvent): string {
  // SSE spec requires each line of data to be prefixed with "data: "
  // Split on newlines and join with "data: " prefix for each line
  const dataLines = event.data.split("\n").map((line) => `data: ${line}`).join(
    "\n",
  );
  return `event: ${event.type}\n${dataLines}\n\n`;
}

/**
 * Create an SSE response with proper headers.
 *
 * Sets up the appropriate headers for Server-Sent Events:
 * - Content-Type: text/event-stream
 * - Cache-Control: no-cache
 * - Connection: keep-alive
 * - Access-Control-Allow-Origin: * (for CORS)
 *
 * @param stream - A ReadableStream of encoded SSE bytes
 * @returns A Response object configured for SSE streaming
 *
 * @example
 * ```typescript
 * const stream = new ReadableStream<Uint8Array>({
 *   start(controller) {
 *     const encoder = new TextEncoder();
 *     controller.enqueue(encoder.encode("event: content\ndata: Hello\n\n"));
 *     controller.close();
 *   }
 * });
 * const response = createSSEResponse(stream);
 * ```
 */
export function createSSEResponse(
  stream: ReadableStream<Uint8Array>,
): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Create a TransformStream that converts SSEEvent objects to encoded bytes.
 *
 * This transform stream takes SSEEvent objects as input and outputs
 * the wire-format encoded bytes ready for streaming to clients.
 *
 * @returns A TransformStream that encodes SSEEvent objects to Uint8Array
 *
 * @example
 * ```typescript
 * const encoder = createSSEEncoder();
 *
 * // Pipe events through the encoder
 * const eventStream = new ReadableStream<SSEEvent>({
 *   start(controller) {
 *     controller.enqueue({ type: "content", data: "Hello" });
 *     controller.enqueue({ type: "done", data: "stop" });
 *     controller.close();
 *   }
 * });
 *
 * const encodedStream = eventStream.pipeThrough(encoder);
 * const response = createSSEResponse(encodedStream);
 * ```
 */
export function createSSEEncoder(): TransformStream<SSEEvent, Uint8Array> {
  const encoder = new TextEncoder();
  return new TransformStream({
    transform(event, controller) {
      controller.enqueue(encoder.encode(encodeSSEEvent(event)));
    },
  });
}
