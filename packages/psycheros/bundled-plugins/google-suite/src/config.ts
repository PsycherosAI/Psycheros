/**
 * Plugin state — non-secret config that lives at
 * `<statePath>/config.json` (where `statePath` resolves to
 * `<dataRoot>/.psycheros/plugin-state/google-suite/`).
 *
 * Secrets (refresh token, client ID, client secret) live separately in
 * `<dataRoot>/.psycheros/plugin-secrets/google-suite.env` via
 * PluginManager.services.writeSecret. This file holds only user preferences
 * and metadata that aren't credentials.
 */

import { join } from "@std/path";
import type { ServiceId } from "./oauth/scopes.ts";

const CONFIG_FILENAME = "config.json";

export interface GoogleSuiteConfig {
  /** Per-service enable/disable. Calendar defaults on; others opt-in. */
  services: {
    calendar: boolean;
    gmail: boolean;
    drive: boolean;
    contacts: boolean;
    tasks: boolean;
    fit: boolean;
  };
  /** Per-metric Fit opt-in for the fitness_today hook. */
  fitMetrics: {
    steps: boolean;
    heart_rate: boolean;
    sleep: boolean;
    active_minutes: boolean;
  };
  /**
   * Label shown in the today-schedule hook output. The `{userName}` template
   * substitutes the configured user name at render time.
   */
  calendarLabel: string;
  /**
   * Cap for the pending_tasks hook (and the corresponding list cap when
   * entity explicitly lists tasks). Default 5. Operator-configurable.
   */
  pendingTasksCap: number;
  /**
   * How many days ahead the today_schedule hook shows. Default 1 (today
   * only). Set to 7 for a week-ahead view. Events are grouped by day in
   * the hook output when > 1.
   */
  calendarLookaheadDays: number;
  /** Scopes Google actually granted during the last OAuth flow. */
  grantedScopes: string[];
  /** Email of the connected Google account, for status display. */
  connectedEmail?: string;
}

export function defaultConfig(): GoogleSuiteConfig {
  return {
    services: {
      calendar: true,
      gmail: false,
      drive: false,
      contacts: false,
      tasks: false,
      fit: false,
    },
    // Fit metrics: steps + active_minutes on by default (less intimate),
    // heart_rate + sleep off (intimate — operator opts in).
    fitMetrics: {
      steps: true,
      heart_rate: false,
      sleep: false,
      active_minutes: true,
    },
    // Neutral default — doesn't assume whose calendar this is. Operator
    // overrides to whatever fits: "Sarah's calendar", "Our family schedule",
    // "Band practice times", "{userName}'s calendar" (template still
    // supported), etc.
    calendarLabel: "Today's schedule",
    pendingTasksCap: 5,
    calendarLookaheadDays: 1,
    grantedScopes: [],
  };
}

/**
 * Normalize an unknown config object (parsed from JSON) into a well-formed
 * GoogleSuiteConfig. Missing fields default; extra fields ignored. Used both
 * at load time and after save to keep the persisted shape tight.
 */
export function normalizeConfig(
  raw: Partial<GoogleSuiteConfig> | null | undefined,
): GoogleSuiteConfig {
  const defaults = defaultConfig();
  if (!raw) return defaults;
  return {
    services: {
      calendar: raw.services?.calendar ?? defaults.services.calendar,
      gmail: raw.services?.gmail ?? defaults.services.gmail,
      drive: raw.services?.drive ?? defaults.services.drive,
      contacts: raw.services?.contacts ?? defaults.services.contacts,
      tasks: raw.services?.tasks ?? defaults.services.tasks,
      fit: raw.services?.fit ?? defaults.services.fit,
    },
    fitMetrics: {
      steps: raw.fitMetrics?.steps ?? defaults.fitMetrics.steps,
      heart_rate: raw.fitMetrics?.heart_rate ?? defaults.fitMetrics.heart_rate,
      sleep: raw.fitMetrics?.sleep ?? defaults.fitMetrics.sleep,
      active_minutes: raw.fitMetrics?.active_minutes ??
        defaults.fitMetrics.active_minutes,
    },
    calendarLabel: raw.calendarLabel ?? defaults.calendarLabel,
    pendingTasksCap: raw.pendingTasksCap ?? defaults.pendingTasksCap,
    calendarLookaheadDays: raw.calendarLookaheadDays ??
      defaults.calendarLookaheadDays,
    grantedScopes: raw.grantedScopes ?? defaults.grantedScopes,
    connectedEmail: raw.connectedEmail,
  };
}

export function enabledServices(config: GoogleSuiteConfig): ServiceId[] {
  const result: ServiceId[] = [];
  if (config.services.calendar) result.push("calendar");
  if (config.services.gmail) result.push("gmail");
  if (config.services.drive) result.push("drive");
  if (config.services.contacts) result.push("contacts");
  if (config.services.tasks) result.push("tasks");
  if (config.services.fit) result.push("fit");
  return result;
}

export async function loadConfig(
  statePath: string,
): Promise<GoogleSuiteConfig> {
  try {
    const raw = await Deno.readTextFile(join(statePath, CONFIG_FILENAME));
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return defaultConfig();
    }
    throw error;
  }
}

export async function saveConfig(
  statePath: string,
  config: GoogleSuiteConfig,
): Promise<void> {
  await Deno.mkdir(statePath, { recursive: true });
  await Deno.writeTextFile(
    join(statePath, CONFIG_FILENAME),
    JSON.stringify(config, null, 2),
  );
}
