/**
 * Event Rules — Types and Persistence
 *
 * Event-driven Pulse triggering based on incoming data streams.
 * When a sensor reading matches a condition, Psycheros triggers a Pulse.
 * Rules are persisted to `.psycheros/event-rules.json`.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/** Operators for condition evaluation. */
export type EventRuleOperator = "changes_to" | "goes_above" | "goes_below";

/** A condition against a data stream value. */
export interface EventRuleCondition {
  /** Stream ID to evaluate (e.g. "hr", "sleep", "battery") */
  streamId: string;
  /** Comparison operator */
  operator: EventRuleOperator;
  /** Threshold value (number for goes_above/below, string for changes_to) */
  value: number | string;
  /** Optional: must hold this long before firing (minutes). Only for goes_above/below. */
  sustainedMinutes?: number;
}

/** The action to execute when conditions match. */
export interface EventRuleAction {
  /** ID of the Pulse to trigger */
  pulseId: string;
}

/** A complete event rule. */
export interface EventRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Single condition to evaluate */
  condition: EventRuleCondition;
  /** Action to execute on match */
  action: EventRuleAction;
  /** Minimum minutes between firings */
  cooldownMinutes: number;
  createdAt: string;
  updatedAt: string;
}

/** Persistence file for event rules. */
export interface EventRulesConfig {
  rules: EventRule[];
}

/** Runtime state per rule (in-memory only, resets on restart). */
export interface EventRuleState {
  /** Epoch ms when the rule last fired */
  lastFired: number;
  /** Epoch ms when the condition became continuously true (for sustained tracking) */
  conditionTrueSince: number | null;
  /** Previous value for change detection */
  lastValue: string | number | undefined;
}

// =============================================================================
// Defaults
// =============================================================================

export function getDefaultEventRulesConfig(): EventRulesConfig {
  return { rules: [] };
}

export function getDefaultRuleState(): EventRuleState {
  return {
    lastFired: 0,
    conditionTrueSince: null,
    lastValue: undefined,
  };
}

// =============================================================================
// Load / Save
// =============================================================================

const EVENT_RULES_FILENAME = "event-rules.json";

export async function loadEventRules(
  dataRoot: string,
): Promise<EventRulesConfig> {
  const defaults = getDefaultEventRulesConfig();
  const settingsPath = join(dataRoot, ".psycheros", EVENT_RULES_FILENAME);

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<EventRulesConfig>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export async function saveEventRules(
  dataRoot: string,
  config: EventRulesConfig,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, EVENT_RULES_FILENAME);

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(config, null, 2) + "\n",
  );
}

/** Synchronous fallback for reading rules (used in route handlers). */
export function loadEventRulesSync(dataRoot: string): EventRulesConfig {
  try {
    const text = Deno.readTextFileSync(
      join(dataRoot, ".psycheros", EVENT_RULES_FILENAME),
    );
    return { ...getDefaultEventRulesConfig(), ...JSON.parse(text) };
  } catch {
    return getDefaultEventRulesConfig();
  }
}

// =============================================================================
// Value extraction
// =============================================================================

/** Extract the comparable value from a sensor reading. */
export function extractReadingValue(
  reading: import("./types.ts").SensorReading,
): number | string | undefined {
  switch (reading.type) {
    case "sleep":
      return reading.state;
    case "hr":
      return reading.bpm;
    case "battery":
      return reading.percent;
    case "screen":
      return reading.on ? "on" : "off";
    case "accel":
      return undefined; // not practical for rules
    case "gps":
      return undefined; // not practical for simple rules
    default:
      return undefined;
  }
}
