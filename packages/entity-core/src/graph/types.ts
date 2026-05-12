/**
 * Graph Types
 *
 * Type definitions for my knowledge graph - the web of what I know
 * about my person and how everything connects.
 */

/**
 * A node in my knowledge graph.
 * Represents a concept, person, preference, or any entity I know about.
 */
export interface GraphNode {
  /** Unique identifier for this node */
  id: string;
  /** Type of node (person, self, topic, preference, place, goal, health, etc.) */
  type: string;
  /** Human-readable label for this node */
  label: string;
  /** Detailed description of what this node represents */
  description: string;
  /** Flexible key-value properties */
  properties: Record<string, unknown>;
  /** Vector embedding for semantic search */
  embedding?: number[];
  /** Which embodiment created/modified this node */
  sourceInstance: string;
  /** How certain am I about this knowledge (0-1) */
  confidence: number;
  /** Memory ID this node was extracted from (if applicable) */
  sourceMemoryId?: string;
  /** When this node was first created */
  createdAt: string;
  /** When this node was last modified */
  updatedAt: string;
  /** When I first learned about this */
  firstLearnedAt?: string;
  /** When this knowledge was last verified/mentioned */
  lastConfirmedAt?: string;
  /** Version for sync */
  version: number;
  /** Whether this node has been deleted */
  deleted: boolean;
}

/**
 * An edge in my knowledge graph.
 * Represents a relationship between two nodes.
 */
export interface GraphEdge {
  /** Unique identifier for this edge */
  id: string;
  /** Source node ID */
  fromId: string;
  /** Target node ID */
  toId: string;
  /** Type of relationship — any natural language string (e.g., loves, works_at, values) */
  type: string;
  /** Flexible key-value properties (e.g., {"intensity": 0.8, "context": "..."}) */
  properties: Record<string, unknown>;
  /** Strength of relationship (0-1) */
  weight: number;
  /** Why I think this relationship is true */
  evidence?: string;
  /** When this edge was created */
  createdAt: string;
  /** When this edge was last modified */
  updatedAt: string;
  /** For event-based: when did this happen? */
  occurredAt?: string;
  /** If no longer true: when did it end? */
  validUntil?: string;
  /** When this relationship was last verified */
  lastConfirmedAt?: string;
  /** Version for sync */
  version: number;
  /** Whether this edge has been deleted */
  deleted: boolean;
}

/**
 * Suggested node types (not exhaustive - arbitrary types allowed).
 */
export type SuggestedNodeType =
  | "self"
  | "person"
  | "topic"
  | "preference"
  | "place"
  | "goal"
  | "health"
  | "boundary"
  | "tradition"
  | "insight";

/**
 * Suggested edge types organized by category.
 * Edge types are freeform natural language — these are examples for guidance.
 * Use whatever type best describes the relationship between two nodes.
 */
export const SUGGESTED_EDGE_VOCABULARY: Record<string, string[]> = {
  "Attitudes": [
    "loves",
    "dislikes",
    "respects",
    "proud_of",
    "worried_about",
    "nostalgic_for",
    "intrigued_by",
    "frustrated_with",
  ],
  "Social": [
    "family_of",
    "friend_of",
    "works_with",
    "met_through",
    "close_to",
    "estranged_from",
  ],
  "Life/Factual": [
    "works_at",
    "lives_in",
    "studies",
    "grew_up_in",
    "attends",
  ],
  "Beliefs/Values": [
    "values",
    "believes_in",
    "committed_to",
    "opposes",
  ],
  "Knowledge/Interest": [
    "skilled_at",
    "learning",
    "interested_in",
    "knows_about",
  ],
  "Association": [
    "reminds_of",
    "similar_to",
    "contrasts_with",
    "associated_with",
  ],
};

/**
 * Input for creating a new node.
 */
export interface CreateNodeInput {
  type: string;
  label: string;
  description?: string;
  properties?: Record<string, unknown>;
  sourceInstance: string;
  confidence?: number;
  sourceMemoryId?: string;
  firstLearnedAt?: string;
}

/**
 * Input for creating a new edge.
 */
export interface CreateEdgeInput {
  fromId: string;
  toId: string;
  type: string;
  properties?: Record<string, unknown>;
  weight?: number;
  evidence?: string;
  occurredAt?: string;
  validUntil?: string;
  sourceInstance: string;
}

/**
 * Input for updating a node.
 */
export interface UpdateNodeInput {
  type?: string;
  label?: string;
  description?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  lastConfirmedAt?: string;
  sourceInstance: string;
}

/**
 * Input for updating an edge.
 */
export interface UpdateEdgeInput {
  type?: string;
  properties?: Record<string, unknown>;
  weight?: number;
  evidence?: string;
  validUntil?: string;
  lastConfirmedAt?: string;
  sourceInstance?: string;
}

/**
 * Options for searching nodes.
 */
export interface SearchNodesOptions {
  /** Search query (will be embedded) */
  query?: string;
  /** Pre-computed query embedding */
  queryEmbedding?: number[];
  /** Filter by node type */
  type?: string;
  /** Minimum similarity score (0-1) */
  minScore?: number;
  /** Maximum results */
  limit?: number;
}

/**
 * Options for listing nodes.
 */
export interface ListNodesOptions {
  /** Filter by node type */
  type?: string;
  /** Include deleted nodes */
  includeDeleted?: boolean;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Options for getting edges.
 */
export interface GetEdgesOptions {
  /** Filter by source node */
  fromId?: string;
  /** Filter by target node */
  toId?: string;
  /** Filter by edge type */
  type?: string;
  /** Include deleted edges */
  includeDeleted?: boolean;
  /** Only edges currently valid (validUntil is null or in future) */
  onlyValid?: boolean;
}

/**
 * Options for graph traversal.
 */
export interface TraverseOptions {
  /** Starting node ID */
  startNodeId: string;
  /** Direction to traverse: out, in, or both */
  direction?: "out" | "in" | "both";
  /** Maximum depth to traverse */
  maxDepth?: number;
  /** Edge types to follow (empty = all) */
  edgeTypes?: string[];
  /** Maximum nodes to return */
  limit?: number;
}

/**
 * Result of graph traversal.
 */
export interface TraverseResult {
  /** Node that was traversed */
  node: GraphNode;
  /** Path from start to this node (edge IDs) */
  path: string[];
  /** Depth from start */
  depth: number;
}

/**
 * Result of node search.
 */
export interface NodeSearchResult {
  /** The node */
  node: GraphNode;
  /** Similarity score (0-1) */
  score: number;
}

/**
 * A subgraph extracted from the knowledge graph.
 */
export interface Subgraph {
  /** Nodes in the subgraph */
  nodes: GraphNode[];
  /** Edges in the subgraph */
  edges: GraphEdge[];
}

/**
 * An insight discovered from the graph.
 */
export interface GraphInsight {
  /** Type of insight */
  type: "pattern" | "cluster" | "bridge" | "anomaly" | "temporal";
  /** Human-readable description */
  description: string;
  /** Related node IDs */
  nodeIds: string[];
  /** Related edge IDs */
  edgeIds: string[];
  /** Confidence in this insight (0-1) */
  confidence: number;
}

/**
 * Statistics about the knowledge graph.
 */
export interface GraphStats {
  /** Total nodes (excluding deleted) */
  totalNodes: number;
  /** Total edges (excluding deleted) */
  totalEdges: number;
  /** Nodes by type */
  nodesByType: Record<string, number>;
  /** Edges by type */
  edgesByType: Record<string, number>;
  /** Oldest node createdAt */
  oldestNode?: string;
  /** Newest node createdAt */
  newestNode?: string;
}

/**
 * Embedding dimension for vector search.
 * Matches the all-MiniLM-L6-v2 model used in Psycheros.
 */
export const EMBEDDING_DIMENSION = 384;
