/**
 * Entity Loom — HTTP Server
 *
 * Serves the wizard UI, REST API, SSE stream, and graph viewer.
 * Replaces the CLI entry point with a web-first architecture.
 */

import { dirname, join } from "@std/path";
import { sse } from "./sse.ts";
import { closeLogger, initLogger, log } from "./logger.ts";
import { Router } from "./router.ts";
import { setupRoutes } from "../stages/setup-stage.ts";
import { convertRoutes } from "../stages/convert-stage.ts";
import { stagingRoutes } from "../stages/staging-stage.ts";
import { significantRoutes } from "../stages/significant-stage.ts";
import { dailyRoutes } from "../stages/daily-stage.ts";
import { graphRoutes } from "../stages/graph-stage.ts";
import { abortRunningStage } from "./stage-lock.ts";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT_DIR = join(__dirname, "..", "..");

export interface Handler {
  (req: Request, ctx: RouteHandlerContext): Promise<Response>;
}

export interface RouteHandlerContext {
  params: Record<string, string>;
}

export async function startServer(port = 3210): Promise<void> {
  const logFilePath = await initLogger(ROOT_DIR);
  log("info", `Entity Loom server starting on port ${port}`);

  // Load static HTML files
  const wizardHtml = await Deno.readTextFile(
    join(ROOT_DIR, "web", "wizard.html"),
  ).catch(() => null);
  const graphHtml = await Deno.readTextFile(join(ROOT_DIR, "web", "graph.html"))
    .catch(() => null);

  // Build router with all stage routes
  const router = new Router();
  router.addRoutes(setupRoutes());
  router.addRoutes(convertRoutes());
  router.addRoutes(stagingRoutes());
  router.addRoutes(significantRoutes());
  router.addRoutes(dailyRoutes());
  router.addRoutes(graphRoutes());

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // ─── Static HTML ──────────────────────────────────────────────
    if (url.pathname === "/" && req.method === "GET") {
      if (!wizardHtml) return json({ error: "wizard.html not found" }, 500);
      return new Response(wizardHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
        },
      });
    }

    if (url.pathname === "/graph" && req.method === "GET") {
      if (!graphHtml) return json({ error: "graph.html not found" }, 500);
      return new Response(graphHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
        },
      });
    }

    // ─── SSE Stream ───────────────────────────────────────────────
    if (url.pathname === "/api/events" && req.method === "GET") {
      return new Response(sse.createStream(), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ─── API Routes ──────────────────────────────────────────────
    const ctx: RouteHandlerContext = { params: {} };
    const response = await router.handle(req, ctx);
    if (response) return response;

    // Quiet the browser's automatic favicon probe.
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return new Response("Not Found", { status: 404 });
  };

  // Auto-open browser
  try {
    const cmd = new Deno.Command("xdg-open", {
      args: [`http://localhost:${port}`],
      stderr: "null",
      stdout: "null",
    });
    cmd.spawn();
  } catch {
    // xdg-open may not be available
  }

  log("info", `Server running at http://localhost:${port}`);
  console.log(`\n  Entity Loom Wizard`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  http://localhost:${port}`);
  console.log(`  Log: ${logFilePath}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

  // SIGINT handler — clean shutdown
  Deno.addSignalListener("SIGINT", () => {
    log("info", "SIGINT received, shutting down...");
    sse.broadcast({
      type: "abort",
      data: { reason: "Server shutting down" },
      timestamp: new Date().toISOString(),
    });
    abortRunningStage();
    closeLogger();
    Deno.exit(0);
  });

  // Bind to localhost by default for safety on dev machines; override with
  // HOSTNAME=0.0.0.0 when running in a container that needs external reach.
  const hostname = Deno.env.get("HOSTNAME") || "127.0.0.1";
  await Deno.serve({ port, hostname }, async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      log(
        "error",
        `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return json({ error: "Internal server error" }, 500);
    }
  }).finished;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
