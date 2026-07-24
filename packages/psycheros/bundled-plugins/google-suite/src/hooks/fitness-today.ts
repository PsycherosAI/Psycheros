/**
 * fitness_today prompt hook — injects today's health metrics as plugin context.
 *
 * Per-metric opt-in: the operator picks which metrics to include (steps,
 * heart_rate, sleep, active_minutes). Default: steps + active_minutes on,
 * heart_rate + sleep off (intimate — opt-in).
 *
 * Reads from the background-refresh cache (5 min interval). The refresh
 * function fetches only enabled metrics from the Fit aggregate endpoint.
 *
 * Returns `undefined` when: not connected, Fit disabled, cache empty, or
 * all enabled metrics have zero data.
 */

import type { PluginPromptHook } from "../../../../src/plugins/plugin-manager.ts";
import { getConfig, getGoogleClient, getHookCache } from "../plugin-state.ts";
import {
  getActivities,
  getHeartRate,
  getSleep,
  getSteps,
} from "../services/fit.ts";

const FITNESS_KEY = "fitness_today";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface FitnessCacheEntry {
  date: string;
  steps?: number;
  heartRate?: { avg: number; min: number; max: number; readings: number };
  sleep?: { totalMin: number; deepMin: number; remMin: number };
  activeMinutes?: {
    total: number;
    topActivities: Array<{ name: string; minutes: number }>;
  };
}

export const fitnessTodayHook: PluginPromptHook = {
  name: "fitness-today",
  priority: 22,
  async run(_ctx) {
    const client = getGoogleClient();
    if (!client?.isConfigured()) return undefined;

    const config = getConfig();
    if (!config?.services.fit) return undefined;

    const cache = getHookCache();
    if (!cache) return undefined;

    const cached = cache.read<FitnessCacheEntry>(FITNESS_KEY);
    if (!cached) return undefined;

    const today = new Date().toDateString();
    if (cached.date !== today) return undefined;

    const lines: string[] = [];
    if (
      config.fitMetrics?.steps && cached.steps !== undefined && cached.steps > 0
    ) {
      lines.push(`  - ${cached.steps.toLocaleString()} steps`);
    }
    if (
      config.fitMetrics?.heart_rate &&
      cached.heartRate && cached.heartRate.readings > 0
    ) {
      lines.push(
        `  - Heart rate: avg ${cached.heartRate.avg} bpm (${cached.heartRate.min}-${cached.heartRate.max})`,
      );
    }
    if (
      config.fitMetrics?.sleep &&
      cached.sleep && cached.sleep.totalMin > 0
    ) {
      const h = Math.floor(cached.sleep.totalMin / 60);
      const m = cached.sleep.totalMin % 60;
      const durStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
      lines.push(
        `  - Sleep: ${durStr} (deep ${formatMin(cached.sleep.deepMin)}, REM ${
          formatMin(cached.sleep.remMin)
        })`,
      );
    }
    if (
      config.fitMetrics?.active_minutes &&
      cached.activeMinutes && cached.activeMinutes.total > 0
    ) {
      const top = cached.activeMinutes.topActivities.slice(0, 2)
        .map((a) => `${a.name} ${a.minutes}min`).join(", ");
      lines.push(`  - Active: ${cached.activeMinutes.total} min (${top})`);
    }

    if (lines.length === 0) return undefined; // all enabled metrics have no data
    return `Today's health snapshot:\n${lines.join("\n")}`;
  },
};

function formatMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export async function refreshFitnessToday(): Promise<void> {
  const client = getGoogleClient();
  if (!client?.isConfigured()) return;

  const config = getConfig();
  if (!config?.services.fit) return;

  const cache = getHookCache();
  if (!cache) return;

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    .getTime();
  const endMs = now.getTime();
  const entry: FitnessCacheEntry = { date: now.toDateString() };

  const promises: Promise<void>[] = [];

  if (config.fitMetrics?.steps) {
    promises.push(
      getSteps(client, startToday, endMs).then((s) => {
        entry.steps = s.totalSteps;
      }),
    );
  }
  if (config.fitMetrics?.heart_rate) {
    promises.push(
      getHeartRate(client, endMs - 60 * 60 * 1000, endMs).then((hr) => {
        entry.heartRate = {
          avg: hr.avgBpm,
          min: hr.minBpm,
          max: hr.maxBpm,
          readings: hr.readings,
        };
      }),
    );
  }
  if (config.fitMetrics?.sleep) {
    promises.push(
      getSleep(client, startToday - 12 * 60 * 60 * 1000, endMs).then((sl) => {
        entry.sleep = {
          totalMin: sl.totalMinutes,
          deepMin: sl.deepMinutes,
          remMin: sl.remMinutes,
        };
      }),
    );
  }
  if (config.fitMetrics?.active_minutes) {
    promises.push(
      getActivities(client, startToday, endMs).then((act) => {
        entry.activeMinutes = {
          total: act.activeMinutes,
          topActivities: act.activities.slice(0, 3),
        };
      }),
    );
  }

  await Promise.all(promises);
  await cache.write<FitnessCacheEntry>(FITNESS_KEY, entry);
}

export const FITNESS_TODAY_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS;
