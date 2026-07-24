import { assertEquals, assertStringIncludes } from "@std/assert";
import { googleTasksTool } from "../src/tools/google_tasks.ts";

const fakeCtx = {
  toolCallId: "test-call-id",
  conversationId: "test-conv",
  db: {} as never,
  config: {} as never,
};

Deno.test("google_tasks returns clear error when not connected", async () => {
  const result = await googleTasksTool.execute({ action: "list" }, fakeCtx);
  assertEquals(result.isError, true);
  assertStringIncludes(result.content, "not connected");
});

Deno.test("google_tasks rejects missing action", async () => {
  const result = await googleTasksTool.execute({}, fakeCtx);
  assertEquals(result.isError, true);
});

Deno.test("google_tasks description is first-person and lists all actions", () => {
  const desc = googleTasksTool.definition.function.description;
  assertStringIncludes(desc, "I ");
  assertStringIncludes(desc, "list");
  assertStringIncludes(desc, "create");
  assertStringIncludes(desc, "complete");
  assertStringIncludes(desc, "delete");
});

Deno.test("google_tasks parameters include action enum + per-action fields", () => {
  const params = googleTasksTool.definition.function.parameters as {
    properties: Record<string, { enum?: string[]; type?: string }>;
    required?: string[];
  };
  assertEquals(params.required, ["action"]);
  assertEquals(params.properties.action.enum, [
    "list",
    "read",
    "create",
    "update",
    "complete",
    "uncomplete",
    "delete",
  ]);
  assertEquals(params.properties.task_id?.type, "string");
  assertEquals(params.properties.title?.type, "string");
  assertEquals(params.properties.due?.type, "string");
  assertEquals(params.properties.tasklist_id?.type, "string");
});
