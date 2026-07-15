/**
 * Pulse Route Handlers
 *
 * HTTP route handlers for the Pulse system — CRUD API,
 * trigger endpoints, webhook receiver, and HTMX fragment routes.
 *
 * @module
 */

import type { RouteContext } from "../server/routes.ts";
import type { PulseEngine } from "./engine.ts";
import type { PulseLogFilter } from "../types.ts";
import {
  renderPulseEditor,
  renderPulseList,
  renderPulseLog,
  renderPulseSettings,
} from "./templates.ts";
import {
  getDisplayTimezone,
  localDatetimeLocalToUtcIso,
  localMonthlyToUtcCron,
  localTimeToUtcCron,
  localWeeklyToUtcCron,
} from "./timezone.ts";

// =============================================================================
// Form Translation Helpers
// =============================================================================

/**
 * Translate friendly form fields into backend-compatible values.
 * Handles: trigger_type, cron_expression, interval_seconds, run_at,
 * inactivity_threshold_seconds from the new user-friendly UI fields.
 */
function translateFormData(body: Record<string, unknown>): {
  triggerType: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  runAt: string | null;
  inactivityThresholdSeconds: number | null;
  randomIntervalMin: number | null;
  randomIntervalMax: number | null;
} {
  const triggerType = (body.triggerType as string) || "cron";

  // Scheduled mode
  if (triggerType === "scheduled") {
    const preset = (body.schedulePreset as string) || "interval";

    if (preset === "interval") {
      const amount = parseFloat(String(body.intervalAmount ?? "30"));
      const unit = (body.intervalUnit as string) || "hours";
      const minutes = unit === "hours" ? amount * 60 : amount;
      return {
        triggerType: "cron",
        cronExpression: null,
        intervalSeconds: Math.round(minutes * 60),
        runAt: null,
        inactivityThresholdSeconds: null,
        randomIntervalMin: null,
        randomIntervalMax: null,
      };
    }

    if (preset === "daily") {
      const time = (body.dailyTime as string) || "09:00";
      const [hour, min] = time.split(":").map(Number);
      const tz = getDisplayTimezone();
      let utcHour = hour, utcMin = min;
      if (tz) {
        const converted = localTimeToUtcCron(hour, min, tz);
        utcHour = converted.utcHour;
        utcMin = converted.utcMin;
      }
      return {
        triggerType: "cron",
        cronExpression: `${utcMin} ${utcHour} * * *`,
        intervalSeconds: null,
        runAt: null,
        inactivityThresholdSeconds: null,
        randomIntervalMin: null,
        randomIntervalMax: null,
      };
    }

    if (preset === "weekly") {
      const time = (body.weeklyTime as string) || "09:00";
      const day = parseInt((body.weeklyDay as string) || "1", 10);
      const [hour, min] = time.split(":").map(Number);
      const tz = getDisplayTimezone();
      let utcDay = day, utcHour = hour, utcMin = min;
      if (tz) {
        const converted = localWeeklyToUtcCron(day, hour, min, tz);
        utcDay = converted.utcDayOfWeek;
        utcHour = converted.utcHour;
        utcMin = converted.utcMin;
      }
      return {
        triggerType: "cron",
        cronExpression: `${utcMin} ${utcHour} * * ${utcDay}`,
        intervalSeconds: null,
        runAt: null,
        inactivityThresholdSeconds: null,
        randomIntervalMin: null,
        randomIntervalMax: null,
      };
    }

    if (preset === "monthly") {
      const time = (body.monthlyTime as string) || "09:00";
      const date = parseInt((body.monthlyDate as string) || "1", 10);
      const [hour, min] = time.split(":").map(Number);
      const tz = getDisplayTimezone();
      let utcDate = date, utcHour = hour, utcMin = min;
      if (tz) {
        const converted = localMonthlyToUtcCron(date, hour, min, tz);
        utcDate = converted.utcDayOfMonth;
        utcHour = converted.utcHour;
        utcMin = converted.utcMin;
      }
      return {
        triggerType: "cron",
        cronExpression: `${utcMin} ${utcHour} ${utcDate} * *`,
        intervalSeconds: null,
        runAt: null,
        inactivityThresholdSeconds: null,
        randomIntervalMin: null,
        randomIntervalMax: null,
      };
    }

    if (preset === "advanced") {
      return {
        triggerType: "cron",
        cronExpression: (body.cronExpression as string) || null,
        intervalSeconds: null,
        runAt: null,
        inactivityThresholdSeconds: null,
        randomIntervalMin: null,
        randomIntervalMax: null,
      };
    }

    // Default fallback
    return {
      triggerType: "cron",
      cronExpression: null,
      intervalSeconds: 1800,
      runAt: null,
      inactivityThresholdSeconds: null,
      randomIntervalMin: null,
      randomIntervalMax: null,
    };
  }

  // One-shot mode
  if (triggerType === "oneshot") {
    const tz = getDisplayTimezone();
    let runAt: string | null = null;
    if (body.runAt) {
      runAt = tz
        ? localDatetimeLocalToUtcIso(String(body.runAt), tz)
        : new Date(String(body.runAt)).toISOString();
    }
    return {
      triggerType: "cron",
      cronExpression: null,
      intervalSeconds: null,
      runAt,
      inactivityThresholdSeconds: null,
      randomIntervalMin: null,
      randomIntervalMax: null,
    };
  }

  // Inactivity mode
  if (triggerType === "inactivity") {
    const amount = parseFloat(String(body.inactivityAmount ?? "30"));
    const unit = (body.inactivityUnit as string) || "hours";
    const minutes = unit === "hours" ? amount * 60 : amount;
    const thresholdSeconds = Math.round(minutes * 60);
    const addRandom = body.inactivityRandom === true ||
      body.inactivityRandom === "on";

    if (addRandom) {
      // Random jitter: ±35% of the threshold for organic feel.
      // A 30min threshold fires between ~19-41min, 2hr between ~1.3-2.7hr.
      const third = Math.round(thresholdSeconds * 0.35);
      return {
        triggerType: "inactivity",
        cronExpression: null,
        intervalSeconds: null,
        runAt: null,
        inactivityThresholdSeconds: thresholdSeconds,
        randomIntervalMin: Math.max(60, thresholdSeconds - third),
        randomIntervalMax: thresholdSeconds + third,
      };
    }

    return {
      triggerType: "inactivity",
      cronExpression: null,
      intervalSeconds: null,
      runAt: null,
      inactivityThresholdSeconds: thresholdSeconds,
      randomIntervalMin: null,
      randomIntervalMax: null,
    };
  }

  // Webhook / filesystem — pass through
  return {
    triggerType,
    cronExpression: null,
    intervalSeconds: null,
    runAt: null,
    inactivityThresholdSeconds: null,
    randomIntervalMin: null,
    randomIntervalMax: null,
  };
}

// =============================================================================
// Fragment Routes (HTMX)
// =============================================================================

/**
 * Handle GET /fragments/settings/pulse — Main tabbed Pulse view.
 */
export function handlePulseFragment(ctx: RouteContext): Response {
  const pulses = ctx.db.listPulses();
  const html = renderPulseSettings(pulses, (id) => ctx.db.getPulseStats(id));
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/pulse/new — New Pulse editor.
 */
export function handlePulseNewFragment(ctx: RouteContext): Response {
  const conversations = ctx.db.listConversations();
  const html = renderPulseEditor(null, conversations);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/pulse/:id/edit — Edit Pulse editor.
 */
export function handlePulseEditFragment(
  ctx: RouteContext,
  pulseId: string,
): Response {
  const pulse = ctx.db.getPulse(pulseId);
  if (!pulse) {
    return new Response("Pulse not found", { status: 404 });
  }
  const conversations = ctx.db.listConversations();
  const html = renderPulseEditor(pulse, conversations);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/pulse/log — Execution log.
 *
 * Filter pills (Fired / Errors / Skipped) are driven by the `?show=` param —
 * a comma-separated list of category labels. Defaults to hiding `skipped`
 * ticks since inactivity pulses fire every minute and routine "below
 * threshold" skips otherwise drown the log.
 */
export function handlePulseLogFragment(ctx: RouteContext, url: URL): Response {
  const page = parseInt(url.searchParams.get("page") ?? "0");
  const activeFilters = parsePulseLogFilters(url);
  const { runs, total } = ctx.db.listPulseRuns({
    limit: 50,
    offset: page * 50,
    statuses: activeFiltersToStatuses(activeFilters),
  });
  const html = renderPulseLog(runs, total, page, activeFilters);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Parse `?show=` into a set of category labels. Unknown labels are dropped.
 *
 * - Absent param → default to fired+error (skipped hidden).
 * - Present but empty (`?show=`) → empty set (user has unchecked all pills;
 *   the table renders an empty state).
 * - Otherwise → the listed labels.
 */
function parsePulseLogFilters(url: URL): Set<PulseLogFilter> {
  if (!url.searchParams.has("show")) {
    return new Set<PulseLogFilter>(["fired", "error"]);
  }
  const raw = url.searchParams.get("show") ?? "";
  const out = new Set<PulseLogFilter>();
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed === "fired" || trimmed === "error" || trimmed === "skipped") {
      out.add(trimmed);
    }
  }
  return out;
}

/** Map filter labels to the underlying job_runs statuses they represent. */
function activeFiltersToStatuses(filters: Set<PulseLogFilter>): string[] {
  const statuses: string[] = [];
  if (filters.has("fired")) statuses.push("success");
  if (filters.has("error")) statuses.push("error", "dead");
  if (filters.has("skipped")) statuses.push("skipped");
  return statuses;
}

/**
 * Handle GET /fragments/settings/pulse/list — Prompt list partial (for HTMX reload).
 */
export function handlePulseListFragment(ctx: RouteContext): Response {
  const pulses = ctx.db.listPulses();
  const html = renderPulseList(pulses, (id) => ctx.db.getPulseStats(id));
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// =============================================================================
// CRUD API Routes
// =============================================================================

/**
 * Handle GET /api/pulses — List all pulses.
 */
export function handleListPulses(ctx: RouteContext): Response {
  const pulses = ctx.db.listPulses();
  return new Response(JSON.stringify({ pulses }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle POST /api/pulses — Create a new pulse.
 */
export async function handleCreatePulse(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;

    if (
      !(body.name as string)?.trim() || !(body.promptText as string)?.trim()
    ) {
      return new Response(
        JSON.stringify({ error: "name and promptText are required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const schedule = translateFormData(body);

    const pulse = ctx.db.createPulse({
      name: (body.name as string).trim(),
      description: (body.description as string) || null,
      promptText: (body.promptText as string).trim(),
      chatMode: (body.chatMode as "visible" | "silent") ?? "visible",
      conversationId: (body.conversationId as string) || null,
      enabled: body.enabled !== false,
      triggerType: schedule.triggerType as
        | "cron"
        | "inactivity"
        | "webhook"
        | "filesystem",
      cronExpression: schedule.cronExpression,
      intervalSeconds: schedule.intervalSeconds,
      runAt: schedule.runAt,
      inactivityThresholdSeconds: schedule.inactivityThresholdSeconds,
      randomIntervalMin: schedule.randomIntervalMin,
      randomIntervalMax: schedule.randomIntervalMax,
      chainPulseIds: (body.chainPulseIds as string[]) ?? [],
      maxChainDepth: (body.maxChainDepth as number) ?? 3,
      source: (body.source as "user" | "entity") ?? "user",
      autoDelete: (body.autoDelete as boolean) ?? false,
      filesystemWatchPath: (body.filesystemWatchPath as string) || null,
    });

    // Register triggers with the engine
    const engine =
      (ctx as RouteContext & { pulseEngine?: PulseEngine }).pulseEngine;
    if (engine && pulse.enabled) {
      engine.registerTriggers(pulse);
    }

    // Return the editor view for the new pulse
    const conversations = ctx.db.listConversations();
    const html = renderPulseEditor(pulse, conversations);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Handle GET /api/pulses/:id — Get a single pulse.
 */
export function handleGetPulse(ctx: RouteContext, pulseId: string): Response {
  const pulse = ctx.db.getPulse(pulseId);
  if (!pulse) {
    return new Response(JSON.stringify({ error: "Pulse not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ pulse }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle PUT /api/pulses/:id — Update a pulse.
 */
export async function handleUpdatePulse(
  ctx: RouteContext,
  pulseId: string,
  request: Request,
): Promise<Response> {
  const existing = ctx.db.getPulse(pulseId);
  if (!existing) {
    return new Response(JSON.stringify({ error: "Pulse not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const schedule = translateFormData(body);

    ctx.db.updatePulse(pulseId, {
      name: (body.name as string)?.trim(),
      description: (body.description as string) || null,
      promptText: (body.promptText as string)?.trim(),
      chatMode: body.chatMode as "visible" | "silent",
      conversationId: (body.conversationId as string) || null,
      enabled: body.enabled as boolean,
      triggerType: schedule.triggerType as
        | "cron"
        | "inactivity"
        | "webhook"
        | "filesystem",
      cronExpression: schedule.cronExpression,
      intervalSeconds: schedule.intervalSeconds,
      runAt: schedule.runAt,
      inactivityThresholdSeconds: schedule.inactivityThresholdSeconds,
      randomIntervalMin: schedule.randomIntervalMin,
      randomIntervalMax: schedule.randomIntervalMax,
      chainPulseIds: body.chainPulseIds as string[],
      maxChainDepth: body.maxChainDepth as number,
      autoDelete: body.autoDelete as boolean,
      filesystemWatchPath: (body.filesystemWatchPath as string) || null,
    });

    // Re-register triggers if trigger type or enabled changed
    const engine =
      (ctx as RouteContext & { pulseEngine?: PulseEngine }).pulseEngine;
    if (engine) {
      const updated = ctx.db.getPulse(pulseId);
      if (updated) {
        engine.removeTriggers(existing);
        if (updated.enabled) {
          engine.registerTriggers(updated);
        }
      }
    }

    // Return updated editor
    const updated = ctx.db.getPulse(pulseId)!;
    const conversations = ctx.db.listConversations();
    const html = renderPulseEditor(updated, conversations);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Handle DELETE /api/pulses/:id — Delete a pulse.
 */
export function handleDeletePulse(
  ctx: RouteContext,
  pulseId: string,
): Response {
  const existing = ctx.db.getPulse(pulseId);
  if (!existing) {
    return new Response(JSON.stringify({ error: "Pulse not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const engine =
    (ctx as RouteContext & { pulseEngine?: PulseEngine }).pulseEngine;
  if (engine) {
    engine.removeTriggers(existing);
  }

  ctx.db.deletePulse(pulseId);

  // Return the pulse list view
  const pulses = ctx.db.listPulses();
  const html = renderPulseSettings(pulses, (id) => ctx.db.getPulseStats(id));
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// =============================================================================
// Trigger Routes
// =============================================================================

/**
 * Handle POST /api/pulses/:id/trigger — Manual trigger.
 */
export function handleTriggerPulse(
  ctx: RouteContext,
  pulseId: string,
  _request: Request,
): Response {
  const pulse = ctx.db.getPulse(pulseId);
  if (!pulse) {
    return new Response(JSON.stringify({ error: "Pulse not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!pulse.enabled) {
    return new Response(JSON.stringify({ error: "Pulse is disabled" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const engine =
    (ctx as RouteContext & { pulseEngine?: PulseEngine }).pulseEngine;
  if (engine) {
    engine.triggerPulse(pulseId, "manual", 0, null);
  }

  return new Response(JSON.stringify({ status: "triggered", pulseId }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle POST /api/pulses/:id/stop — Abort a running Pulse.
 */
export function handleStopPulse(
  ctx: RouteContext,
  pulseId: string,
  _request: Request,
): Response {
  const engine =
    (ctx as RouteContext & { pulseEngine?: PulseEngine }).pulseEngine;
  if (!engine) {
    return new Response(
      JSON.stringify({ error: "Pulse engine not available" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const aborted = engine.abortPulse(pulseId);
  return new Response(
    JSON.stringify({ status: aborted ? "aborted" : "not_running", pulseId }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * Handle GET /api/pulses/running/:conversationId — Get running Pulse for a conversation.
 */
export function handleGetRunningPulse(
  ctx: RouteContext,
  conversationId: string,
  _request: Request,
): Response {
  const engine =
    (ctx as RouteContext & { pulseEngine?: PulseEngine }).pulseEngine;
  if (!engine) {
    return new Response(JSON.stringify({ pulseId: null }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const pulseId = engine.getRunningPulseForConversation(conversationId);
  return new Response(JSON.stringify({ pulseId }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle POST /api/webhook/pulse/:id — Webhook trigger (auth required).
 */
export function handleWebhookTrigger(
  ctx: RouteContext,
  pulseId: string,
  request: Request,
): Response {
  const pulse = ctx.db.getPulseByWebhookToken(
    // The webhook might be called by ID or token
    // Check by ID first
    request.headers.get("Authorization")?.replace("Bearer ", "") ?? "",
  );

  // Also try direct ID lookup
  const pulseById = ctx.db.getPulse(pulseId);
  const targetPulse = pulse ?? pulseById;

  if (!targetPulse || !targetPulse.enabled) {
    return new Response(
      JSON.stringify({ error: "Pulse not found or disabled" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Auth check
  if (targetPulse.webhookToken) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${targetPulse.webhookToken}`) {
      return new Response(
        JSON.stringify({ error: "Invalid or missing authorization" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  const engine =
    (ctx as RouteContext & { pulseEngine?: PulseEngine }).pulseEngine;
  if (engine) {
    const result = engine.triggerWebhook(targetPulse.id);
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(
    JSON.stringify({ status: "triggered", pulseId: targetPulse.id }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

// =============================================================================
// Execution Log API Routes
// =============================================================================

/**
 * Handle GET /api/pulses/runs — List pulse runs (paginated).
 */
export function handleListPulseRuns(ctx: RouteContext, url: URL): Response {
  const page = parseInt(url.searchParams.get("page") ?? "0");
  const pulseId = url.searchParams.get("pulseId");
  const status = url.searchParams.get("status");

  const { runs, total } = ctx.db.listPulseRuns({
    pulseId: pulseId ?? undefined,
    status: status ?? undefined,
    limit: 50,
    offset: page * 50,
  });

  return new Response(JSON.stringify({ runs, total, page }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle GET /api/pulses/:id/runs — Runs for a specific pulse.
 */
export function handleListPulseRunsForPulse(
  ctx: RouteContext,
  pulseId: string,
  url: URL,
): Response {
  const page = parseInt(url.searchParams.get("page") ?? "0");
  const { runs, total } = ctx.db.listPulseRuns({
    pulseId,
    limit: 50,
    offset: page * 50,
  });

  return new Response(JSON.stringify({ runs, total, page }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Handle GET /api/pulses/runs/:runId — Get single run details.
 */
export function handleGetPulseRun(ctx: RouteContext, runId: string): Response {
  const run = ctx.db.getPulseRun(runId);
  if (!run) {
    return new Response(JSON.stringify({ error: "Run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ run }), {
    headers: { "Content-Type": "application/json" },
  });
}
