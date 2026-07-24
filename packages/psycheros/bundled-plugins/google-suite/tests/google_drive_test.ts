import { assertEquals, assertStringIncludes } from "@std/assert";
import { googleDriveTool } from "../src/tools/google_drive.ts";

const fakeCtx = {
  toolCallId: "test-call-id",
  conversationId: "test-conv",
  db: {} as never,
  config: {} as never,
};

Deno.test("google_drive returns clear error when not connected", async () => {
  const result = await googleDriveTool.execute({ action: "list" }, fakeCtx);
  assertEquals(result.isError, true);
  assertStringIncludes(result.content, "not connected");
});

Deno.test("google_drive rejects missing action", async () => {
  const result = await googleDriveTool.execute({}, fakeCtx);
  assertEquals(result.isError, true);
});

Deno.test("google_drive description is first-person and lists all actions", () => {
  const desc = googleDriveTool.definition.function.description;
  assertStringIncludes(desc, "I ");
  assertStringIncludes(desc, "list");
  assertStringIncludes(desc, "read");
  assertStringIncludes(desc, "create");
  assertStringIncludes(desc, "update");
  assertStringIncludes(desc, "delete");
});

Deno.test("google_drive description documents drive.file scope limitation", () => {
  const desc = googleDriveTool.definition.function.description;
  assertStringIncludes(desc, "drive.file");
  assertStringIncludes(desc, "only see files this app created");
});

Deno.test("google_drive parameters include action enum + per-action fields", () => {
  const params = googleDriveTool.definition.function.parameters as {
    properties: Record<string, { enum?: string[]; type?: string }>;
    required?: string[];
  };
  assertEquals(params.required, ["action"]);
  assertEquals(params.properties.action.enum, [
    "list",
    "read",
    "create",
    "update",
    "delete",
  ]);
  assertEquals(params.properties.query?.type, "string");
  assertEquals(params.properties.file_id?.type, "string");
  assertEquals(params.properties.name?.type, "string");
  assertEquals(params.properties.content?.type, "string");
});
