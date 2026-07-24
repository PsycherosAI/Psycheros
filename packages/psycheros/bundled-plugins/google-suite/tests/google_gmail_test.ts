import { assertEquals, assertStringIncludes } from "@std/assert";
import { googleGmailTool } from "../src/tools/google_gmail.ts";

const fakeCtx = {
  toolCallId: "test-call-id",
  conversationId: "test-conv",
  db: {} as never,
  config: {} as never,
};

Deno.test("google_gmail returns clear error when not connected", async () => {
  const result = await googleGmailTool.execute({ action: "list" }, fakeCtx);
  assertEquals(result.isError, true);
  assertStringIncludes(result.content, "not connected");
});

Deno.test("google_gmail rejects missing action", async () => {
  const result = await googleGmailTool.execute({}, fakeCtx);
  assertEquals(result.isError, true);
});

Deno.test("google_gmail description is first-person and lists all actions", () => {
  const desc = googleGmailTool.definition.function.description;
  assertStringIncludes(desc, "I ");
  assertStringIncludes(desc, "list");
  assertStringIncludes(desc, "read");
  assertStringIncludes(desc, "send");
  assertStringIncludes(desc, "modify");
  assertStringIncludes(desc, "list_labels");
});

Deno.test("google_gmail description notes no ambient inbox awareness", () => {
  const desc = googleGmailTool.definition.function.description;
  assertStringIncludes(desc, "not ambient-aware");
});

Deno.test("google_gmail parameters include action enum + per-action fields", () => {
  const params = googleGmailTool.definition.function.parameters as {
    properties: Record<string, { enum?: string[]; type?: string }>;
    required?: string[];
  };
  assertEquals(params.required, ["action"]);
  assertEquals(params.properties.action.enum, [
    "list",
    "read",
    "send",
    "modify",
    "list_labels",
  ]);
  assertEquals(params.properties.query?.type, "string");
  assertEquals(params.properties.message_id?.type, "string");
  assertEquals(params.properties.subject?.type, "string");
  assertEquals(params.properties.body?.type, "string");
  assertEquals(params.properties.add_label_ids?.type, "array");
});
