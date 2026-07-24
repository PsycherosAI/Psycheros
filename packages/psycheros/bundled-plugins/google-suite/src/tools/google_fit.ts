/**
 * google_fit omni-tool — health and fitness data from Google Fit.
 *
 * Fit data comes from connected trackers/apps (Wear OS, Fitbit, Apple Health
 * via Health Connect, etc.) synced to the user's Google account. Not all
 * metrics may have data — depends on what's connected.
 *
 * Actions: get_summary (today's snapshot), get_steps, get_heart_rate,
 * get_sleep, get_weight. Each queries the Fit aggregate endpoint for a
 * time range.
 */

import type { Tool } from "../../../../src/tools/types.ts";
import { getGoogleClient } from "../plugin-state.ts";
import {
  getActivities,
  getHeartRate,
  getSleep,
  getSteps,
  getWeight,
  GoogleApiError,
} from "../services/fit.ts";

interface FitArgs {
  action?:
    | "get_summary"
    | "get_steps"
    | "get_heart_rate"
    | "get_sleep"
    | "get_weight";
  /** ISO 8601 lower bound. Default: start of today. */
  start_time?: string;
  /** ISO 8601 upper bound. Default: now. */
  end_time?: string;
}

export const googleFitTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "google_fit",
      description:
        "Read health data from my user's Google Fit account (steps, heart rate, " +
        "sleep, activity, weight). Data comes from connected fitness trackers/apps " +
        "synced to Google — not all metrics may be available. Pass `action`: " +
        "'get_summary' (today's snapshot), 'get_steps' (total in range), 'get_heart_rate' " +
        "(avg/min/max in range), 'get_sleep' (total + deep + REM), 'get_weight' (latest). " +
        "I use this when the user asks about their health metrics.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "get_summary",
              "get_steps",
              "get_heart_rate",
              "get_sleep",
              "get_weight",
            ],
            description: "Which fitness metric to retrieve.",
          },
          start_time: {
            type: "string",
            description:
              "ISO 8601 start of the time range. Default: start of today (local).",
          },
          end_time: {
            type: "string",
            description: "ISO 8601 end of the time range. Default: now.",
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
    const parsed = args as FitArgs;
    const now = new Date();
    const endMs = parsed.end_time ? Date.parse(parsed.end_time) : now.getTime();
    const startToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startMs = parsed.start_time
      ? Date.parse(parsed.start_time)
      : startToday.getTime();

    if (isNaN(endMs) || isNaN(startMs)) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Invalid time format. Use ISO 8601 (e.g. '2026-07-21T00:00:00Z').",
        isError: true,
      };
    }

    try {
      switch (parsed.action) {
        case "get_summary": {
          const [steps, hr, sleep, activities] = await Promise.all([
            getSteps(client, startMs, endMs),
            getHeartRate(client, endMs - 60 * 60 * 1000, endMs), // last hour
            getSleep(client, startMs - 12 * 60 * 60 * 1000, endMs), // last night
            getActivities(client, startMs, endMs),
          ]);
          const lines: string[] = [];
          if (steps.totalSteps > 0) {
            lines.push(`  Steps: ${steps.totalSteps.toLocaleString()}`);
          }
          if (hr.readings > 0) {
            lines.push(
              `  Heart rate (last hr): avg ${hr.avgBpm} bpm (${hr.minBpm}-${hr.maxBpm})`,
            );
          }
          if (sleep.totalMinutes > 0) {
            lines.push(
              `  Sleep: ${formatDuration(sleep.totalMinutes)} (deep ${
                formatDuration(sleep.deepMinutes)
              }, REM ${formatDuration(sleep.remMinutes)})`,
            );
          }
          if (activities.activeMinutes > 0) {
            const actList = activities.activities.slice(0, 3).map((a) =>
              `${a.name} ${a.minutes}min`
            ).join(", ");
            lines.push(
              `  Active: ${activities.activeMinutes} min (${actList})`,
            );
          }
          return {
            toolCallId: ctx.toolCallId,
            content: lines.length > 0
              ? `Fitness summary:\n${lines.join("\n")}`
              : "No fitness data available for today. Make sure a tracker is connected to your Google account.",
          };
        }
        case "get_steps": {
          const steps = await getSteps(client, startMs, endMs);
          return {
            toolCallId: ctx.toolCallId,
            content: `Steps: ${steps.totalSteps.toLocaleString()} (${
              new Date(startMs).toISOString()
            } to ${new Date(endMs).toISOString()})`,
          };
        }
        case "get_heart_rate": {
          const hr = await getHeartRate(client, startMs, endMs);
          if (hr.readings === 0) {
            return {
              toolCallId: ctx.toolCallId,
              content: "No heart rate data for this range.",
            };
          }
          return {
            toolCallId: ctx.toolCallId,
            content:
              `Heart rate: avg ${hr.avgBpm} bpm, min ${hr.minBpm}, max ${hr.maxBpm} (${hr.readings} readings)`,
          };
        }
        case "get_sleep": {
          const sleep = await getSleep(client, startMs, endMs);
          if (sleep.totalMinutes === 0) {
            return {
              toolCallId: ctx.toolCallId,
              content: "No sleep data for this range.",
            };
          }
          return {
            toolCallId: ctx.toolCallId,
            content: `Sleep: ${
              formatDuration(sleep.totalMinutes)
            } total (deep ${formatDuration(sleep.deepMinutes)}, REM ${
              formatDuration(sleep.remMinutes)
            })`,
          };
        }
        case "get_weight": {
          const weight = await getWeight(client, startMs, endMs);
          if (!weight) {
            return {
              toolCallId: ctx.toolCallId,
              content: "No weight data available.",
            };
          }
          return {
            toolCallId: ctx.toolCallId,
            content: `Weight: ${weight.weightKg} kg (recorded ${
              new Date(weight.timestamp).toLocaleDateString()
            })`,
          };
        }
        default:
          return {
            toolCallId: ctx.toolCallId,
            content:
              `Unknown action "${parsed.action}". Use: get_summary, get_steps, get_heart_rate, get_sleep, get_weight.`,
            isError: true,
          };
      }
    } catch (error) {
      return errorResult(ctx.toolCallId, error);
    }
  },
};

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function notConnectedResult(toolCallId: string) {
  return {
    toolCallId,
    content:
      "Google Suite is not connected. Ask the operator to configure it in Settings → Plugins → Google Suite.",
    isError: true,
  };
}

function errorResult(toolCallId: string, error: unknown) {
  const message = error instanceof GoogleApiError
    ? `Fit API error (${error.status}): ${error.message}`
    : error instanceof Error
    ? error.message
    : String(error);
  return {
    toolCallId,
    content: `Failed to get fitness data: ${message}`,
    isError: true,
  };
}
