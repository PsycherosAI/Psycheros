/**
 * Entity Skills — Types
 *
 * Skills are my procedural knowledge: markdown files I keep on disk and
 * load on demand via my `skill` tool instead of carrying in every context.
 */

export interface SkillMeta {
  /** Skill name — also its directory name. */
  name: string;
  /** One-line description, shown in my context index. */
  description: string;
  /** True for skills regenerated from source at startup (e.g. psycheros-handbook). */
  generated?: boolean;
}

export interface SkillReference {
  /** Filename within the skill's `references/` subdir (without `.md`). */
  name: string;
  /** Full markdown content of the reference doc. */
  content: string;
}

export interface EntitySkill extends SkillMeta {
  /** Markdown body without frontmatter — what I see when I load the skill. */
  body: string;
  /** Full SKILL.md content including frontmatter (for the editor round-trip). */
  content: string;
  /** Optional deep-dive docs, loaded one at a time via the `reference` param. */
  references: SkillReference[];
}
