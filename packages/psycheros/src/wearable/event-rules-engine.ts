/**
 * Event Rules Engine
 *
 * Evaluates incoming sensor readings against configured rules and triggers
 * Pulses when conditions match. Wired into WearableConnectionManager at
 * server startup.
 */

import type {
  EventRule,
  EventRuleCondition,
  EventRuleState,
} from "./event-rules.ts";
import {
  getDefaultRuleState,
  loadEventRules,
} from "./event-rules.ts";
import type { PulseEngine } from "../pulse/engine.ts";

export class EventRulesEngine {
  private rules: EventRule[] = [];
  private state: Map<string, EventRuleState> = new Map();
  private dataRoot: string;
  private pulseEngine: PulseEngine | null = null;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
  }

  /** Set the PulseEngine reference for triggering actions. */
  setPulseEngine(engine: PulseEngine): void {
    this.pulseEngine = engine;
  }

  /** Reload rules from disk. */
  async reload(): Promise<void> {
    const config = await loadEventRules(this.dataRoot);
    this.rules = config.rules;
    // Initialize state for any new rules
    for (const rule of this.rules) {
      if (!this.state.has(rule.id)) {
        this.state.set(rule.id, getDefaultRuleState());
      }
    }
    console.log(`[EventRules] Loaded ${this.rules.length} rule(s)`);
  }

  /** Get a copy of the current rules. */
  getRules(): EventRule[] {
    return [...this.rules];
  }

  /**
   * Evaluate a single reading against all rules.
   * Called from WearableConnectionManager after cache.ingest().
   * Stream ID matches rule.condition.streamId.
   */
  evaluate(streamId: string, value: number | string, deviceId: string): void {
    if (!this.pulseEngine) return;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.condition.streamId !== streamId) continue;

      const ruleState = this.state.get(rule.id);
      if (!ruleState) continue;

      // Check cooldown
      if (ruleState.lastFired > 0 &&
        Date.now() - ruleState.lastFired < rule.cooldownMinutes * 60000) {
        continue;
      }

      // Evaluate condition
      if (this.evaluateCondition(rule.condition, value, ruleState)) {
        ruleState.lastFired = Date.now();
        ruleState.conditionTrueSince = null;
        console.log(`[EventRules] Rule "${rule.name}" fired for device ${deviceId}`);
        try {
          this.pulseEngine.triggerPulse(rule.action.pulseId, "data_event");
        } catch (error) {
          console.error(
            `[EventRules] Failed to trigger Pulse ${rule.action.pulseId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  /**
   * Test a rule against a hypothetical value.
   * Returns whether the rule would fire (ignoring cooldown).
   */
  testRule(
    rule: EventRule,
    value: number | string,
  ): { fires: boolean; reason?: string } {
    if (!rule.enabled) {
      return { fires: false, reason: "Rule is disabled" };
    }

    const ruleState = getDefaultRuleState();
    const matches = this.evaluateCondition(rule.condition, value, ruleState);
    if (matches) {
      return { fires: true };
    }
    return { fires: false, reason: "Condition not met" };
  }

  // =========================================================================
  // Private
  // =========================================================================

  private evaluateCondition(
    condition: EventRuleCondition,
    value: number | string,
    state: EventRuleState,
  ): boolean {
    switch (condition.operator) {
      case "changes_to":
        return this.evalChangesTo(condition, value, state);
      case "goes_above":
        return this.evalThreshold(condition, value, state, "above");
      case "goes_below":
        return this.evalThreshold(condition, value, state, "below");
    }
  }

  /** Fire when value transitions TO the target. */
  private evalChangesTo(
    condition: EventRuleCondition,
    value: number | string,
    state: EventRuleState,
  ): boolean {
    const target = String(condition.value);
    const current = String(value);

    if (current !== target) {
      state.lastValue = value;
      return false;
    }

    // Value equals target — only fire if it changed from something else
    if (state.lastValue !== undefined && String(state.lastValue) !== target) {
      state.lastValue = value;
      return true;
    }

    // Same as before or first reading — no transition
    state.lastValue = value;
    return false;
  }

  /** Fire when value crosses threshold, with optional sustained tracking. */
  private evalThreshold(
    condition: EventRuleCondition,
    value: number | string,
    state: EventRuleState,
    direction: "above" | "below",
  ): boolean {
    const numValue = typeof value === "number" ? value : Number(value);
    const threshold = typeof condition.value === "number"
      ? condition.value
      : Number(condition.value);

    if (isNaN(numValue) || isNaN(threshold)) {
      state.lastValue = value;
      return false;
    }

    const conditionMet = direction === "above"
      ? numValue > threshold
      : numValue < threshold;

    if (!conditionMet) {
      // Condition broken — reset sustained timer
      state.conditionTrueSince = null;
      state.lastValue = value;
      return false;
    }

    // Condition is true
    if (condition.sustainedMinutes && condition.sustainedMinutes > 0) {
      // Sustained tracking required
      if (state.conditionTrueSince === null) {
        state.conditionTrueSince = Date.now();
        state.lastValue = value;
        return false; // Start counting
      }
      const elapsed = Date.now() - state.conditionTrueSince;
      if (elapsed < condition.sustainedMinutes * 60000) {
        state.lastValue = value;
        return false; // Not held long enough
      }
      // Held for full duration — fire
      state.conditionTrueSince = null;
      state.lastValue = value;
      return true;
    }

    // No sustained requirement — fire immediately
    state.lastValue = value;
    return true;
  }
}
