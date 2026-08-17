/**
 * Entity Skills — Context Index
 *
 * Builds the bare "My skills:" list appended to my skill tool's description
 * in the per-request tool definitions. Just the list — the description above
 * it carries the lifecycle semantics.
 */

import type { SkillMeta } from "./types.ts";

const MAX_DESCRIPTION_LENGTH = 120;

export function buildSkillsIndexBlock(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => {
    let description = skill.description;
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      description = description.slice(0, MAX_DESCRIPTION_LENGTH - 1) + "…";
    }
    return `- ${skill.name}: ${description}`;
  });
  return ["My skills:", ...lines].join("\n");
}

/**
 * Builds the "Skills I'm holding" block for my system message. Held skills
 * are part of how I'm operating, not fading context — they render here every
 * turn until I release them.
 */
export function buildHeldSkillsBlock(
  skills: Array<{ name: string; body: string }>,
): string {
  if (skills.length === 0) return "";
  const entries = skills.map((skill) =>
    `[Holding: ${skill.name}]\n${skill.body}`
  );
  return [
    "<held_skills>",
    "Skills I'm holding — these stay part of how I'm operating until I " +
    "release them with my skill tool.",
    "",
    entries.join("\n\n"),
    "</held_skills>",
  ].join("\n");
}
