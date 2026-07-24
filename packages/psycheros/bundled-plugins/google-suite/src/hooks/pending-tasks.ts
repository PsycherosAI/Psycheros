/**
 * pending_tasks prompt hook — injects the user's pending tasks from the
 * default Google Tasks list.
 *
 * Reads from the background-refresh cache (see HookCache in
 * src/cache/hook-cache.ts). Refresh function `refreshPendingTasks` is
 * registered with the cache manager and runs every 10 min — the hook itself
 * never hits the network.
 *
 * Filter: tasks due ≤ tomorrow OR no due date, capped at `pendingTasksCap`
 * (default 5, operator-configurable). Sorted by due date (nulls last).
 * Excludes completed + deleted + hidden.
 *
 * Cache invalidation: google_tasks mutations (create/update/complete/
 * uncomplete/delete) call cache.invalidate("pending_tasks") after API
 * success, triggering an immediate async refresh.
 *
 * Returns `undefined` (silent skip) when:
 *   - Plugin is not connected
 *   - Tasks service is disabled
 *   - Cache is empty (initial refresh hasn't completed)
 *   - There are no matching pending tasks
 */

import type { PluginPromptHook } from "../../../../src/plugins/plugin-manager.ts";
import { getConfig, getGoogleClient, getHookCache } from "../plugin-state.ts";
import { listTasks, type Task } from "../services/tasks.ts";

const PENDING_TASKS_KEY = "pending_tasks";
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/** How many tasks to fetch per refresh — generous, since the cap is applied per-hook-read. */
const FETCH_LIMIT = 25;
/** Lookahead window for the due filter (tasks due ≤ N days from now). */
const DUE_LOOKAHEAD_DAYS = 2; // today + tomorrow

export interface PendingTasksCacheEntry {
  date: string;
  tasks: Task[];
  cap: number;
}

export const pendingTasksHook: PluginPromptHook = {
  name: "pending-tasks",
  priority: 21, // just after today_schedule (20) — informational awareness
  async run(_ctx) {
    const client = getGoogleClient();
    if (!client?.isConfigured()) return undefined;

    const config = getConfig();
    if (!config?.services.tasks) return undefined;

    const cache = getHookCache();
    if (!cache) return undefined;

    const cached = cache.read<PendingTasksCacheEntry>(PENDING_TASKS_KEY);
    if (!cached) return undefined;

    // Sanity check: if cache date doesn't match local today, data is stale.
    // Silent skip rather than show yesterday's filter (which may exclude
    // today's due tasks).
    const today = new Date().toDateString();
    if (cached.date !== today) return undefined;

    if (cached.tasks.length === 0) {
      return undefined; // silent skip — no pending tasks is not news
    }

    const cap = cached.cap > 0 ? cached.cap : 5;
    const shown = cached.tasks.slice(0, cap);
    const more = cached.tasks.length > cap
      ? ` (+${
        cached.tasks.length - cap
      } more — call google_tasks action="list" to see all)`
      : "";

    const lines = shown.map((task) => {
      const due = task.due ? formatDueLabel(task.due) : "";
      return `  - ${task.title}${due}`;
    });

    return `Pending tasks (${cached.tasks.length}):\n${
      lines.join("\n")
    }${more}`;
  },
};

function formatDueLabel(dueIso: string): string {
  const due = new Date(dueIso);
  const now = new Date();
  // Google Tasks stores due dates at midnight UTC. Using local-time
  // getDate() shifts them (e.g., midnight UTC July 22 = July 21 5PM PDT).
  // Extract the UTC date for the due, compare against local today.
  const startOfDue = new Date(
    due.getUTCFullYear(),
    due.getUTCMonth(),
    due.getUTCDate(),
  );
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const dayDiff = Math.round(
    (startOfDue.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (dayDiff === 0) return " (due today)";
  if (dayDiff === 1) return " (due tomorrow)";
  if (dayDiff > 0) return ` (due in ${dayDiff} days)`;
  return ` (overdue by ${Math.abs(dayDiff)} day${
    Math.abs(dayDiff) === 1 ? "" : "s"
  })`;
}

/**
 * Background refresh function for pending_tasks. Fetches incomplete tasks
 * from the default list, filters to due ≤ lookahead OR no due date, sorts
 * by due date (nulls last), writes to cache.
 *
 * The cap is read from config at refresh time — operator changes to
 * `pendingTasksCap` take effect on next refresh, not next turn (acceptable
 * given 10 min interval).
 */
export async function refreshPendingTasks(): Promise<void> {
  const client = getGoogleClient();
  if (!client?.isConfigured()) return;

  const config = getConfig();
  if (!config?.services.tasks) return;

  const cache = getHookCache();
  if (!cache) return;

  const result = await listTasks(client, {
    showCompleted: false,
    showDeleted: false,
    showHidden: false,
    maxResults: FETCH_LIMIT,
  });

  const now = new Date();
  const lookahead = new Date(now);
  lookahead.setDate(lookahead.getDate() + DUE_LOOKAHEAD_DAYS);
  lookahead.setHours(23, 59, 59, 999);

  const filtered = result.tasks
    .filter((t) => t.status !== "completed" && !t.deleted && !t.hidden)
    .filter((t) => {
      if (!t.due) return true; // undated tasks are always relevant
      return new Date(t.due) <= lookahead;
    })
    .sort((a, b) => {
      // Tasks with due dates first (earliest first); undated tasks last.
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return new Date(a.due).getTime() - new Date(b.due).getTime();
    });

  await cache.write<PendingTasksCacheEntry>(PENDING_TASKS_KEY, {
    date: now.toDateString(),
    tasks: filtered,
    cap: config.pendingTasksCap ?? 5,
  });
}

export const PENDING_TASKS_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS;
