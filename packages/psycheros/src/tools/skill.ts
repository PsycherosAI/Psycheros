/**
 * Skill Tool
 *
 * I use this to load one of my skills — a procedure file I keep on disk for
 * tasks that benefit from following an established process. The skills I have
 * available are listed alongside this tool's description. Loading a skill holds
 * it active under "Skills I'm holding" in my context until I release it —
 * there is no fading; I decide when a skill's work is done. Reference docs
 * are transient lookups that fade after a few turns.
 *
 * Passing body makes this an authoring call: I write the skill (or one of its
 * reference docs) to disk, where it becomes part of my procedural memory.
 */

import {
  loadSkill,
  saveSkill,
  saveSkillReference,
  SKILL_NAME_RE,
} from "../skills/mod.ts";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

export const skillTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "skill",
      description:
        "I load one of my skills — a procedure file I keep for tasks that " +
        "benefit from an established process. My available skills are listed " +
        "below. Loading a skill by name holds it active under \"Skills I'm " +
        'holding" in my context until I release it with release: true — I ' +
        "decide when its work is done, and since held skills are never-trimmed " +
        "standing context, I don't hold them casually. I can pass a list of " +
        "names to load or release several skills in one call. The reference " +
        "parameter loads one of a skill's deep-dive docs instead — a transient " +
        "lookup that fades after a few turns. With body (and optionally " +
        "description or reference) this becomes an authoring call that saves " +
        "the skill or reference doc to disk as my procedural memory. When " +
        "practical, I mention new or changed skills to the user.",
      parameters: {
        type: "object",
        properties: {
          name: {
            description:
              'Name of the skill, exactly as listed in "My skills" below (or ' +
              "the name for a new skill when authoring). To load or release " +
              "several skills in one call, pass a list of names instead.",
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          reference: {
            type: "string",
            description:
              "Optional reference doc within the skill — loads it instead of the " +
              'skill body (e.g. "malformed-pattern-taxonomy"), or the reference ' +
              "to write when authoring with body.",
          },
          description: {
            type: "string",
            description:
              "Authoring only: one-line description shown in my context index. " +
              "Omit on update to keep the existing description.",
          },
          body: {
            type: "string",
            description:
              "Authoring only: markdown content to save. Without it this call " +
              "loads instead of writes.",
          },
          release: {
            type: "boolean",
            description:
              "Release a skill I'm holding so it stops being part of my " +
              "context. Only meaningful without body.",
          },
        },
        required: ["name"],
      },
    },
  },
  execute: executeSkill,
};

async function executeSkill(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { reference, description, body, release } = args as {
    reference?: string;
    description?: string;
    body?: string;
    release?: boolean;
  };

  // A single name or a list — batches load/release several skills in one
  // call. Authoring and reference lookups are single-skill by nature.
  const nameArg = args.name;
  const names: string[] = Array.isArray(nameArg)
    ? nameArg as string[]
    : [nameArg as string];
  if (
    names.length === 0 ||
    !names.every((n) => typeof n === "string" && SKILL_NAME_RE.test(n))
  ) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        "Error: a valid skill name (or list of names) is required (lowercase kebab-case).",
      isError: true,
    };
  }
  const name = names[0];

  if (reference && !SKILL_NAME_RE.test(reference)) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Error: invalid reference name '${reference}'.`,
      isError: true,
    };
  }
  if (names.length > 1 && body !== undefined) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: body authors one skill at a time.",
      isError: true,
    };
  }
  if (names.length > 1 && reference) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        "Error: reference applies to one skill at a time — batches load skill bodies.",
      isError: true,
    };
  }
  if (body !== undefined && release) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        "Error: body is an authoring call — it can't be combined with release.",
      isError: true,
    };
  }
  if (reference && release) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        "Error: releasing applies to the skill itself, not its references — " +
        "references are transient and fade on their own.",
      isError: true,
    };
  }

  // Release path — the DB row is the source of truth, so this works even
  // if the skill file has since been deleted.
  if (release) {
    const releasedNames: string[] = [];
    const notHeld: string[] = [];
    for (const n of names) {
      if (ctx.db.releaseSkill(ctx.conversationId, n)) {
        releasedNames.push(n);
      } else {
        notHeld.push(n);
      }
    }
    if (names.length === 1) {
      if (releasedNames.length > 0) {
        return {
          toolCallId: ctx.toolCallId,
          content: `Released '${name}' — no longer held.`,
          affectedRegions: ["held-skills"],
        };
      }
      return {
        toolCallId: ctx.toolCallId,
        content: `Not currently holding '${name}'.`,
      };
    }
    const parts: string[] = [];
    if (releasedNames.length > 0) {
      parts.push(`Released: ${releasedNames.join(", ")}.`);
    }
    if (notHeld.length > 0) {
      parts.push(`Not currently holding: ${notHeld.join(", ")}.`);
    }
    return {
      toolCallId: ctx.toolCallId,
      content: parts.join(" "),
      ...(releasedNames.length > 0 ? { affectedRegions: ["held-skills"] } : {}),
    };
  }

  const existing = await loadSkill(ctx.config.dataRoot, name);

  // Authoring path — body present means write, not load.
  if (body !== undefined) {
    if (existing?.generated) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `'${name}' is auto-generated — regenerated from source at every daemon ` +
          `startup, so anything I write to it would be overwritten. Author it ` +
          `under a new name instead.`,
        isError: true,
      };
    }
    if (reference) {
      if (!existing) {
        return {
          toolCallId: ctx.toolCallId,
          content:
            `No skill named '${name}' — create the skill itself (save a body first) ` +
            `before writing references for it.`,
          isError: true,
        };
      }
      await saveSkillReference(ctx.config.dataRoot, name, reference, body);
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Saved reference '${reference}' to skill '${name}'. It loads via skill({name:"${name}", reference:"${reference}"}).`,
      };
    }
    await saveSkill(ctx.config.dataRoot, {
      name,
      description: description?.trim() || existing?.description ||
        "(no description)",
      body,
    });
    return {
      toolCallId: ctx.toolCallId,
      content: existing
        ? `Updated skill '${name}'. It appears in my context index next turn.`
        : `Saved new skill '${name}'. It appears in my context index next turn.`,
    };
  }

  // Batch load path — several skills in one call.
  if (names.length > 1) {
    const heldNames: string[] = [];
    const missing: string[] = [];
    for (const n of names) {
      const skill = await loadSkill(ctx.config.dataRoot, n);
      if (skill) {
        ctx.db.holdSkill(ctx.conversationId, n);
        heldNames.push(n);
      } else {
        missing.push(n);
      }
    }
    if (heldNames.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `No skill named: ${
            missing.join(", ")
          }. The skills I have available ` +
          `are listed in "My skills" with my skill tool's description.`,
        isError: true,
      };
    }
    const parts = [
      `Holding: ${
        heldNames.join(", ")
      }. They're now part of my context under ` +
      `"Skills I'm holding" until I release them with my skill tool.`,
    ];
    if (missing.length > 0) {
      parts.push(`No skill named: ${missing.join(", ")}.`);
    }
    return {
      toolCallId: ctx.toolCallId,
      content: parts.join(" "),
      affectedRegions: ["held-skills"],
    };
  }

  // Load path.
  if (!existing) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `No skill named '${name}'. The skills I have available are listed in ` +
        `"My skills" with my skill tool's description.`,
      isError: true,
    };
  }

  // Reference loads are transient lookups — fade machinery applies.
  if (reference) {
    const ref = existing.references.find((r) => r.name === reference);
    if (!ref) {
      const available = existing.references.map((r) => r.name);
      return {
        toolCallId: ctx.toolCallId,
        content: `Skill '${name}' has no reference named '${reference}'.` +
          (available.length > 0
            ? ` Available references: ${available.join(", ")}.`
            : " This skill has no references."),
        isError: true,
      };
    }
    return {
      toolCallId: ctx.toolCallId,
      content: `Skill '${name}' — reference '${reference}':\n\n${ref.content}`,
      metadata: {
        fade: {
          replacementContent:
            `Skill '${name}' reference '${reference}' faded — call skill({name:"${name}", reference:"${reference}"}) to reload it.`,
        },
      },
    };
  }

  // Skill loads hold — no fade metadata: the body renders in the system
  // message's "Skills I'm holding" block each turn, not in this tool result.
  ctx.db.holdSkill(ctx.conversationId, name);
  return {
    toolCallId: ctx.toolCallId,
    content:
      `Holding '${name}'. It's now part of my context under "Skills I'm ` +
      `holding" and stays there until I release it with my skill tool.`,
    affectedRegions: ["held-skills"],
  };
}
