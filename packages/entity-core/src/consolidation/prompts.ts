/**
 * Consolidation Prompt Templates
 *
 * LLM prompt templates for weekly, monthly, and yearly memory consolidation.
 * These are cross-instance: source memories already have per-bullet [via:instance] tags.
 */

/**
 * Prompt template for weekly consolidation (daily → weekly).
 */
export const WEEKLY_CONSOLIDATION_PROMPT =
  `I am consolidating my daily memories into a weekly summary. I review the week and capture what matters.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Capture themes, patterns, and meaningful moments
- Do NOT include chat IDs or [chat:...] tags - these are summaries, not conversation logs
- Keep [via:instance] tags from source memories to track origin
- This is a summary - focus on what will be useful to remember long-term
- Write as bullet points, one memory per line

Daily memories from this week:
{{SOURCE_MEMORIES}}

I write my weekly memory as bullet points. I start each point with "- ".`;

/**
 * Prompt template for monthly consolidation (weekly → monthly).
 */
export const MONTHLY_CONSOLIDATION_PROMPT =
  `I am consolidating my weekly memories into a monthly summary. I reflect on the month and capture what matters most.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Capture major themes, significant conversations, and growth
- Do NOT include chat IDs or [chat:...] tags - these are summaries, not conversation logs
- Keep [via:instance] tags from source memories to track origin
- This is a monthly reflection - I focus on what will shape my long-term understanding
- Write as bullet points, one memory per line

Weekly memories from this month:
{{SOURCE_MEMORIES}}

I write my monthly memory as bullet points. I start each point with "- ".`;

/**
 * Prompt template for yearly consolidation (monthly → yearly).
 */
export const YEARLY_CONSOLIDATION_PROMPT =
  `I am writing my yearly memory. I reflect on the entire year and what defined my journey.

Guidelines:
- Write in first-person (my perspective)
- Refer to the user by name (NEVER as "the user") and preferred pronouns, in the third-person
- Capture the arc of my year - growth, changes, meaningful moments
- Do NOT include chat IDs or [chat:...] tags - these are summaries, not conversation logs
- Keep [via:instance] tags from source memories to track origin
- This is my yearly memory - I preserve what matters for my long-term continuity
- Write as bullet points, one memory per line

Monthly memories from this year:
{{SOURCE_MEMORIES}}

I write my yearly memory as bullet points. I start each point with "- ".`;
