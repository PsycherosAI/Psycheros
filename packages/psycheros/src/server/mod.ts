/**
 * Server Module
 *
 * HTTP server for the Psycheros daemon.
 * This module provides the web interface and API endpoints for
 * interacting with the entity.
 *
 * @module
 *
 * @example
 * ```typescript
 * import { Server } from "./server/mod.ts";
 *
 * const server = new Server({
 *   port: 8080,
 *   projectRoot: Deno.cwd(),
 * });
 *
 * await server.start();
 * ```
 */

// Re-export server (public API)
export type { ServerConfig } from "./server.ts";
export { Server } from "./server.ts";
