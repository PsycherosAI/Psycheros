/**
 * Graph Consolidator
 *
 * Post-extraction rule-based consolidation. Runs after memory extraction
 * to prune low-value nodes and merge duplicates. No LLM calls — purely
 * rule-based to avoid additional API cost and latency.
 *
 * This is a subconscious maintenance process, not something the entity
 * consciously manages. It runs at startup and after consolidation passes.
 */

import { join } from "@std/path";
import { Database } from "@db/sqlite";

/** Vague descriptor regex patterns for generic topic/preference detection. */
const VAGUE_PATTERNS = [
  /^sacred\s+\w+$/i,
  /^\w+\s+connection$/i,
  /^\w+\s+dynamic$/i,
  /^\w+\s+intimacy$/i,
];

export interface ConsolidationResult {
  nodesRemoved: number;
  edgesRemoved: number;
  nodesMerged: number;
}

/**
 * Consolidate the knowledge graph by pruning low-value nodes and merging duplicates.
 */
export function consolidateGraph(dataDir: string): ConsolidationResult {
  const dbPath = join(dataDir, "graph.db");
  const db = new Database(dbPath, { readonly: false });

  try {
    let nodesRemoved = 0;
    let edgesRemoved = 0;

    // Phase 1: Isolated node pruning
    nodesRemoved += pruneIsolatedNodes(db);

    // Phase 2: Generic topic/preference detection
    nodesRemoved += pruneGenericNodes(db);

    // Phase 3: Edge cleanup — remove edges connected to deleted nodes
    edgesRemoved = cleanupEdges(db);

    // Phase 4: Duplicate merging
    const mergedCount = mergeDuplicates(db);
    // Edges re-parented by merging don't count as removed

    console.error(
      `[Graph] Consolidation: removed ${nodesRemoved} nodes, ${edgesRemoved} edges, merged ${mergedCount} nodes`,
    );

    return { nodesRemoved, edgesRemoved, nodesMerged: mergedCount };
  } finally {
    db.close();
  }
}

/**
 * Soft-delete nodes with 0 connections that aren't self or person type.
 */
function pruneIsolatedNodes(db: Database): number {
  const isolated = db.prepare(`
    SELECT n.id
    FROM graph_nodes n
    WHERE n.deleted = 0
      AND n.type NOT IN ('self', 'person')
      AND NOT EXISTS (
        SELECT 1 FROM graph_edges e
        WHERE (e.from_id = n.id OR e.to_id = n.id) AND e.deleted = 0
      )
  `).all() as Array<{ id: string }>;

  if (isolated.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE graph_nodes SET deleted = 1, updated_at = ? WHERE id = ?",
  );
  const now = new Date().toISOString();
  for (const node of isolated) {
    stmt.run(now, node.id);
  }

  return isolated.length;
}

/**
 * Soft-delete topic and preference nodes that match generic patterns.
 * Rule A: single word, ≤15 chars, ≤2 connections
 * Rule B: vague descriptor patterns with ≤2 connections
 */
function pruneGenericNodes(db: Database): number {
  const candidates = db.prepare(`
    SELECT n.id, n.label, n.type,
      (SELECT COUNT(*) FROM graph_edges e
       WHERE (e.from_id = n.id OR e.to_id = n.id) AND e.deleted = 0) AS conn_count
    FROM graph_nodes n
    WHERE n.deleted = 0
      AND n.type IN ('topic', 'preference')
  `).all() as Array<
    { id: string; label: string; type: string; conn_count: number }
  >;

  const toDelete: string[] = [];

  for (const node of candidates) {
    if (node.conn_count > 2) continue;

    // Rule A: single common word (no spaces, ≤15 chars)
    if (!node.label.includes(" ") && node.label.length <= 15) {
      toDelete.push(node.id);
      continue;
    }

    // Rule B: vague descriptor patterns
    for (const pattern of VAGUE_PATTERNS) {
      if (pattern.test(node.label)) {
        toDelete.push(node.id);
        break;
      }
    }
  }

  if (toDelete.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE graph_nodes SET deleted = 1, updated_at = ? WHERE id = ?",
  );
  const now = new Date().toISOString();
  for (const id of toDelete) {
    stmt.run(now, id);
  }

  return toDelete.length;
}

/**
 * Soft-delete edges where either endpoint is deleted.
 */
function cleanupEdges(db: Database): number {
  const orphaned = db.prepare(`
    SELECT e.id
    FROM graph_edges e
    WHERE e.deleted = 0
      AND (e.from_id IN (SELECT id FROM graph_nodes WHERE deleted = 1)
           OR e.to_id IN (SELECT id FROM graph_nodes WHERE deleted = 1))
  `).all() as Array<{ id: string }>;

  if (orphaned.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE graph_edges SET deleted = 1, updated_at = ? WHERE id = ?",
  );
  const now = new Date().toISOString();
  for (const edge of orphaned) {
    stmt.run(now, edge.id);
  }

  return orphaned.length;
}

/**
 * Find and merge duplicate node pairs:
 * - Labels are case-insensitive equal OR one label contains the other
 * - Types match
 * - Merge lower-confidence into higher-confidence, re-parenting edges
 */
function mergeDuplicates(db: Database): number {
  const nodes = db.prepare(
    "SELECT id, type, label, confidence FROM graph_nodes WHERE deleted = 0 ORDER BY confidence DESC",
  ).all() as Array<
    { id: string; type: string; label: string; confidence: number }
  >;

  // Group by (type, label_lower) to find case-insensitive duplicates
  const labelGroups = new Map<
    string,
    Array<{ id: string; label: string; confidence: number }>
  >();

  for (const node of nodes) {
    const key = `${node.type}:${node.label.toLowerCase()}`;
    const group = labelGroups.get(key) ?? [];
    group.push(node);
    labelGroups.set(key, group);
  }

  let mergedCount = 0;
  const updateEdge = db.prepare(
    "UPDATE graph_edges SET from_id = ?, updated_at = ? WHERE from_id = ? AND deleted = 0",
  );
  const updateEdgeTo = db.prepare(
    "UPDATE graph_edges SET to_id = ?, updated_at = ? WHERE to_id = ? AND deleted = 0",
  );
  const deleteNode = db.prepare(
    "UPDATE graph_nodes SET deleted = 1, updated_at = ? WHERE id = ?",
  );
  const now = new Date().toISOString();

  const mergedIds = new Set<string>();

  for (const [, group] of labelGroups) {
    if (group.length <= 1) continue;

    const keep = group[0];
    for (let i = 1; i < group.length; i++) {
      const merge = group[i];
      updateEdge.run(keep.id, now, merge.id);
      updateEdgeTo.run(keep.id, now, merge.id);
      deleteNode.run(now, merge.id);
      mergedIds.add(merge.id);
      mergedCount++;
    }
  }

  // Check containment: one label contains another (case-insensitive)
  // Only between same-type nodes not already merged
  const nodesByType = new Map<
    string,
    Array<{ id: string; label: string; confidence: number }>
  >();
  for (const node of nodes) {
    const list = nodesByType.get(node.type) ?? [];
    list.push(node);
    nodesByType.set(node.type, list);
  }

  for (const [, typeNodes] of nodesByType) {
    for (let i = 0; i < typeNodes.length; i++) {
      const a = typeNodes[i];
      if (mergedIds.has(a.id)) continue;
      for (let j = i + 1; j < typeNodes.length; j++) {
        const b = typeNodes[j];
        if (mergedIds.has(b.id)) continue;

        const aLower = a.label.toLowerCase();
        const bLower = b.label.toLowerCase();

        if (aLower === bLower) continue;
        if (
          (aLower.includes(bLower) || bLower.includes(aLower)) &&
          (aLower.split(" ").length > 1 || bLower.split(" ").length > 1)
        ) {
          const [keep, merge] = a.confidence >= b.confidence ? [a, b] : [b, a];
          updateEdge.run(keep.id, now, merge.id);
          updateEdgeTo.run(keep.id, now, merge.id);
          deleteNode.run(now, merge.id);
          mergedIds.add(merge.id);
          mergedCount++;
        }
      }
    }
  }

  return mergedCount;
}
