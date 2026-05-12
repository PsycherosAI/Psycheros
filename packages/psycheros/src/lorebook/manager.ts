/**
 * Lorebook Manager
 *
 * High-level API for managing lorebooks and entries.
 * Provides CRUD operations and the main evaluation function.
 */

import type { DBClient } from "../db/mod.ts";
import type {
  CreateLorebookData,
  CreateLorebookEntryData,
  EvaluatedEntry,
  Lorebook,
  LorebookEntry,
  TriggerMode,
  UpdateLorebookData,
  UpdateLorebookEntryData,
} from "./types.ts";
import { evaluateLorebook } from "./evaluator.ts";
import { buildLorebookContext } from "./context-builder.ts";
import { clearState, loadState, saveState } from "./state-manager.ts";

/**
 * Row type for lorebooks table.
 */
interface LorebookRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Row type for lorebook_entries table.
 */
interface LorebookEntryRow {
  id: string;
  book_id: string;
  name: string;
  content: string;
  triggers: string;
  trigger_mode: string;
  case_sensitive: number;
  sticky: number;
  sticky_duration: number;
  non_recursable: number;
  prevent_recursion: number;
  re_trigger_resets_timer: number;
  enabled: number;
  priority: number;
  scan_depth: number;
  max_tokens: number;
  created_at: string;
  updated_at: string;
}

/**
 * LorebookManager provides high-level operations for lorebooks.
 */
export class LorebookManager {
  constructor(private db: DBClient) {}

  // ===========================================================================
  // Lorebook CRUD
  // ===========================================================================

  /**
   * List all lorebooks.
   */
  listLorebooks(): Lorebook[] {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(
      `SELECT id, name, description, enabled, created_at, updated_at
       FROM lorebooks
       ORDER BY created_at ASC`,
    );

    const rows = stmt.all<LorebookRow>();
    stmt.finalize();

    return rows.map((row) => this.rowToLorebook(row));
  }

  /**
   * Get a lorebook by ID.
   */
  getLorebook(id: string): Lorebook | null {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(
      `SELECT id, name, description, enabled, created_at, updated_at
       FROM lorebooks
       WHERE id = ?`,
    );

    const row = stmt.get<LorebookRow>(id);
    stmt.finalize();

    return row ? this.rowToLorebook(row) : null;
  }

  /**
   * Create a new lorebook.
   */
  createLorebook(data: CreateLorebookData): Lorebook {
    const rawDb = this.db.getRawDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    rawDb.exec(
      `INSERT INTO lorebooks (id, name, description, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.name, data.description ?? null, data.enabled ? 1 : 0, now, now],
    );

    return {
      id,
      name: data.name,
      description: data.description,
      enabled: data.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Update a lorebook.
   */
  updateLorebook(id: string, data: UpdateLorebookData): Lorebook | null {
    const lorebook = this.getLorebook(id);
    if (!lorebook) return null;

    const rawDb = this.db.getRawDb();
    const now = new Date().toISOString();

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.name !== undefined) {
      updates.push("name = ?");
      values.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push("description = ?");
      values.push(data.description ?? null);
    }
    if (data.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(data.enabled ? 1 : 0);
    }

    if (updates.length === 0) return lorebook;

    updates.push("updated_at = ?");
    values.push(now);
    values.push(id);

    rawDb.exec(
      `UPDATE lorebooks SET ${updates.join(", ")} WHERE id = ?`,
      values,
    );

    return {
      ...lorebook,
      ...data,
      updatedAt: now,
    };
  }

  /**
   * Delete a lorebook and all its entries.
   */
  deleteLorebook(id: string): boolean {
    const rawDb = this.db.getRawDb();
    const result = rawDb.exec(`DELETE FROM lorebooks WHERE id = ?`, [id]);
    return result > 0;
  }

  // ===========================================================================
  // Lorebook Entry CRUD
  // ===========================================================================

  /**
   * List all entries for a lorebook.
   */
  listEntries(bookId: string): LorebookEntry[] {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(
      `SELECT id, book_id, name, content, triggers, trigger_mode, case_sensitive,
              sticky, sticky_duration, non_recursable, prevent_recursion,
              re_trigger_resets_timer, enabled, priority, scan_depth,
              max_tokens, created_at, updated_at
       FROM lorebook_entries
       WHERE book_id = ?
       ORDER BY priority DESC, created_at ASC`,
    );

    const rows = stmt.all<LorebookEntryRow>(bookId);
    stmt.finalize();

    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Get an entry by ID.
   */
  getEntry(id: string): LorebookEntry | null {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(
      `SELECT id, book_id, name, content, triggers, trigger_mode, case_sensitive,
              sticky, sticky_duration, non_recursable, prevent_recursion,
              re_trigger_resets_timer, enabled, priority, scan_depth,
              max_tokens, created_at, updated_at
       FROM lorebook_entries
       WHERE id = ?`,
    );

    const row = stmt.get<LorebookEntryRow>(id);
    stmt.finalize();

    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Create a new entry.
   */
  createEntry(bookId: string, data: CreateLorebookEntryData): LorebookEntry {
    const rawDb = this.db.getRawDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    rawDb.exec(
      `INSERT INTO lorebook_entries
       (id, book_id, name, content, triggers, trigger_mode, case_sensitive,
        sticky, sticky_duration, non_recursable, prevent_recursion,
        re_trigger_resets_timer, enabled, priority, scan_depth,
        max_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        bookId,
        data.name,
        data.content,
        JSON.stringify(data.triggers),
        data.triggerMode ?? "substring",
        data.caseSensitive ? 1 : 0,
        data.sticky ? 1 : 0,
        data.stickyDuration ?? 0,
        data.nonRecursable ? 1 : 0,
        data.preventRecursion ? 1 : 0,
        data.reTriggerResetsTimer !== false ? 1 : 0,
        data.enabled !== false ? 1 : 0,
        data.priority ?? 0,
        data.scanDepth ?? 5,
        data.maxTokens ?? 0,
        now,
        now,
      ],
    );

    return {
      id,
      bookId,
      name: data.name,
      content: data.content,
      triggers: data.triggers,
      triggerMode: (data.triggerMode ?? "substring") as TriggerMode,
      caseSensitive: data.caseSensitive ?? false,
      sticky: data.sticky ?? false,
      stickyDuration: data.stickyDuration ?? 0,
      nonRecursable: data.nonRecursable ?? false,
      preventRecursion: data.preventRecursion ?? false,
      reTriggerResetsTimer: data.reTriggerResetsTimer !== false,
      enabled: data.enabled !== false,
      priority: data.priority ?? 0,
      scanDepth: data.scanDepth ?? 5,
      maxTokens: data.maxTokens ?? 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Update an entry.
   */
  updateEntry(id: string, data: UpdateLorebookEntryData): LorebookEntry | null {
    const entry = this.getEntry(id);
    if (!entry) return null;

    const rawDb = this.db.getRawDb();
    const now = new Date().toISOString();

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.name !== undefined) {
      updates.push("name = ?");
      values.push(data.name);
    }
    if (data.content !== undefined) {
      updates.push("content = ?");
      values.push(data.content);
    }
    if (data.triggers !== undefined) {
      updates.push("triggers = ?");
      values.push(JSON.stringify(data.triggers));
    }
    if (data.triggerMode !== undefined) {
      updates.push("trigger_mode = ?");
      values.push(data.triggerMode);
    }
    if (data.caseSensitive !== undefined) {
      updates.push("case_sensitive = ?");
      values.push(data.caseSensitive ? 1 : 0);
    }
    if (data.sticky !== undefined) {
      updates.push("sticky = ?");
      values.push(data.sticky ? 1 : 0);
    }
    if (data.stickyDuration !== undefined) {
      updates.push("sticky_duration = ?");
      values.push(data.stickyDuration);
    }
    if (data.nonRecursable !== undefined) {
      updates.push("non_recursable = ?");
      values.push(data.nonRecursable ? 1 : 0);
    }
    if (data.preventRecursion !== undefined) {
      updates.push("prevent_recursion = ?");
      values.push(data.preventRecursion ? 1 : 0);
    }
    if (data.reTriggerResetsTimer !== undefined) {
      updates.push("re_trigger_resets_timer = ?");
      values.push(data.reTriggerResetsTimer ? 1 : 0);
    }
    if (data.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(data.enabled ? 1 : 0);
    }
    if (data.priority !== undefined) {
      updates.push("priority = ?");
      values.push(data.priority);
    }
    if (data.scanDepth !== undefined) {
      updates.push("scan_depth = ?");
      values.push(data.scanDepth);
    }
    if (data.maxTokens !== undefined) {
      updates.push("max_tokens = ?");
      values.push(data.maxTokens);
    }

    if (updates.length === 0) return entry;

    updates.push("updated_at = ?");
    values.push(now);
    values.push(id);

    rawDb.exec(
      `UPDATE lorebook_entries SET ${updates.join(", ")} WHERE id = ?`,
      values,
    );

    return {
      ...entry,
      ...data,
      updatedAt: now,
    };
  }

  /**
   * Delete an entry.
   */
  deleteEntry(id: string): boolean {
    const rawDb = this.db.getRawDb();
    const result = rawDb.exec(`DELETE FROM lorebook_entries WHERE id = ?`, [
      id,
    ]);
    return result > 0;
  }

  // ===========================================================================
  // Evaluation
  // ===========================================================================

  /**
   * Get all enabled entries from all enabled lorebooks.
   */
  getAllEnabledEntries(): LorebookEntry[] {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(
      `SELECT le.id, le.book_id, le.name, le.content, le.triggers, le.trigger_mode,
              le.case_sensitive, le.sticky, le.sticky_duration, le.non_recursable,
              le.prevent_recursion, le.re_trigger_resets_timer, le.enabled, le.priority,
              le.scan_depth, le.max_tokens, le.created_at, le.updated_at
       FROM lorebook_entries le
       JOIN lorebooks l ON le.book_id = l.id
       WHERE le.enabled = 1 AND l.enabled = 1
       ORDER BY le.priority DESC, le.created_at ASC`,
    );

    const rows = stmt.all<LorebookEntryRow>();
    stmt.finalize();

    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Evaluate which entries should be active for a conversation turn.
   *
   * @param userMessage - The current user message
   * @param history - Recent conversation history
   * @param conversationId - The conversation ID
   * @param options - Optional evaluation options
   * @returns The formatted lorebook context and evaluated entries
   */
  evaluate(
    userMessage: string,
    history: Array<{ role: string; content: string }>,
    conversationId: string,
    options?: { skipStickyDecrement?: boolean },
  ): { context: string; entries: EvaluatedEntry[]; totalTokens: number } {
    // Load all enabled entries
    const entries = this.getAllEnabledEntries();

    if (entries.length === 0) {
      return { context: "", entries: [], totalTokens: 0 };
    }

    // Load existing state
    const state = loadState(this.db, conversationId);

    // Evaluate
    const result = evaluateLorebook(
      entries,
      {
        userMessage,
        history,
        conversationId,
        skipStickyDecrement: options?.skipStickyDecrement,
      },
      state,
    );

    // Save new state if changed, or clear expired state
    if (result.newState) {
      console.log(
        `[Lorebook] Saving state with ${result.newState.activeEntries.size} active entries`,
      );
      saveState(this.db, result.newState);
    } else {
      console.log(
        `[Lorebook] No new state to save (all entries expired or none triggered)`,
      );
      // Clean up any stale state rows for this conversation
      clearState(this.db, conversationId);
    }

    // Build context string
    const context = buildLorebookContext(result.entries);

    return {
      context,
      entries: result.entries,
      totalTokens: result.totalTokens,
    };
  }

  /**
   * Reset sticky state for a conversation.
   */
  resetState(conversationId: string): void {
    clearState(this.db, conversationId);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private rowToLorebook(row: LorebookRow): Lorebook {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToEntry(row: LorebookEntryRow): LorebookEntry {
    let triggers: string[];
    try {
      triggers = JSON.parse(row.triggers);
    } catch {
      triggers = [];
    }

    return {
      id: row.id,
      bookId: row.book_id,
      name: row.name,
      content: row.content,
      triggers,
      triggerMode: row.trigger_mode as TriggerMode,
      caseSensitive: row.case_sensitive === 1,
      sticky: row.sticky === 1,
      stickyDuration: row.sticky_duration,
      nonRecursable: row.non_recursable === 1,
      preventRecursion: row.prevent_recursion === 1,
      reTriggerResetsTimer: row.re_trigger_resets_timer === 1,
      enabled: row.enabled === 1,
      priority: row.priority,
      scanDepth: row.scan_depth,
      maxTokens: row.max_tokens,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
