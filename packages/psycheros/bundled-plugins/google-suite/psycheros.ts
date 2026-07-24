/**
 * google-suite bundled plugin — entrypoint.
 *
 * Phase B (current): OAuth foundation + plugin scaffold + settings UI. No
 * tools or prompt hooks yet — those land in Phase C (Calendar).
 *
 * Per-process state (`googleClient`, `config`) is initialized in `start()`
 * from persisted secrets/state. Cleared in `stop()`. Module-level vars are
 * safe because PluginManager instantiates the entrypoint once per daemon
 * lifetime.
 *
 * First-person convention (CLAUDE.md) applies to entity-facing copy —
 * tool descriptions, hook output. Settings UI copy is operator-perspective,
 * matching existing settings-page tone.
 */

import type {
  PluginPromptHook,
  PluginRoute,
  PluginSettingsContext,
  PsycherosPluginServices,
} from "../../src/plugins/plugin-manager.ts";
import type { Tool } from "../../src/tools/mod.ts";

import { loadConfig } from "./src/config.ts";
import { GoogleClient } from "./src/client/google-client.ts";
import { googleSuiteRoutes } from "./src/routes.ts";
import { renderSettingsFragment } from "./src/settings/fragment.ts";
import { googleCalendarTool } from "./src/tools/google_calendar.ts";
import { googleGmailTool } from "./src/tools/google_gmail.ts";
import { googleDriveTool } from "./src/tools/google_drive.ts";
import { googleContactsTool } from "./src/tools/google_contacts.ts";
import { googleTasksTool } from "./src/tools/google_tasks.ts";
import { googleFitTool } from "./src/tools/google_fit.ts";
import {
  refreshTodaySchedule,
  TODAY_SCHEDULE_REFRESH_INTERVAL_MS,
  todayScheduleHook,
} from "./src/hooks/today-schedule.ts";
import {
  PENDING_TASKS_REFRESH_INTERVAL_MS,
  pendingTasksHook,
  refreshPendingTasks,
} from "./src/hooks/pending-tasks.ts";
import {
  FITNESS_TODAY_REFRESH_INTERVAL_MS,
  fitnessTodayHook,
  refreshFitnessToday,
} from "./src/hooks/fitness-today.ts";
import { HookCache } from "./src/cache/hook-cache.ts";
import {
  getConfig,
  getGoogleClient,
  getHookCache,
  setHookCache,
  setPluginState,
} from "./src/plugin-state.ts";

const CLIENT_ID_KEY = "PSYCHEROS_PLUGIN_GOOGLE_SUITE_CLIENT_ID";
const CLIENT_SECRET_KEY = "PSYCHEROS_PLUGIN_GOOGLE_SUITE_CLIENT_SECRET";
const REFRESH_TOKEN_KEY = "PSYCHEROS_PLUGIN_GOOGLE_SUITE_REFRESH_TOKEN";

let servicesRef: PsycherosPluginServices | undefined;

export default {
  async start(services: PsycherosPluginServices) {
    servicesRef = services;
    const config = await loadConfig(services.statePath);
    let googleClient: GoogleClient | undefined;
    try {
      googleClient = await buildClient(services);
    } catch (error) {
      console.warn(
        `[google-suite] could not initialize Google client: ${
          error instanceof Error ? error.message : String(error)
        }. Tools/hooks will surface "not connected" until the operator configures credentials.`,
      );
    }
    setPluginState(googleClient, config);

    // Initialize the hook cache. Load from disk so we have stale-but-better-
    // than-nothing data immediately, then register periodic refresh jobs
    // and trigger an initial refresh in the background.
    const cache = new HookCache(services.statePath);
    await cache.load();
    setHookCache(cache);

    // Register hook refresh functions (only for services that are enabled
    // AND that have hooks). Service toggles control whether the periodic
    // refresh fires, matching the "service toggle controls hook" policy.
    if (config.services.calendar) {
      cache.register(
        "today_schedule",
        refreshTodaySchedule,
        TODAY_SCHEDULE_REFRESH_INTERVAL_MS,
      );
      void cache.refresh("today_schedule");
    }
    if (config.services.tasks) {
      cache.register(
        "pending_tasks",
        refreshPendingTasks,
        PENDING_TASKS_REFRESH_INTERVAL_MS,
      );
      void cache.refresh("pending_tasks");
    }
    if (config.services.fit) {
      cache.register(
        "fitness_today",
        refreshFitnessToday,
        FITNESS_TODAY_REFRESH_INTERVAL_MS,
      );
      void cache.refresh("fitness_today");
    }
  },

  async stop() {
    setPluginState(undefined, undefined);
    const cache = getHookCache();
    if (cache) await cache.stop();
    setHookCache(undefined);
    servicesRef = undefined;
  },

  /**
   * Tools register per-service based on what's enabled in config. Each
   * service has one omni-tool (google_calendar, google_gmail, etc.) with
   * an action parameter for the specific operation.
   */
  get tools(): Tool[] {
    if (!getGoogleClient()?.isConfigured()) return [];
    const services = getConfig()?.services;
    const tools: Tool[] = [];
    if (services?.calendar) tools.push(googleCalendarTool);
    if (services?.gmail) tools.push(googleGmailTool);
    if (services?.drive) tools.push(googleDriveTool);
    if (services?.contacts) tools.push(googleContactsTool);
    if (services?.tasks) tools.push(googleTasksTool);
    if (services?.fit) tools.push(googleFitTool);
    return tools;
  },

  get promptHooks(): PluginPromptHook[] {
    if (!getGoogleClient()?.isConfigured()) return [];
    const services = getConfig()?.services;
    const hooks: PluginPromptHook[] = [];
    if (services?.calendar) hooks.push(todayScheduleHook);
    if (services?.tasks) hooks.push(pendingTasksHook);
    if (services?.fit) hooks.push(fitnessTodayHook);
    return hooks;
  },

  routes: googleSuiteRoutes satisfies PluginRoute[],

  async settingsFragment(ctx: PluginSettingsContext): Promise<string> {
    return await renderSettingsFragment(ctx);
  },
};

async function buildClient(
  services: PsycherosPluginServices,
): Promise<GoogleClient | undefined> {
  const secrets = await services.readSecrets();
  const clientId = secrets[CLIENT_ID_KEY];
  const clientSecret = secrets[CLIENT_SECRET_KEY];
  const refreshToken = secrets[REFRESH_TOKEN_KEY];
  if (!clientId || !clientSecret) return undefined;
  return new GoogleClient({
    clientId,
    clientSecret,
    refreshToken,
    // Refresh-token rotation is rare for installed apps, but if Google
    // returns a new one we want to persist it via the same writeSecret
    // path as the initial OAuth flow.
    async onRefreshTokenRotated(newToken) {
      if (servicesRef) {
        await servicesRef.writeSecret(REFRESH_TOKEN_KEY, newToken);
      }
    },
  });
}
