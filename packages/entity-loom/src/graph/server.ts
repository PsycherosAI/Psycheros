/**
 * Entity Loom — Graph Preview Server
 *
 * Lightweight Deno HTTP server that serves the graph viewer HTML page
 * and provides REST API endpoints for reading/writing graph.db directly.
 */

import { dirname, join } from "@std/path";
import { Database } from "@db/sqlite";

const __dirname = dirname(new URL(import.meta.url).pathname);

interface GraphNode {
  id: string;
  type: string;
  label: string;
  description: string | null;
  confidence: number | null;
  source_instance: string | null;
  created_at: string;
  updated_at: string;
  first_learned_at: string | null;
  last_confirmed_at: string | null;
  version: number;
}

interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  evidence: string | null;
  weight: number | null;
  created_at: string;
  updated_at: string;
  occurred_at: string | null;
  last_confirmed_at: string | null;
  version: number;
}

export async function startGraphServer(
  graphDbPath: string,
  port: number,
): Promise<void> {
  // Verify graph.db exists
  try {
    await Deno.stat(graphDbPath);
  } catch {
    console.error(`graph.db not found at ${graphDbPath}`);
    console.error(
      "Run entity-loom import first to populate the knowledge graph.",
    );
    Deno.exit(1);
  }

  const db = new Database(graphDbPath, { readonly: false });

  const htmlPath = join(__dirname, "..", "..", "web", "graph.html");
  let htmlContent: string;
  try {
    htmlContent = await Deno.readTextFile(htmlPath);
  } catch {
    console.error(`graph.html not found at ${htmlPath}`);
    Deno.exit(1);
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Serve the static HTML page
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(htmlContent, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ─── REST API ────────────────────────────────────────────────────────────

    // GET /api/graph — return all nodes and edges
    if (url.pathname === "/api/graph" && req.method === "GET") {
      const nodes = db.prepare(
        "SELECT id, type, label, description, confidence, source_instance, created_at, updated_at, first_learned_at, last_confirmed_at, version FROM graph_nodes WHERE deleted = 0",
      ).all() as GraphNode[];

      const edges = db.prepare(
        "SELECT id, from_id as fromId, to_id as toId, type, evidence, weight, created_at, updated_at, occurred_at, last_confirmed_at, version FROM graph_edges WHERE deleted = 0",
      ).all() as GraphEdge[];

      // Map to frontend-friendly shape
      const mappedNodes = nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        description: n.description,
        confidence: n.confidence,
        sourceInstance: n.source_instance,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
        firstLearnedAt: n.first_learned_at,
        lastConfirmedAt: n.last_confirmed_at,
        version: n.version,
      }));

      const mappedEdges = edges.map((e) => ({
        id: e.id,
        fromId: e.fromId,
        toId: e.toId,
        type: e.type,
        evidence: e.evidence,
        weight: e.weight,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
        occurredAt: e.occurred_at,
        lastConfirmedAt: e.last_confirmed_at,
        version: e.version,
      }));

      return jsonResponse({
        nodes: mappedNodes,
        edges: mappedEdges,
        stats: {
          totalNodes: mappedNodes.length,
          totalEdges: mappedEdges.length,
          nodeTypes: [...new Set(mappedNodes.map((n) => n.type))].sort(),
          edgeTypes: [...new Set(mappedEdges.map((e) => e.type))].sort(),
        },
      });
    }

    // DELETE /api/graph/nodes/:id — soft-delete a node and its edges
    const nodeMatch = url.pathname.match(/^\/api\/graph\/nodes\/(.+)$/);
    if (nodeMatch && req.method === "DELETE") {
      const nodeId = decodeURIComponent(nodeMatch[1]);
      try {
        // Soft-delete connected edges first
        db.prepare(
          "UPDATE graph_edges SET deleted = 1, updated_at = ? WHERE (from_id = ? OR to_id = ?) AND deleted = 0",
        )
          .run(new Date().toISOString(), nodeId, nodeId);
        // Soft-delete the node
        const changes = db.prepare(
          "UPDATE graph_nodes SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0",
        )
          .run(new Date().toISOString(), nodeId);
        if (changes === 0) {
          return jsonResponse({ success: false, error: "Node not found" }, 404);
        }
        return jsonResponse({ success: true });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // PUT /api/graph/nodes/:id — update a node
    if (nodeMatch && req.method === "PUT") {
      const nodeId = decodeURIComponent(nodeMatch[1]);
      try {
        const body = await req.json() as {
          label?: string;
          description?: string;
          type?: string;
        };
        const existing = db.prepare(
          "SELECT id FROM graph_nodes WHERE id = ? AND deleted = 0",
        ).get(nodeId);
        if (!existing) {
          return jsonResponse({ success: false, error: "Node not found" }, 404);
        }
        if (body.label !== undefined) {
          db.prepare(
            "UPDATE graph_nodes SET label = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          )
            .run(body.label, new Date().toISOString(), nodeId);
        }
        if (body.description !== undefined) {
          db.prepare(
            "UPDATE graph_nodes SET description = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          )
            .run(body.description || null, new Date().toISOString(), nodeId);
        }
        if (body.type !== undefined) {
          db.prepare(
            "UPDATE graph_nodes SET type = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          )
            .run(body.type, new Date().toISOString(), nodeId);
        }
        return jsonResponse({ success: true });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // POST /api/graph/nodes — create a new node
    if (url.pathname === "/api/graph/nodes" && req.method === "POST") {
      try {
        const body = await req.json() as {
          type: string;
          label: string;
          description?: string;
        };
        if (!body.type || !body.label) {
          return jsonResponse({
            success: false,
            error: "type and label are required",
          }, 400);
        }
        const id = `manual-${body.type}-${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO graph_nodes (id, type, label, description, source_instance, confidence, created_at, updated_at, first_learned_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(
          id,
          body.type,
          body.label,
          body.description || null,
          "entity-loom-graph-preview",
          0.8,
          now,
          now,
          now,
        );
        return jsonResponse({ success: true, id });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // DELETE /api/graph/edges/:id — soft-delete an edge
    const edgeMatch = url.pathname.match(/^\/api\/graph\/edges\/(.+)$/);
    if (edgeMatch && req.method === "DELETE") {
      const edgeId = decodeURIComponent(edgeMatch[1]);
      try {
        const changes = db.prepare(
          "UPDATE graph_edges SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0",
        )
          .run(new Date().toISOString(), edgeId);
        if (changes === 0) {
          return jsonResponse({ success: false, error: "Edge not found" }, 404);
        }
        return jsonResponse({ success: true });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // PUT /api/graph/edges/:id — update an edge type
    if (edgeMatch && req.method === "PUT") {
      const edgeId = decodeURIComponent(edgeMatch[1]);
      try {
        const body = await req.json() as { type?: string };
        const existing = db.prepare(
          "SELECT id FROM graph_edges WHERE id = ? AND deleted = 0",
        ).get(edgeId);
        if (!existing) {
          return jsonResponse({ success: false, error: "Edge not found" }, 404);
        }
        if (body.type !== undefined) {
          db.prepare(
            "UPDATE graph_edges SET type = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          )
            .run(body.type, new Date().toISOString(), edgeId);
        }
        return jsonResponse({ success: true });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    // POST /api/graph/edges — create a new edge
    if (url.pathname === "/api/graph/edges" && req.method === "POST") {
      try {
        const body = await req.json() as {
          fromId: string;
          toId: string;
          type: string;
          evidence?: string;
        };
        if (!body.fromId || !body.toId || !body.type) {
          return jsonResponse({
            success: false,
            error: "fromId, toId, and type are required",
          }, 400);
        }
        if (body.fromId === body.toId) {
          return jsonResponse({
            success: false,
            error: "Cannot connect a node to itself",
          }, 400);
        }
        // Verify both nodes exist
        const fromNode = db.prepare(
          "SELECT id FROM graph_nodes WHERE id = ? AND deleted = 0",
        ).get(body.fromId);
        const toNode = db.prepare(
          "SELECT id FROM graph_nodes WHERE id = ? AND deleted = 0",
        ).get(body.toId);
        if (!fromNode || !toNode) {
          return jsonResponse({
            success: false,
            error: "One or both nodes not found",
          }, 404);
        }
        const id = `manual-edge-${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO graph_edges (id, from_id, to_id, type, evidence, weight, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(
          id,
          body.fromId,
          body.toId,
          body.type,
          body.evidence || null,
          0.7,
          now,
          now,
        );
        return jsonResponse({ success: true, id });
      } catch (err) {
        return jsonResponse({ success: false, error: String(err) }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  };

  console.log(`\n  Graph Preview Server`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  http://localhost:${port}`);
  console.log(`  DB: ${graphDbPath}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

  // Auto-open browser
  try {
    const cmd = new Deno.Command("xdg-open", {
      args: [`http://localhost:${port}`],
      stderr: "null",
      stdout: "null",
    });
    cmd.spawn();
  } catch {
    // xdg-open may not be available, that's fine
  }

  await Deno.serve({ port, hostname: "127.0.0.1" }, async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      return new Response(`Internal Error: ${err}`, { status: 500 });
    }
  }).finished;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
