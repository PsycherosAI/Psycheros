/**
 * Vault Manager
 *
 * High-level API for managing vault documents.
 * Handles CRUD operations, file storage, text extraction,
 * chunking, embedding, and vector search.
 */

import { isAbsolute, join } from "@std/path";
import type { Database } from "@db/sqlite";
import type { DBClient } from "../db/mod.ts";
import type {
  VaultCreateOptions,
  VaultDocument,
  VaultFileType,
  VaultListOptions,
  VaultSearchOptions,
  VaultSearchResult,
} from "./types.ts";
import { VAULT_DEFAULT_MAX_CHUNKS, VAULT_DEFAULT_MAX_TOKENS } from "./types.ts";
import { extractText, resolveFileType } from "./processor.ts";
import { getChunker } from "../rag/chunker.ts";
import { getEmbedder } from "../rag/embedder.ts";
import { getVecVersion, serializeVector } from "../db/vector.ts";

/**
 * Row type for vault_documents table.
 */
interface VaultDocumentRow {
  id: string;
  title: string;
  filename: string;
  file_type: string;
  scope: string;
  conversation_id: string | null;
  file_path: string;
  file_size: number;
  content_hash: string;
  chunk_count: number;
  source: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Row type for vector search join result.
 */
interface VaultVectorSearchRow {
  id: string;
  document_id: string;
  content: string;
  token_count: number;
  metadata: string | null;
  created_at: string;
  title: string;
  distance: number;
}

/**
 * Generate a descriptive filename for a vault document.
 * Pattern: vault_{YYYY-MM-DD}_{slug}.{ext}
 * If a conflict exists, appends -N suffix.
 */
function generateVaultFilename(
  title: string,
  ext: string,
  vaultDir: string,
): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Slugify: lowercase, replace non-alphanumeric with dashes, collapse, trim, truncate
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  // Fallback if title produced no valid slug
  if (!slug) {
    slug = Math.random().toString(36).substring(2, 8);
  }

  const base = `vault_${date}_${slug}`;

  // Check for conflicts on disk
  try {
    const existing = [...Deno.readDirSync(vaultDir)]
      .map((e) => e.name);

    const filename = `${base}.${ext}`;
    if (!existing.includes(filename)) return filename;

    // Append numeric suffix until unique
    let n = 2;
    while (existing.includes(`${base}-${n}.${ext}`)) n++;
    return `${base}-${n}.${ext}`;
  } catch {
    // Directory may not exist yet or other IO error — just return base name
    return `${base}.${ext}`;
  }
}

/**
 * Hash content using SHA-256.
 */
async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * VaultManager provides CRUD operations and search for vault documents.
 */
export class VaultManager {
  private db: DBClient;
  private useVectorExt: boolean;
  /** Source root — for reading templates/vault/ seeds. */
  private projectRoot: string;
  /** Data root — for writing .psycheros/vault/documents/. */
  private dataRoot: string;

  constructor(db: DBClient, projectRoot: string, dataRoot: string) {
    this.db = db;
    this.projectRoot = projectRoot;
    this.dataRoot = dataRoot;
    this.useVectorExt = getVecVersion(db.getRawDb()) !== null;
  }

  // ===========================================================================
  // Template Seeding
  // ===========================================================================

  /**
   * Seed vault documents from templates/vault/ into the global vault.
   * Each template .md file is read, registered with the vault manager
   * (creating a DB record, file on disk, and embeddings), and skipped
   * on subsequent startups if already indexed.
   * Called once during server startup.
   */
  async indexSeededTemplates(): Promise<void> {
    const templateDir = join(this.projectRoot, "templates", "vault");

    try {
      for await (const entry of Deno.readDir(templateDir)) {
        if (!entry.isFile) continue;
        if (!entry.name.endsWith(".md")) continue;

        // Derive a human-readable title from the filename
        const title = entry.name.replace(/\.[^.]+$/, "")
          .replace(/[-_]+/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());

        // Check if a document with this title already exists in the vault
        const db = this.db.getRawDb();
        const stmt = db.prepare(
          "SELECT id FROM vault_documents WHERE title = ? AND scope = 'global'",
        );
        const existing = stmt.get<{ id: string }>(title);
        stmt.finalize();

        if (existing) continue;

        // Not yet indexed — read template and register it
        const content = await Deno.readTextFile(join(templateDir, entry.name));
        const doc = await this.createFromContent(title, content, {
          scope: "global",
        });
        console.log(`[Vault] Indexed seeded template: "${doc.title}"`);
      }
    } catch {
      // templates/vault/ directory doesn't exist — nothing to seed
    }
  }

  // ===========================================================================
  // Document CRUD
  // ===========================================================================

  /**
   * List vault documents with optional filtering.
   */
  listDocuments(opts: VaultListOptions = {}): VaultDocument[] {
    const db = this.db.getRawDb();
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (opts.scope && opts.scope !== "all") {
      conditions.push("scope = ?");
      values.push(opts.scope);
    }

    if (opts.conversationId) {
      // Show global + matching per-chat
      conditions.push("(scope = 'global' OR conversation_id = ?)");
      values.push(opts.conversationId);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const stmt = db.prepare(
      `SELECT id, title, filename, file_type, scope, conversation_id, file_path,
              file_size, content_hash, chunk_count, source, enabled, created_at, updated_at
       FROM vault_documents ${where}
       ORDER BY created_at DESC`,
    );

    const rows = stmt.all<VaultDocumentRow>(...values);
    stmt.finalize();

    return rows.map((row) => this.rowToDocument(row));
  }

  /**
   * Get a single vault document by ID.
   */
  getDocument(id: string): VaultDocument | null {
    const db = this.db.getRawDb();
    const stmt = db.prepare(
      `SELECT id, title, filename, file_type, scope, conversation_id, file_path,
              file_size, content_hash, chunk_count, source, enabled, created_at, updated_at
       FROM vault_documents
       WHERE id = ?`,
    );

    const row = stmt.get<VaultDocumentRow>(id);
    stmt.finalize();

    return row ? this.rowToDocument(row) : null;
  }

  /**
   * Create a vault document from an uploaded file.
   */
  async createFromUpload(
    file: File,
    opts: VaultCreateOptions,
  ): Promise<VaultDocument> {
    const fileType = resolveFileType(file.name, file.type);
    if (!fileType) {
      throw new Error(`Unsupported file type: ${file.name}`);
    }

    const vaultDir = this.getVaultDir(opts);
    await Deno.mkdir(vaultDir, { recursive: true });

    const ext = file.name.split(".").pop()?.toLowerCase() || fileType;
    const title = (opts.title || file.name.replace(/\.[^.]+$/, "")).trim();
    const filename = generateVaultFilename(title, ext, vaultDir);
    const filePath = join(vaultDir, filename);

    // Write file to disk
    const arrayBuffer = await file.arrayBuffer();
    await Deno.writeFile(filePath, new Uint8Array(arrayBuffer));

    // Extract text and process
    const text = await extractText(filePath, fileType);
    return await this.processNewDocument({
      title,
      filename,
      fileType,
      filePath,
      fileSize: file.size,
      source: "upload" as const,
      scope: opts.scope,
      conversationId: opts.conversationId,
      text,
    });
  }

  /**
   * Create a vault document from content (entity-created).
   */
  async createFromContent(
    title: string,
    content: string,
    opts: VaultCreateOptions,
  ): Promise<VaultDocument> {
    const vaultDir = this.getVaultDir(opts);
    await Deno.mkdir(vaultDir, { recursive: true });

    const filename = generateVaultFilename(title.trim(), "md", vaultDir);
    const filePath = join(vaultDir, filename);

    await Deno.writeTextFile(filePath, content);

    return await this.processNewDocument({
      title,
      filename,
      fileType: "md",
      filePath,
      fileSize: new TextEncoder().encode(content).length,
      source: "entity" as const,
      scope: opts.scope,
      conversationId: opts.conversationId,
      text: content,
    });
  }

  /**
   * Update a vault document's title or re-process if content changed.
   */
  async updateDocument(
    id: string,
    updates: { title?: string; content?: string },
  ): Promise<VaultDocument | null> {
    const doc = this.getDocument(id);
    if (!doc) return null;

    const db = this.db.getRawDb();
    const now = new Date().toISOString();

    if (updates.content !== undefined) {
      // Re-write the file
      await Deno.writeTextFile(doc.filePath, updates.content);

      // Check if content actually changed
      const newHash = await hashContent(updates.content);
      if (newHash !== doc.contentHash) {
        // Remove old chunks and re-process
        this.removeChunks(id);
        const chunkCount = await this.indexContent(id, updates.content);

        db.exec(
          `UPDATE vault_documents
           SET content_hash = ?, chunk_count = ?, updated_at = ?
           WHERE id = ?`,
          [newHash, chunkCount, now, id],
        );

        const updated = this.getDocument(id)!;
        if (updates.title) {
          db.exec(
            `UPDATE vault_documents SET title = ?, updated_at = ? WHERE id = ?`,
            [updates.title, now, id],
          );
          return this.getDocument(id);
        }
        return updated;
      }
    }

    if (updates.title !== undefined) {
      db.exec(
        `UPDATE vault_documents SET title = ?, updated_at = ? WHERE id = ?`,
        [updates.title, now, id],
      );
    }

    return this.getDocument(id);
  }

  /**
   * Delete a vault document and all associated data.
   */
  deleteDocument(id: string): boolean {
    const doc = this.getDocument(id);
    if (!doc) return false;

    const db = this.db.getRawDb();

    // Remove chunks (including vector table entries)
    this.removeChunks(id);

    // Remove document record
    const result = db.exec("DELETE FROM vault_documents WHERE id = ?", [id]);

    // Remove file from disk
    try {
      Deno.remove(doc.filePath);
    } catch {
      // File may already be gone
    }

    return result > 0;
  }

  /**
   * Search the vault for relevant content.
   * Always includes global documents, includes per-chat only when conversationId matches.
   */
  async search(
    query: string,
    opts: VaultSearchOptions = {},
  ): Promise<VaultSearchResult[]> {
    const maxChunks = opts.maxChunks ?? VAULT_DEFAULT_MAX_CHUNKS;
    const minScore = opts.minScore ?? 0.3;
    const maxTokens = VAULT_DEFAULT_MAX_TOKENS;

    const embedder = getEmbedder();
    await embedder.initialize();
    const queryEmbedding = await embedder.embed(query);

    const db = this.db.getRawDb();

    // Build scope filter
    const scopeConditions = ["(vd.scope = 'global' OR vd.enabled = 1)"];
    const values: (string | number)[] = [];

    if (opts.conversationId) {
      scopeConditions.push("(vd.scope = 'global' OR vd.conversation_id = ?)");
      values.push(opts.conversationId);
    } else {
      scopeConditions.push("vd.scope = 'global'");
    }

    const scopeWhere = scopeConditions.join(" AND ");

    let results: VaultSearchResult[];

    if (this.useVectorExt) {
      results = this.searchWithVectorExt(
        db,
        queryEmbedding,
        scopeWhere,
        values,
        maxChunks,
        minScore,
        maxTokens,
      );
    } else {
      results = this.searchInMemory(
        db,
        queryEmbedding,
        scopeWhere,
        values,
        maxChunks,
        minScore,
        maxTokens,
      );
    }

    console.log(
      `[Vault] Search found ${results.length} chunks${
        this.useVectorExt ? " [sqlite-vec]" : " [in-memory]"
      }`,
    );

    return results;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Get the vault storage directory for a given scope.
   */
  private getVaultDir(opts: VaultCreateOptions): string {
    // Store vault files inside .psycheros/ so they persist across Docker
    // container recreations (the .psycheros/ directory is a volume mount).
    const baseDir = join(this.dataRoot, ".psycheros", "vault", "documents");
    if (opts.scope === "chat" && opts.conversationId) {
      return join(baseDir, `chat-${opts.conversationId}`);
    }
    return join(baseDir, "global");
  }

  /**
   * Process a new document: hash, chunk, embed, insert.
   */
  private async processNewDocument(params: {
    title: string;
    filename: string;
    fileType: VaultFileType;
    filePath: string;
    fileSize: number;
    source: "upload" | "entity";
    scope: "global" | "chat";
    conversationId?: string;
    text: string;
  }): Promise<VaultDocument> {
    const {
      title,
      filename,
      fileType,
      filePath,
      fileSize,
      source,
      scope,
      conversationId,
      text,
    } = params;

    const contentHash = await hashContent(text);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create document record first (chunk_count will be updated after indexing)
    const db = this.db.getRawDb();
    db.exec(
      `INSERT INTO vault_documents
       (id, title, filename, file_type, scope, conversation_id, file_path,
        file_size, content_hash, chunk_count, source, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        title,
        filename,
        fileType,
        scope,
        conversationId ?? null,
        filePath,
        fileSize,
        contentHash,
        0, // chunk_count placeholder
        source,
        1, // enabled
        now,
        now,
      ],
    );

    // Index the content into chunks
    const chunkCount = await this.indexContent(id, text);

    // Update chunk count
    db.exec(
      `UPDATE vault_documents SET chunk_count = ? WHERE id = ?`,
      [chunkCount, id],
    );

    console.log(
      `[Vault] Created document "${title}" (${chunkCount} chunks, ${source}, ${scope})`,
    );

    return this.getDocument(id)!;
  }

  /**
   * Chunk, embed, and store content for a document.
   */
  private async indexContent(
    documentId: string,
    text: string,
  ): Promise<number> {
    const embedder = getEmbedder();
    await embedder.initialize();
    const chunker = getChunker();

    let chunks = chunker.chunk(text, `vault-${documentId}`);

    // The memory chunker has a 100-char minimum and may return zero chunks
    // for very short content. Fall back to treating the whole text as one chunk.
    if (chunks.length === 0 && text.trim().length > 0) {
      chunks = [{
        id: crypto.randomUUID(),
        content: text.trim(),
        tokenCount: text.trim().length,
        sourceFile: `vault-${documentId}`,
        createdAt: new Date(),
      }];
    }

    const db = this.db.getRawDb();
    let count = 0;

    for (const chunk of chunks) {
      const embedding = await embedder.embed(chunk.content);
      const embeddingData = serializeVector(embedding);

      db.exec(
        `INSERT INTO vault_chunks (id, document_id, content, token_count, metadata, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          chunk.id,
          documentId,
          chunk.content,
          chunk.tokenCount,
          chunk.metadata ? JSON.stringify(chunk.metadata) : null,
          embeddingData,
          chunk.createdAt.toISOString(),
        ],
      );

      // Insert into vector table if available
      if (this.useVectorExt) {
        const rowidStmt = db.prepare(
          "SELECT rowid FROM vault_chunks WHERE id = ?",
        );
        const row = rowidStmt.get<{ rowid: number }>(chunk.id);
        rowidStmt.finalize();

        if (row) {
          db.exec(
            "INSERT INTO vec_vault_chunks(rowid, embedding) VALUES (?, ?)",
            [row.rowid, embeddingData],
          );
        }
      }

      count++;
    }

    return count;
  }

  /**
   * Remove all chunks for a document (from both tables).
   */
  private removeChunks(documentId: string): void {
    const db = this.db.getRawDb();

    if (this.useVectorExt) {
      const stmt = db.prepare(
        "SELECT rowid FROM vault_chunks WHERE document_id = ?",
      );
      const rows = stmt.all<{ rowid: number }>(documentId);
      stmt.finalize();

      for (const row of rows) {
        db.exec("DELETE FROM vec_vault_chunks WHERE rowid = ?", [row.rowid]);
      }
    }

    db.exec("DELETE FROM vault_chunks WHERE document_id = ?", [documentId]);
  }

  /**
   * Search using sqlite-vec extension.
   */
  private searchWithVectorExt(
    db: Database,
    queryEmbedding: number[],
    scopeWhere: string,
    values: (string | number)[],
    maxChunks: number,
    minScore: number,
    maxTokens: number,
  ): VaultSearchResult[] {
    const serialized = serializeVector(queryEmbedding);
    const limit = maxChunks * 2;

    const stmt = db.prepare(
      `SELECT vc.id, vc.document_id, vc.content, vc.token_count, vc.metadata, vc.created_at,
              vd.title, v.distance
       FROM (
         SELECT rowid, distance
         FROM vec_vault_chunks
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?
       ) v
       JOIN vault_chunks vc ON vc.rowid = v.rowid
       JOIN vault_documents vd ON vd.id = vc.document_id
       WHERE vd.enabled = 1 AND ${scopeWhere}
       ORDER BY v.distance`,
    );

    const rows = stmt.all<VaultVectorSearchRow>(
      serialized,
      limit,
      ...values,
    ) as VaultVectorSearchRow[];
    stmt.finalize();

    return this.rankAndBudgetResults(rows, minScore, maxChunks, maxTokens);
  }

  /**
   * Search using in-memory cosine similarity (fallback).
   */
  private searchInMemory(
    db: Database,
    queryEmbedding: number[],
    scopeWhere: string,
    values: (string | number)[],
    maxChunks: number,
    minScore: number,
    maxTokens: number,
  ): VaultSearchResult[] {
    const stmt = db.prepare(
      `SELECT vc.id, vc.document_id, vc.content, vc.token_count, vc.metadata, vc.created_at, vd.title
       FROM vault_chunks vc
       JOIN vault_documents vd ON vd.id = vc.document_id
       WHERE vd.enabled = 1 AND ${scopeWhere}`,
    );

    type NoDistRow = Omit<VaultVectorSearchRow, "distance">;
    const rows = stmt.all(...values) as NoDistRow[];
    stmt.finalize();

    // Calculate cosine similarity for each
    const scored: VaultVectorSearchRow[] = [];
    for (const row of rows) {
      const embeddingStmt = db.prepare(
        "SELECT embedding FROM vault_chunks WHERE id = ?",
      );
      const embeddingRow = embeddingStmt.get<{ embedding: Uint8Array | null }>(
        row.id,
      ) as { embedding: Uint8Array | null } | undefined;
      embeddingStmt.finalize();

      if (embeddingRow?.embedding) {
        const vec = this.deserializeVector(embeddingRow.embedding);
        const similarity = this.cosineSimilarity(queryEmbedding, vec);
        scored.push({ ...row, distance: 1 - similarity });
      }
    }

    return this.rankAndBudgetResults(scored, minScore, maxChunks, maxTokens);
  }

  /**
   * Rank results by score and apply token budget.
   */
  private rankAndBudgetResults(
    rows: VaultVectorSearchRow[],
    minScore: number,
    maxChunks: number,
    maxTokens: number,
  ): VaultSearchResult[] {
    const results: VaultSearchResult[] = [];
    let totalTokens = 0;

    for (const row of rows) {
      const similarity = 1 - row.distance;
      if (similarity < minScore) continue;
      if (results.length >= maxChunks) break;
      if (totalTokens + row.token_count > maxTokens) continue;

      totalTokens += row.token_count;
      results.push({
        chunk: {
          id: row.id,
          documentId: row.document_id,
          content: row.content,
          tokenCount: row.token_count,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          createdAt: row.created_at,
        },
        documentTitle: row.title,
        score: similarity,
      });
    }

    return results;
  }

  /**
   * Deserialize a vector from Uint8Array.
   */
  private deserializeVector(data: Uint8Array): number[] {
    return Array.from(new Float32Array(data.buffer));
  }

  /**
   * Calculate cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private rowToDocument(row: VaultDocumentRow): VaultDocument {
    // file_path is stored either absolute (legacy: seed/upload code paths)
    // or relative-to-dataRoot (import code path). Resolve to absolute so
    // every consumer of VaultDocument.filePath gets a path it can pass
    // straight to Deno.readFile.
    const filePath = isAbsolute(row.file_path)
      ? row.file_path
      : join(this.dataRoot, row.file_path);
    return {
      id: row.id,
      title: row.title,
      filename: row.filename,
      fileType: row.file_type as VaultFileType,
      scope: row.scope as VaultDocument["scope"],
      conversationId: row.conversation_id ?? undefined,
      filePath,
      fileSize: row.file_size,
      contentHash: row.content_hash,
      chunkCount: row.chunk_count,
      source: row.source as VaultDocument["source"],
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
