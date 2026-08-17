/**
 * Held skills tests.
 *
 * Covers the hold/release lifecycle: DB roundtrip (ordering, idempotency,
 * conversation cascade), the "Skills I'm holding" block format, its position
 * in the system message (after situational awareness — the positional-param
 * trap guard), and the skill tool's hold/release paths.
 */

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeSchema } from "../src/db/schema.ts";
import { DBClient } from "../src/db/client.ts";
import {
  buildHeldSkillsBlock,
  buildSkillsIndexBlock,
  saveSkill,
  saveSkillReference,
} from "../src/skills/mod.ts";
import { buildSystemMessage } from "../src/entity/context.ts";
import { skillTool } from "../src/tools/skill.ts";
import type { ToolContext } from "../src/tools/types.ts";

function makeDb(): { client: DBClient; cleanup: () => void } {
  const path = Deno.makeTempFileSync({
    prefix: "psycheros-held-skills-test-",
    suffix: ".db",
  });
  const raw = new Database(path);
  initializeSchema(raw);
  raw.close();
  const client = new DBClient(path);
  const cleanup = () => {
    client.close();
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  };
  return { client, cleanup };
}

function makeDataRoot(): { dataRoot: string; cleanup: () => void } {
  const dataRoot = Deno.makeTempDirSync({
    prefix: "psycheros-held-skills-data-",
  });
  return {
    dataRoot,
    cleanup: () => Deno.removeSync(dataRoot, { recursive: true }),
  };
}

function makeToolContext(
  client: DBClient,
  conversationId: string,
  dataRoot: string,
): ToolContext {
  return {
    toolCallId: "test-call",
    conversationId,
    db: client,
    config: { projectRoot: dataRoot, dataRoot },
  };
}

Deno.test("held skills DB: hold, list, release roundtrip", () => {
  const { client, cleanup } = makeDb();
  const conv = client.createConversation("test");

  client.holdSkill(conv.id, "journal-writing");
  client.holdSkill(conv.id, "crisis-support");

  // Stagger held_at so the ASC ordering assertion is deterministic even when
  // both holds land in the same millisecond.
  client.getRawDb().exec(
    `UPDATE held_skills SET held_at = '2026-01-01T00:00:01.000Z'
     WHERE skill_name = 'journal-writing'`,
  );
  client.getRawDb().exec(
    `UPDATE held_skills SET held_at = '2026-01-01T00:00:02.000Z'
     WHERE skill_name = 'crisis-support'`,
  );

  assertEquals(client.getHeldSkills(conv.id), [
    "journal-writing",
    "crisis-support",
  ]);

  assertEquals(client.releaseSkill(conv.id, "journal-writing"), true);
  assertEquals(client.getHeldSkills(conv.id), ["crisis-support"]);
  assertEquals(client.releaseSkill(conv.id, "journal-writing"), false);

  cleanup();
});

Deno.test("held skills DB: re-hold is idempotent", () => {
  const { client, cleanup } = makeDb();
  const conv = client.createConversation("test");

  client.holdSkill(conv.id, "journal-writing");
  client.getRawDb().exec(
    `UPDATE held_skills SET held_at = '2026-01-01T00:00:01.000Z'`,
  );
  client.holdSkill(conv.id, "journal-writing");

  assertEquals(client.getHeldSkills(conv.id), ["journal-writing"]);

  cleanup();
});

Deno.test("held skills DB: cascade on conversation delete", () => {
  const { client, cleanup } = makeDb();
  const conv = client.createConversation("test");

  client.holdSkill(conv.id, "journal-writing");
  assertEquals(client.getHeldSkills(conv.id).length, 1);

  client.deleteConversation(conv.id);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
});

Deno.test("held skills DB: per-conversation isolation", () => {
  const { client, cleanup } = makeDb();
  const convA = client.createConversation("a");
  const convB = client.createConversation("b");

  client.holdSkill(convA.id, "journal-writing");
  assertEquals(client.getHeldSkills(convB.id), []);

  cleanup();
});

Deno.test("buildHeldSkillsBlock: XML-wrapped with header and entries", () => {
  const block = buildHeldSkillsBlock([
    { name: "crisis-support", body: "Stay calm and present." },
    { name: "journal-writing", body: "Write the entry." },
  ]);

  assertEquals(block.startsWith("<held_skills>"), true);
  assertEquals(block.endsWith("</held_skills>"), true);
  assertEquals(
    block.includes(
      "Skills I'm holding — these stay part of how I'm operating until I " +
        "release them with my skill tool.",
    ),
    true,
  );
  assertEquals(block.includes("[Holding: crisis-support]"), true);
  assertEquals(block.includes("Stay calm and present."), true);
  assertEquals(block.includes("[Holding: journal-writing]"), true);
  // Release pointer, not full tool-call syntax — the tool is already in context
  assertEquals(block.includes("skill({"), false);
});

Deno.test("buildHeldSkillsBlock: empty input yields empty string", () => {
  assertEquals(buildHeldSkillsBlock([]), "");
});

Deno.test("buildSkillsIndexBlock: bare list for the tool description", () => {
  const block = buildSkillsIndexBlock([
    { name: "crisis-support", description: "support playbook" },
  ]);
  assertEquals(block, "My skills:\n- crisis-support: support playbook");
});

Deno.test("buildSystemMessage: held skills render after situational awareness", () => {
  const systemMessage = buildSystemMessage(
    "base",
    "self",
    "user",
    "relationship",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "<situational_awareness>now</situational_awareness>",
    undefined,
    undefined,
    "<held_skills>held block</held_skills>",
  );

  const saIndex = systemMessage.indexOf("<situational_awareness>");
  const heldIndex = systemMessage.indexOf("<held_skills>");
  assertEquals(saIndex > -1, true);
  assertEquals(heldIndex > saIndex, true);
});

Deno.test("skill tool: loading a skill holds it — confirmation, no fade, with region", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute({ name: "crisis-support" }, ctx);

  assertEquals(result.isError, undefined);
  assertEquals(result.content.includes("Holding 'crisis-support'"), true);
  assertEquals(result.metadata?.fade, undefined);
  assertEquals(result.affectedRegions, ["held-skills"]);
  assertEquals(client.getHeldSkills(conv.id), ["crisis-support"]);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: loading an already-held skill stays idempotent", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  await skillTool.execute({ name: "crisis-support" }, ctx);
  await skillTool.execute({ name: "crisis-support" }, ctx);

  assertEquals(client.getHeldSkills(conv.id), ["crisis-support"]);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: release removes hold and reports region", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  await skillTool.execute({ name: "crisis-support" }, ctx);
  const result = await skillTool.execute(
    { name: "crisis-support", release: true },
    ctx,
  );

  assertEquals(result.isError, undefined);
  assertEquals(result.content.includes("Released 'crisis-support'"), true);
  assertEquals(result.affectedRegions, ["held-skills"]);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: release works even after the skill file is deleted", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  await skillTool.execute({ name: "crisis-support" }, ctx);
  Deno.removeSync(`${dataRoot}/.psycheros/skills/crisis-support`, {
    recursive: true,
  });

  const result = await skillTool.execute(
    { name: "crisis-support", release: true },
    ctx,
  );
  assertEquals(result.isError, undefined);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: release of a non-held skill is a note, not an error", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute(
    { name: "crisis-support", release: true },
    ctx,
  );

  assertEquals(result.isError, undefined);
  assertEquals(result.affectedRegions, undefined);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: releasing a reference is refused", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute(
    { name: "crisis-support", reference: "taxonomy", release: true },
    ctx,
  );
  assertEquals(result.isError, true);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: authoring cannot combine with release", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute(
    { name: "crisis-support", body: "text", release: true },
    ctx,
  );
  assertEquals(result.isError, true);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: load of a missing skill errors without holding", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute({ name: "no-such-skill" }, ctx);
  assertEquals(result.isError, true);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: batch load holds several skills in one call", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  await saveSkill(dataRoot, {
    name: "journal-writing",
    description: "journal procedure",
    body: "Write the entry.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute(
    { name: ["crisis-support", "journal-writing"] },
    ctx,
  );

  assertEquals(result.isError, undefined);
  assertEquals(
    result.content.includes("Holding: crisis-support, journal-writing"),
    true,
  );
  assertEquals(result.affectedRegions, ["held-skills"]);
  assertEquals(client.getHeldSkills(conv.id), [
    "crisis-support",
    "journal-writing",
  ]);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: batch load reports missing skills, holds the rest", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute(
    { name: ["crisis-support", "no-such-skill"] },
    ctx,
  );

  assertEquals(result.isError, undefined);
  assertEquals(result.content.includes("Holding: crisis-support"), true);
  assertEquals(result.content.includes("No skill named: no-such-skill"), true);
  assertEquals(client.getHeldSkills(conv.id), ["crisis-support"]);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: batch load with all names missing errors", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute(
    { name: ["no-such-skill", "also-missing"] },
    ctx,
  );

  assertEquals(result.isError, true);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: batch release drops several holds in one call", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  await saveSkill(dataRoot, {
    name: "journal-writing",
    description: "journal procedure",
    body: "Write the entry.",
  });
  const ctx = makeToolContext(client, conv.id, dataRoot);

  await skillTool.execute(
    { name: ["crisis-support", "journal-writing"] },
    ctx,
  );
  const result = await skillTool.execute(
    { name: ["crisis-support", "journal-writing"], release: true },
    ctx,
  );

  assertEquals(result.isError, undefined);
  assertEquals(
    result.content.includes("Released: crisis-support, journal-writing"),
    true,
  );
  assertEquals(result.affectedRegions, ["held-skills"]);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: batches cannot author or fetch references", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const withBody = await skillTool.execute(
    { name: ["a-skill", "b-skill"], body: "text" },
    ctx,
  );
  assertEquals(withBody.isError, true);

  const withReference = await skillTool.execute(
    { name: ["a-skill", "b-skill"], reference: "taxonomy" },
    ctx,
  );
  assertEquals(withReference.isError, true);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});

Deno.test("skill tool: reference load is transient — fades, does not hold", async () => {
  const { client, cleanup } = makeDb();
  const { dataRoot, cleanup: cleanupRoot } = makeDataRoot();
  const conv = client.createConversation("test");
  await saveSkill(dataRoot, {
    name: "crisis-support",
    description: "support playbook",
    body: "Stay calm and present.",
  });
  await saveSkillReference(
    dataRoot,
    "crisis-support",
    "taxonomy",
    "Patterns of malformed timestamps.",
  );
  const ctx = makeToolContext(client, conv.id, dataRoot);

  const result = await skillTool.execute(
    { name: "crisis-support", reference: "taxonomy" },
    ctx,
  );

  assertEquals(result.isError, undefined);
  assertEquals(result.metadata?.fade?.replacementContent !== undefined, true);
  assertEquals(result.affectedRegions, undefined);
  assertEquals(client.getHeldSkills(conv.id), []);

  cleanup();
  cleanupRoot();
});
