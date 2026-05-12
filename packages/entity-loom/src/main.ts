/**
 * Entity Loom — Entry Point
 *
 * Starts the web wizard server.
 */

import { startServer } from "./server/mod.ts";

const port = parseInt(Deno.env.get("PORT") || "3210", 10);
startServer(port).catch((error) => {
  console.error(
    `[entity-loom] Fatal: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  Deno.exit(1);
});
