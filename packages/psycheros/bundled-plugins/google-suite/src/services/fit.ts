/**
 * Google Fit API wrapper — uses the aggregate endpoint for summary data.
 *
 * Wraps https://www.googleapis.com/fitness/v1/. The Fitness API is
 * data-source/dataset-based, not simple CRUD — each metric (steps, heart
 * rate, sleep, etc.) lives under a different data source with its own
 * schema. The aggregate endpoint (`POST /users/me/dataset:aggregate`)
 * simplifies this: you request specific data types for a time range and
 * get back bucketed results.
 *
 * For v1 we surface:
 *   - Steps (com.google.step_count.delta) — sum of intVal
 *   - Heart rate (com.google.heart_rate.bpm) — avg/min/max of fpVal
 *   - Sleep (com.google.sleep.segment) — total duration from segment types
 *   - Active minutes (com.google.activity.segment) — duration excluding sedentary
 *   - Weight (com.google.weight) — latest reading
 *
 * Not all data sources may have data — depends on what trackers/apps the
 * user has connected to Google Fit. Missing data returns zero/empty, not
 * an error.
 */

import type { GoogleClient } from "../client/google-client.ts";
import { GoogleApiError } from "./calendar.ts";

export { GoogleApiError };

const FIT_API_BASE = "https://www.googleapis.com/fitness/v1";

// --- Data source IDs (derived = Google-computed, not raw sensor) ---
const STEP_SOURCE =
  "derived:com.google.step_count.delta:com.google.android.gms:estimated_steps";
const HEART_RATE_SOURCE =
  "derived:com.google.heart_rate.bpm:com.google.android.gms:merged";
const SLEEP_SOURCE =
  "derived:com.google.sleep.segment:com.google.android.gms:merged";
const ACTIVITY_SOURCE =
  "derived:com.google.activity.segment:com.google.android.gms:merged";
const WEIGHT_SOURCE = "derived:com.google.weight:com.google.android.gms:merged";

// Sleep segment types (from Google's activity types):
// 1=awake, 2=sleep, 3=out-of-bed, 4=light, 5=deep, 6=rem
const SLEEP_SEGMENT_TYPES = [2, 4, 5, 6];

export interface StepsSummary {
  totalSteps: number;
}

export interface HeartRateSummary {
  avgBpm: number;
  minBpm: number;
  maxBpm: number;
  /** Number of readings in the range. */
  readings: number;
}

export interface SleepSummary {
  /** Total sleep duration in minutes (excludes awake segments). */
  totalMinutes: number;
  /** Deep sleep duration in minutes. */
  deepMinutes: number;
  /** REM sleep duration in minutes. */
  remMinutes: number;
}

export interface ActivitySummary {
  /** Active (non-sedentary) minutes. */
  activeMinutes: number;
  /** Activity breakdown by type name. */
  activities: Array<{ type: number; name: string; minutes: number }>;
}

export interface WeightSummary {
  weightKg: number;
  timestamp: string;
}

export interface FitnessSnapshot {
  steps?: StepsSummary;
  heartRate?: HeartRateSummary;
  sleep?: SleepSummary;
  activeMinutes?: ActivitySummary;
  weight?: WeightSummary;
}

// --- Aggregate API ---

interface AggregateRequest {
  aggregateBy: Array<{ dataTypeName: string; dataSourceId?: string }>;
  bucketByTime: { durationMillis: number };
  startTimeMillis: number;
  endTimeMillis: number;
}

interface AggregateResponse {
  bucket?: Array<{
    dataset?: Array<{
      point?: Array<{
        value?: Array<{ intVal?: number; fpVal?: number; mapVal?: unknown[] }>;
        startTimeNanos?: string;
        endTimeNanos?: string;
        dataTypeName?: string;
      }>;
    }>;
  }>;
}

async function aggregate(
  client: GoogleClient,
  dataTypeName: string,
  dataSourceId: string,
  startMs: number,
  endMs: number,
): Promise<AggregateResponse> {
  const body: AggregateRequest = {
    aggregateBy: [{ dataTypeName, dataSourceId }],
    bucketByTime: { durationMillis: endMs - startMs },
    startTimeMillis: startMs,
    endTimeMillis: endMs,
  };
  return await client.fetchJson<AggregateResponse>(
    `${FIT_API_BASE}/users/me/dataset:aggregate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/** Sum all intVal from all points across all buckets. */
function sumIntValues(resp: AggregateResponse): number {
  let total = 0;
  for (const bucket of resp.bucket ?? []) {
    for (const ds of bucket.dataset ?? []) {
      for (const point of ds.point ?? []) {
        for (const v of point.value ?? []) {
          if (v.intVal !== undefined) total += v.intVal;
        }
      }
    }
  }
  return total;
}

/** Collect all fpVal readings from all points. */
function collectFpValues(resp: AggregateResponse): number[] {
  const values: number[] = [];
  for (const bucket of resp.bucket ?? []) {
    for (const ds of bucket.dataset ?? []) {
      for (const point of ds.point ?? []) {
        for (const v of point.value ?? []) {
          if (v.fpVal !== undefined) values.push(v.fpVal);
        }
      }
    }
  }
  return values;
}

// --- Typed API functions ---

export async function getSteps(
  client: GoogleClient,
  startMs: number,
  endMs: number,
): Promise<StepsSummary> {
  try {
    const resp = await aggregate(
      client,
      "com.google.step_count.delta",
      STEP_SOURCE,
      startMs,
      endMs,
    );
    return { totalSteps: sumIntValues(resp) };
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 403) {
      return { totalSteps: 0 }; // scope not granted or no data
    }
    throw error;
  }
}

export async function getHeartRate(
  client: GoogleClient,
  startMs: number,
  endMs: number,
): Promise<HeartRateSummary> {
  try {
    const resp = await aggregate(
      client,
      "com.google.heart_rate.bpm",
      HEART_RATE_SOURCE,
      startMs,
      endMs,
    );
    const values = collectFpValues(resp);
    if (values.length === 0) {
      return { avgBpm: 0, minBpm: 0, maxBpm: 0, readings: 0 };
    }
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      avgBpm: Math.round(sum / values.length),
      minBpm: Math.round(Math.min(...values)),
      maxBpm: Math.round(Math.max(...values)),
      readings: values.length,
    };
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 403) {
      return { avgBpm: 0, minBpm: 0, maxBpm: 0, readings: 0 };
    }
    throw error;
  }
}

export async function getSleep(
  client: GoogleClient,
  startMs: number,
  endMs: number,
): Promise<SleepSummary> {
  try {
    const resp = await aggregate(
      client,
      "com.google.sleep.segment",
      SLEEP_SOURCE,
      startMs,
      endMs,
    );
    let totalMin = 0, deepMin = 0, remMin = 0;
    for (const bucket of resp.bucket ?? []) {
      for (const ds of bucket.dataset ?? []) {
        for (const point of ds.point ?? []) {
          const start = point.startTimeNanos
            ? Number(point.startTimeNanos) / 1e6
            : 0;
          const end = point.endTimeNanos ? Number(point.endTimeNanos) / 1e6 : 0;
          const durationMin = (end - start) / (1000 * 60);
          // The value's intVal indicates the sleep stage type (1-6).
          const stageType = point.value?.[0]?.intVal;
          if (
            stageType !== undefined && SLEEP_SEGMENT_TYPES.includes(stageType)
          ) {
            totalMin += durationMin;
            if (stageType === 5) deepMin += durationMin;
            if (stageType === 6) remMin += durationMin;
          }
        }
      }
    }
    return {
      totalMinutes: Math.round(totalMin),
      deepMinutes: Math.round(deepMin),
      remMinutes: Math.round(remMin),
    };
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 403) {
      return { totalMinutes: 0, deepMinutes: 0, remMinutes: 0 };
    }
    throw error;
  }
}

export async function getActivities(
  client: GoogleClient,
  startMs: number,
  endMs: number,
): Promise<ActivitySummary> {
  try {
    const resp = await aggregate(
      client,
      "com.google.activity.segment",
      ACTIVITY_SOURCE,
      startMs,
      endMs,
    );
    const byType = new Map<number, number>();
    for (const bucket of resp.bucket ?? []) {
      for (const ds of bucket.dataset ?? []) {
        for (const point of ds.point ?? []) {
          const start = point.startTimeNanos
            ? Number(point.startTimeNanos) / 1e6
            : 0;
          const end = point.endTimeNanos ? Number(point.endTimeNanos) / 1e6 : 0;
          const durationMin = (end - start) / (1000 * 60);
          const actType = point.value?.[0]?.intVal;
          if (actType !== undefined && actType !== 0 && actType !== 3) {
            // 0 = in vehicle, 3 = still (sedentary) — skip both
            byType.set(actType, (byType.get(actType) ?? 0) + durationMin);
          }
        }
      }
    }
    const activities = Array.from(byType.entries())
      .map(([type, minutes]) => ({
        type,
        name: activityTypeName(type),
        minutes: Math.round(minutes),
      }))
      .sort((a, b) => b.minutes - a.minutes);
    const activeMin = activities.reduce((sum, a) => sum + a.minutes, 0);
    return { activeMinutes: Math.round(activeMin), activities };
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 403) {
      return { activeMinutes: 0, activities: [] };
    }
    throw error;
  }
}

export async function getWeight(
  client: GoogleClient,
  _startMs: number,
  endMs: number,
): Promise<WeightSummary | undefined> {
  try {
    // Query last 30 days for the latest reading.
    const startMs = endMs - 30 * 24 * 60 * 60 * 1000;
    const resp = await aggregate(
      client,
      "com.google.weight",
      WEIGHT_SOURCE,
      startMs,
      endMs,
    );
    let latest: { kg: number; ts: number } | undefined;
    for (const bucket of resp.bucket ?? []) {
      for (const ds of bucket.dataset ?? []) {
        for (const point of ds.point ?? []) {
          const fp = point.value?.[0]?.fpVal;
          if (fp !== undefined) {
            const ts = point.endTimeNanos
              ? Number(point.endTimeNanos) / 1e6
              : 0;
            if (!latest || ts > latest.ts) {
              latest = { kg: fp, ts };
            }
          }
        }
      }
    }
    if (!latest) return undefined;
    return {
      weightKg: latest.kg,
      timestamp: new Date(latest.ts).toISOString(),
    };
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 403) {
      return undefined;
    }
    throw error;
  }
}

/** Map Google activity type IDs to human names (common types only). */
function activityTypeName(typeId: number): string {
  const names: Record<number, string> = {
    1: "biking",
    7: "walking",
    8: "running",
    9: "running (treadmill)",
    10: "strength training",
    11: "yoga",
    12: "hiking",
    13: "dancing",
    14: "elliptical",
    15: "rowing",
    16: "pilates",
    17: "stairs",
    18: "basketball",
    19: "soccer",
    20: "tennis",
    21: "volleyball",
    22: "skiing",
    23: "snowboarding",
    24: "golf",
    25: "martial arts",
    26: "swimming",
    35: "gardening",
    43: "kayaking",
    44: "climbing",
    45: "surfing",
    46: "paddleboarding",
  };
  return names[typeId] ?? `activity_${typeId}`;
}
