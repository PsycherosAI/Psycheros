/**
 * Google Tasks API wrapper.
 *
 * Wraps https://tasks.googleapis.com/tasks/v1/. Methods take a GoogleClient
 * and return typed results. Errors throw GoogleApiError (re-exported from
 * calendar.ts).
 *
 * List model: tasks live in "task lists." Every account has a default list
 * (resource ID literally "@default"). The omni-tool accepts tasklist_id as
 * an optional parameter; pending_tasks hook queries the default list only
 * (documented limitation — multi-list aggregation is a fast-follow).
 *
 * Status model: each task has status "needsAction" (incomplete) or
 * "completed". Setting status to "completed" auto-stamps `completed` timestamp.
 * Setting back to "needsAction" clears `completed`.
 */

import type { GoogleClient } from "../client/google-client.ts";
import { GoogleApiError } from "./calendar.ts";

export { GoogleApiError };

const TASKS_API_BASE = "https://tasks.googleapis.com/tasks/v1";
const DEFAULT_LIST_ID = "@default";

export interface Task {
  id: string;
  title: string;
  notes?: string;
  /** RFC 3339 timestamp. */
  due?: string;
  /** RFC 3339 timestamp — populated when status === "completed". */
  completed?: string;
  /** "needsAction" (incomplete) | "completed". */
  status?: "needsAction" | "completed";
  /** Parent task ID — for nested tasks (Google Tasks supports one level). */
  parent?: string;
  /** Sort position within parent. */
  position?: string;
  /** ISO timestamp of last update. */
  updated?: string;
  /** Soft-deleted (moved to trash). */
  deleted?: boolean;
  /** Hidden by completion cleanup. */
  hidden?: boolean;
  links?: Array<{ type: string; description: string; link: string }>;
}

export interface TaskList {
  id: string;
  title: string;
  /** ISO timestamp of last update. */
  updated?: string;
  /** Self-link. */
  selfLink?: string;
}

export interface ListTasksOptions {
  tasklistId?: string;
  /** Filter: include completed tasks. Default false (incomplete only). */
  showCompleted?: boolean;
  /** Filter: include deleted tasks. Default false. */
  showDeleted?: boolean;
  /** Filter: include hidden tasks. Default false. */
  showHidden?: boolean;
  /** Filter: only tasks due on or before this RFC 3339 date. */
  dueMax?: string;
  /** Filter: only tasks updated after this RFC 3339 date (sync token use). */
  updatedMin?: string;
  maxResults?: number;
  pageToken?: string;
}

export interface ListTasksResult {
  tasks: Task[];
  nextPageToken?: string;
}

export interface NewTask {
  title: string;
  notes?: string;
  due?: string;
  /** For nesting — parent task ID within the same list. */
  parent?: string;
  /** Optional position — usually omitted (Google picks default). */
  previous?: string;
}

export interface UpdateTaskFields {
  title?: string;
  notes?: string;
  due?: string;
  status?: "needsAction" | "completed";
}

const MAX_LIST_RESULTS_CAP = 100;
const DEFAULT_LIST_RESULTS = 50;

/** List the user's task lists (default + any user-created). */
export async function listTaskLists(
  client: GoogleClient,
): Promise<TaskList[]> {
  const data = await client.fetchJson<{ items?: TaskList[] }>(
    `${TASKS_API_BASE}/users/@me/lists`,
  );
  return data.items ?? [];
}

/**
 * List tasks in a task list. Default list ID is "@default" (Google's name).
 * Default filters: incomplete, non-deleted, non-hidden.
 */
export async function listTasks(
  client: GoogleClient,
  opts: ListTasksOptions = {},
): Promise<ListTasksResult> {
  const tasklistId = opts.tasklistId ?? DEFAULT_LIST_ID;
  const url = new URL(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(tasklistId)}/tasks`,
  );
  url.searchParams.set("showCompleted", String(opts.showCompleted ?? false));
  url.searchParams.set("showDeleted", String(opts.showDeleted ?? false));
  url.searchParams.set("showHidden", String(opts.showHidden ?? false));
  if (opts.dueMax) url.searchParams.set("dueMax", opts.dueMax);
  if (opts.updatedMin) url.searchParams.set("updatedMin", opts.updatedMin);
  const maxResults = opts.maxResults !== undefined
    ? Math.min(Math.max(1, opts.maxResults), MAX_LIST_RESULTS_CAP)
    : DEFAULT_LIST_RESULTS;
  url.searchParams.set("maxResults", String(maxResults));
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const data = await client.fetchJson<
    { items?: Task[]; nextPageToken?: string }
  >(
    url.toString(),
  );
  return {
    tasks: data.items ?? [],
    nextPageToken: data.nextPageToken,
  };
}

/** Get a single task by ID. Returns full notes field. */
export async function getTask(
  client: GoogleClient,
  taskId: string,
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<Task> {
  const url = `${TASKS_API_BASE}/lists/${
    encodeURIComponent(tasklistId)
  }/tasks/${encodeURIComponent(taskId)}`;
  return await client.fetchJson<Task>(url);
}

/** Create a task. Returns the created task with ID. */
export async function createTask(
  client: GoogleClient,
  task: NewTask,
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<Task> {
  const body: Record<string, unknown> = { title: task.title };
  if (task.notes) body.notes = task.notes;
  if (task.due) body.due = task.due;
  // For nested tasks, parent + previous go as query params per Google's spec.
  const url = new URL(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(tasklistId)}/tasks`,
  );
  if (task.parent) url.searchParams.set("parent", task.parent);
  if (task.previous) url.searchParams.set("previous", task.previous);
  return await client.fetchJson<Task>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Update fields on a task. Returns the updated task. */
export async function updateTask(
  client: GoogleClient,
  taskId: string,
  updates: UpdateTaskFields,
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<Task> {
  const body: Record<string, unknown> = {};
  if (updates.title !== undefined) body.title = updates.title;
  if (updates.notes !== undefined) body.notes = updates.notes;
  if (updates.due !== undefined) body.due = updates.due;
  if (updates.status !== undefined) body.status = updates.status;

  const url = `${TASKS_API_BASE}/lists/${
    encodeURIComponent(tasklistId)
  }/tasks/${encodeURIComponent(taskId)}`;
  return await client.fetchJson<Task>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Mark a task complete. Convenience wrapper around updateTask with
 * status="completed" — included because the omni-tool has a dedicated
 * "complete" action per user request.
 */
export async function completeTask(
  client: GoogleClient,
  taskId: string,
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<Task> {
  return await updateTask(client, taskId, { status: "completed" }, tasklistId);
}

/**
 * Mark a task incomplete (move back to "needsAction"). Clears `completed`.
 */
export async function uncompleteTask(
  client: GoogleClient,
  taskId: string,
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<Task> {
  return await updateTask(
    client,
    taskId,
    { status: "needsAction" },
    tasklistId,
  );
}

/** Delete a task permanently. */
export async function deleteTask(
  client: GoogleClient,
  taskId: string,
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<void> {
  const url = `${TASKS_API_BASE}/lists/${
    encodeURIComponent(tasklistId)
  }/tasks/${encodeURIComponent(taskId)}`;
  const response = await client.fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 204) {
    const body = await response.text();
    throw new GoogleApiError(
      `delete ${response.status}: ${body}`,
      response.status,
      body,
    );
  }
}

export interface BatchResult {
  succeeded: number;
  failed: Array<{ id: string; error: string }>;
}

/** Complete multiple tasks at once. Returns per-task results. */
export async function batchCompleteTasks(
  client: GoogleClient,
  taskIds: string[],
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<BatchResult> {
  return batchOp(taskIds, (id) => completeTask(client, id, tasklistId));
}

/** Delete multiple tasks at once. */
export async function batchDeleteTasks(
  client: GoogleClient,
  taskIds: string[],
  tasklistId: string = DEFAULT_LIST_ID,
): Promise<BatchResult> {
  return batchOp(taskIds, (id) => deleteTask(client, id, tasklistId));
}

/** Process a batch in chunks of 10 to avoid rate limits. */
async function batchOp(
  ids: string[],
  op: (id: string) => Promise<unknown>,
): Promise<BatchResult> {
  const failed: Array<{ id: string; error: string }> = [];
  let succeeded = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const results = await Promise.allSettled(chunk.map(op));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") succeeded++;
      else {
        failed.push({
          id: chunk[j],
          error: r.reason instanceof Error
            ? r.reason.message
            : String(r.reason),
        });
      }
    }
  }
  return { succeeded, failed };
}
