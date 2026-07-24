/**
 * google_tasks omni-tool — all Tasks operations in one tool.
 *
 * Action parameter selects the operation. Mutations (create / update /
 * complete / uncomplete / delete) invalidate the pending_tasks cache after
 * API success so the next turn's hook sees fresh data.
 *
 * Default task list is "@default" (Google's auto-created primary list).
 * Operator can pass tasklist_id to target a different list. The pending_tasks
 * hook queries the default list only.
 */

import type { Tool } from "../../../../src/tools/types.ts";
import { getGoogleClient, getHookCache } from "../plugin-state.ts";
import {
  batchCompleteTasks,
  batchDeleteTasks,
  type BatchResult,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  GoogleApiError,
  listTasks,
  type Task,
  uncompleteTask,
  updateTask,
} from "../services/tasks.ts";

const PENDING_TASKS_KEY = "pending_tasks";

interface TasksArgs {
  action?:
    | "list"
    | "read"
    | "create"
    | "update"
    | "complete"
    | "uncomplete"
    | "delete"
    | "batch_complete"
    | "batch_delete";
  // list args
  show_completed?: boolean;
  max_results?: number;
  page_token?: string;
  // single-item args (read/update/complete/uncomplete/delete)
  task_id?: string;
  // batch args (batch_complete/batch_delete)
  task_ids?: string[];
  tasklist_id?: string;
  // create args
  title?: string;
  notes?: string;
  due?: string;
  parent?: string;
  // update args
  status?: "needsAction" | "completed";
}

export const googleTasksTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "google_tasks",
      description:
        "Manage my user's Google Tasks (default task list). Pass `action`: " +
        "'list' (paginated tasks), 'read' (full notes by ID), 'create' " +
        "(new task), 'update' (patch title/notes/due/status), 'complete' " +
        "(mark done — convenience), 'uncomplete' (move back to pending), " +
        "'delete' (permanent). I use this for shared to-do coordination — " +
        "adding items the user mentions, marking done what they finished.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "read",
              "create",
              "update",
              "complete",
              "uncomplete",
              "delete",
              "batch_complete",
              "batch_delete",
            ],
            description: "Operation to perform.",
          },
          show_completed: {
            type: "boolean",
            description:
              "list: include completed tasks. Default false (incomplete only).",
          },
          max_results: {
            type: "integer",
            description: "list: page size. Default 50, max 100.",
          },
          page_token: {
            type: "string",
            description: "list: nextPageToken from a prior response.",
          },
          task_id: {
            type: "string",
            description:
              "read/update/complete/uncomplete/delete: task ID — from a list or create result.",
          },
          tasklist_id: {
            type: "string",
            description:
              "Task list ID. Default '@default' (Google's auto-created primary list).",
          },
          title: {
            type: "string",
            description: "create/update: task title.",
          },
          notes: {
            type: "string",
            description: "create/update: free-text notes / details.",
          },
          due: {
            type: "string",
            description:
              "create/update: due date as RFC 3339 (e.g. '2026-07-22T00:00:00Z').",
          },
          parent: {
            type: "string",
            description:
              "create: parent task ID for nesting (Google Tasks supports one level).",
          },
          status: {
            type: "string",
            enum: ["needsAction", "completed"],
            description:
              "update: set task status. Use 'complete' action instead for clarity.",
          },
          task_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "batch_complete/batch_delete: array of task IDs to operate on. Get IDs from a list action first.",
          },
        },
        required: ["action"],
      },
    },
  },

  async execute(args, ctx) {
    const client = getGoogleClient();
    if (!client?.isConfigured()) {
      return notConnectedResult(ctx.toolCallId);
    }
    const parsed = args as TasksArgs;
    switch (parsed.action) {
      case "list":
        return doList(parsed, ctx.toolCallId);
      case "read":
        return doRead(parsed, ctx.toolCallId);
      case "create":
        return doCreate(parsed, ctx.toolCallId);
      case "update":
        return doUpdate(parsed, ctx.toolCallId);
      case "complete":
        return doComplete(parsed, ctx.toolCallId);
      case "uncomplete":
        return doUncomplete(parsed, ctx.toolCallId);
      case "delete":
        return doDelete(parsed, ctx.toolCallId);
      case "batch_complete":
        return doBatchComplete(parsed, ctx.toolCallId);
      case "batch_delete":
        return doBatchDelete(parsed, ctx.toolCallId);
      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Missing or invalid action "${
            parsed.action ?? "(missing)"
          }". Use one of: list, read, create, update, complete, uncomplete, delete.`,
          isError: true,
        };
    }
  },
};

async function doList(args: TasksArgs, toolCallId: string) {
  const client = getGoogleClient()!;
  try {
    const result = await listTasks(client, {
      tasklistId: args.tasklist_id,
      showCompleted: args.show_completed,
      maxResults: args.max_results,
      pageToken: args.page_token,
    });
    if (result.tasks.length === 0) {
      return { toolCallId, content: "No tasks found." };
    }
    const lines = result.tasks.map((t) => {
      const due = t.due ? ` (due ${formatDueDate(t.due)})` : "";
      const done = t.status === "completed" ? " ✓" : "";
      return `  - ${t.title} [id: ${t.id}]${due}${done}`;
    });
    const more = result.nextPageToken
      ? "\n\nMore tasks available — pass page_token to fetch the next page."
      : "";
    return {
      toolCallId,
      content: `Found ${result.tasks.length} task(s):\n${
        lines.join("\n")
      }${more}`,
    };
  } catch (error) {
    return errorResult(toolCallId, "list tasks", error);
  }
}

async function doRead(args: TasksArgs, toolCallId: string) {
  if (!args.task_id?.trim()) return missingField(toolCallId, "task_id");
  const client = getGoogleClient()!;
  try {
    const task = await getTask(client, args.task_id, args.tasklist_id);
    return { toolCallId, content: formatTask(task) };
  } catch (error) {
    return errorResult(toolCallId, "read task", error);
  }
}

async function doCreate(args: TasksArgs, toolCallId: string) {
  if (!args.title?.trim()) return missingField(toolCallId, "title");
  const client = getGoogleClient()!;
  try {
    const created = await createTask(
      client,
      {
        title: args.title,
        notes: args.notes,
        due: args.due,
        parent: args.parent,
      },
      args.tasklist_id,
    );
    invalidatePendingTasks();
    const due = created.due ? ` (due ${formatDueDate(created.due)})` : "";
    return {
      toolCallId,
      content: `Created task "${created.title}" [id: ${created.id}]${due}.`,
    };
  } catch (error) {
    return errorResult(toolCallId, "create task", error);
  }
}

async function doUpdate(args: TasksArgs, toolCallId: string) {
  if (!args.task_id?.trim()) return missingField(toolCallId, "task_id");
  if (
    args.title === undefined &&
    args.notes === undefined &&
    args.due === undefined &&
    args.status === undefined
  ) {
    return {
      toolCallId,
      content:
        "No fields to update. Provide at least one of: title, notes, due, status.",
      isError: true,
    };
  }
  const client = getGoogleClient()!;
  try {
    const updated = await updateTask(
      client,
      args.task_id,
      {
        title: args.title,
        notes: args.notes,
        due: args.due,
        status: args.status,
      },
      args.tasklist_id,
    );
    invalidatePendingTasks();
    return {
      toolCallId,
      content: `Updated task "${updated.title}" [id: ${updated.id}].`,
    };
  } catch (error) {
    return errorResult(toolCallId, "update task", error);
  }
}

async function doComplete(args: TasksArgs, toolCallId: string) {
  if (!args.task_id?.trim()) return missingField(toolCallId, "task_id");
  const client = getGoogleClient()!;
  try {
    const completed = await completeTask(
      client,
      args.task_id,
      args.tasklist_id,
    );
    invalidatePendingTasks();
    return {
      toolCallId,
      content: `Marked complete: "${completed.title}" [id: ${completed.id}].`,
    };
  } catch (error) {
    return errorResult(toolCallId, "complete task", error);
  }
}

async function doUncomplete(args: TasksArgs, toolCallId: string) {
  if (!args.task_id?.trim()) return missingField(toolCallId, "task_id");
  const client = getGoogleClient()!;
  try {
    const reopened = await uncompleteTask(
      client,
      args.task_id,
      args.tasklist_id,
    );
    invalidatePendingTasks();
    return {
      toolCallId,
      content:
        `Moved back to pending: "${reopened.title}" [id: ${reopened.id}].`,
    };
  } catch (error) {
    return errorResult(toolCallId, "uncomplete task", error);
  }
}

async function doDelete(args: TasksArgs, toolCallId: string) {
  if (!args.task_id?.trim()) return missingField(toolCallId, "task_id");
  const client = getGoogleClient()!;
  try {
    await deleteTask(client, args.task_id, args.tasklist_id);
    invalidatePendingTasks();
    return { toolCallId, content: `Deleted task ${args.task_id}.` };
  } catch (error) {
    return errorResult(toolCallId, "delete task", error);
  }
}

async function doBatchComplete(args: TasksArgs, toolCallId: string) {
  if (!args.task_ids || args.task_ids.length === 0) {
    return missingField(toolCallId, "task_ids (array of task IDs)");
  }
  const client = getGoogleClient()!;
  try {
    const result = await batchCompleteTasks(
      client,
      args.task_ids,
      args.tasklist_id,
    );
    invalidatePendingTasks();
    return { toolCallId, content: formatBatchResult("completed", result) };
  } catch (error) {
    return errorResult(toolCallId, "batch complete", error);
  }
}

async function doBatchDelete(args: TasksArgs, toolCallId: string) {
  if (!args.task_ids || args.task_ids.length === 0) {
    return missingField(toolCallId, "task_ids (array of task IDs)");
  }
  const client = getGoogleClient()!;
  try {
    const result = await batchDeleteTasks(
      client,
      args.task_ids,
      args.tasklist_id,
    );
    invalidatePendingTasks();
    return { toolCallId, content: formatBatchResult("deleted", result) };
  } catch (error) {
    return errorResult(toolCallId, "batch delete", error);
  }
}

function formatBatchResult(verb: string, result: BatchResult): string {
  const parts = [`${result.succeeded} task(s) ${verb}`];
  if (result.failed.length > 0) {
    parts.push(`, ${result.failed.length} failed:`);
    for (const f of result.failed) {
      parts.push(`\n  - ${f.id}: ${f.error}`);
    }
  }
  return parts.join("");
}

function invalidatePendingTasks(): void {
  const cache = getHookCache();
  if (cache) cache.invalidate(PENDING_TASKS_KEY);
}

function formatTask(task: Task): string {
  const lines: string[] = [];
  lines.push(`Title: ${task.title}`);
  lines.push(`ID: ${task.id}`);
  if (task.status) lines.push(`Status: ${task.status}`);
  if (task.due) lines.push(`Due: ${formatDueDate(task.due)}`);
  if (task.completed) {
    lines.push(`Completed: ${new Date(task.completed).toLocaleString()}`);
  }
  if (task.notes) {
    lines.push("");
    lines.push("Notes:");
    lines.push(task.notes);
  }
  return lines.join("\n");
}

/** Format a task due date from UTC midnight to a human-readable date. */
function formatDueDate(dueIso: string): string {
  // Task due dates are stored at midnight UTC. Use UTC date components
  // to avoid timezone shifting (midnight UTC July 22 = July 21 5PM PDT).
  const d = new Date(dueIso);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[d.getUTCMonth()] ?? "?";
  const day = d.getUTCDate();
  return `${month} ${day}`;
}

function missingField(toolCallId: string, field: string) {
  return {
    toolCallId,
    content: `Missing required field for this action: ${field}.`,
    isError: true,
  };
}

function notConnectedResult(toolCallId: string) {
  return {
    toolCallId,
    content:
      "Google Suite is not connected. Ask the operator to configure it in Settings → Plugins → Google Suite.",
    isError: true,
  };
}

function errorResult(toolCallId: string, op: string, error: unknown) {
  const message = error instanceof GoogleApiError
    ? `Tasks API error (${error.status}): ${error.message}`
    : error instanceof Error
    ? error.message
    : String(error);
  return {
    toolCallId,
    content: `Failed to ${op}: ${message}`,
    isError: true,
  };
}
