/**
 * Entity Skills — Loader
 *
 * My skills live at `<dataRoot>/.psycheros/skills/<name>/SKILL.md` with an
 * optional `references/` subdir. Each SKILL.md carries simple frontmatter
 * (`name`, `description`) parsed here — a full YAML parser isn't warranted
 * for two single-line keys.
 */

import { join } from "@std/path";
import type { EntitySkill, SkillMeta, SkillReference } from "./types.ts";

/** Skill names are lowercase kebab — enforced at every name→path boundary. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function skillsDir(dataRoot: string): string {
  return join(dataRoot, ".psycheros", "skills");
}

/**
 * Parse simple frontmatter: a leading `---`-delimited block with single-line
 * `name:` / `description:` keys. Anything more complex degrades to defaults —
 * the directory name is canonical for path purposes regardless.
 */
export function parseFrontmatter(
  content: string,
): { name?: string; description?: string; generated?: boolean; body: string } {
  if (!content.startsWith("---\n")) return { body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { body: content };
  const block = content.slice(4, end);
  let name: string | undefined;
  let description: string | undefined;
  let generated: boolean | undefined;
  for (const line of block.split("\n")) {
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) name = unquote(nameMatch[1].trim());
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) description = unquote(descMatch[1].trim());
    if (/^generated:\s*true\s*$/.test(line)) generated = true;
  }
  // Body starts after the closing `---` line; strip the leading newline pair.
  const body = content.slice(end + 4).replace(/^\n+/, "");
  return { name, description, generated, body };
}

function unquote(value: string): string {
  if (
    (value.startsWith(`"`) && value.endsWith(`"`) && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Scan the skills directory. Non-fatal per entry: warn and skip bad ones. */
export async function listSkills(dataRoot: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];
  const root = skillsDir(dataRoot);
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || !SKILL_NAME_RE.test(entry.name)) continue;
      const meta = await readSkillMeta(join(root, entry.name), entry.name);
      if (meta) skills.push(meta);
    }
  } catch {
    // Directory doesn't exist yet — no skills installed.
    return [];
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkillMeta(
  dir: string,
  dirName: string,
): Promise<SkillMeta | null> {
  try {
    const content = await Deno.readTextFile(join(dir, "SKILL.md"));
    const { name, description, generated } = parseFrontmatter(content);
    return {
      name: name && SKILL_NAME_RE.test(name) ? name : dirName,
      description: description || "(no description)",
      ...(generated ? { generated } : {}),
    };
  } catch (error) {
    console.warn(
      `[skills] skipping '${dirName}': no readable SKILL.md (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  }
}

/** Load one skill in full — body plus its references. Null if not found. */
export async function loadSkill(
  dataRoot: string,
  name: string,
): Promise<EntitySkill | null> {
  if (!SKILL_NAME_RE.test(name)) return null;
  const dir = join(skillsDir(dataRoot), name);
  let content: string;
  try {
    content = await Deno.readTextFile(join(dir, "SKILL.md"));
  } catch {
    return null;
  }
  const { name: fmName, description, generated, body } = parseFrontmatter(
    content,
  );
  return {
    name: fmName && SKILL_NAME_RE.test(fmName) ? fmName : name,
    description: description || "(no description)",
    ...(generated ? { generated } : {}),
    body,
    content,
    references: await loadReferences(dir),
  };
}

async function loadReferences(dir: string): Promise<SkillReference[]> {
  const references: SkillReference[] = [];
  const refsDir = join(dir, "references");
  try {
    for await (const entry of Deno.readDir(refsDir)) {
      if (!entry.isFile || !entry.name.endsWith(".md")) continue;
      const refName = entry.name.slice(0, -3);
      if (!SKILL_NAME_RE.test(refName)) continue;
      references.push({
        name: refName,
        content: await Deno.readTextFile(join(refsDir, entry.name)),
      });
    }
  } catch {
    // No references/ subdir — fine.
  }
  return references.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillBundleFile {
  /** Directory name (the skill name OpenCode invokes). */
  name: string;
  /** Full SKILL.md content including frontmatter. */
  content: string;
  /** Optional deep-dive docs written to `references/`. */
  references?: SkillReference[];
}

/**
 * Load multiple skills as bundling-ready files. Unknown names are reported
 * in `missing` rather than failing the whole call.
 */
export async function loadSkillFiles(
  dataRoot: string,
  names: string[],
): Promise<{ found: SkillBundleFile[]; missing: string[] }> {
  const found: SkillBundleFile[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const skill = await loadSkill(dataRoot, name);
    if (!skill) {
      missing.push(name);
      continue;
    }
    found.push({
      name: skill.name,
      content: skill.content,
      references: skill.references,
    });
  }
  return { found, missing };
}

/** Create or update a skill from editor fields. Regenerates frontmatter. */
export async function saveSkill(
  dataRoot: string,
  skill: { name: string; description: string; body: string },
): Promise<void> {
  if (!SKILL_NAME_RE.test(skill.name)) {
    throw new Error(
      `Invalid skill name '${skill.name}' — lowercase letters, digits, and hyphens only.`,
    );
  }
  const dir = join(skillsDir(dataRoot), skill.name);
  await Deno.mkdir(dir, { recursive: true });
  const content = `---\nname: ${skill.name}\ndescription: ${
    skill.description.replace(/\n/g, " ")
  }\n---\n\n${skill.body}\n`;
  await Deno.writeTextFile(join(dir, "SKILL.md"), content);
}

/** Delete a skill directory (SKILL.md + references). */
export async function deleteSkill(
  dataRoot: string,
  name: string,
): Promise<void> {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name '${name}'.`);
  }
  await Deno.remove(join(skillsDir(dataRoot), name), { recursive: true });
}

/** Write one reference doc into an existing skill's `references/` subdir. */
export async function saveSkillReference(
  dataRoot: string,
  name: string,
  reference: string,
  content: string,
): Promise<void> {
  if (!SKILL_NAME_RE.test(name) || !SKILL_NAME_RE.test(reference)) {
    throw new Error("Invalid skill or reference name.");
  }
  const refsDir = join(skillsDir(dataRoot), name, "references");
  await Deno.mkdir(refsDir, { recursive: true });
  await Deno.writeTextFile(join(refsDir, `${reference}.md`), content);
}
