/**
 * Consolidation Module
 *
 * Exports for memory consolidation (daily→weekly→monthly→yearly).
 */

export {
  consolidate,
  type ConsolidationResult,
  findUnconsolidatedPeriods,
  runAllConsolidations,
  runConsolidation,
} from "./consolidator.ts";

export {
  filterFilesForPeriod,
  getConsolidationDateInfo,
  getISOWeek,
  getISOWeekMonday,
  getMonthStart,
  getPreviousPeriodStart,
  getWeekStart,
  parseTargetDate,
} from "./periods.ts";

export {
  MONTHLY_CONSOLIDATION_PROMPT,
  WEEKLY_CONSOLIDATION_PROMPT,
  YEARLY_CONSOLIDATION_PROMPT,
} from "./prompts.ts";

export {
  type ConsolidationPeriod,
  ConsolidationRunner,
  type ConsolidationRunnerOptions,
  mostRecentFireAt,
} from "./runner.ts";
