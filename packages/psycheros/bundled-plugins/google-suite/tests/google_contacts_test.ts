import { assertEquals, assertStringIncludes } from "@std/assert";
import { googleContactsTool } from "../src/tools/google_contacts.ts";

const fakeCtx = {
  toolCallId: "test-call-id",
  conversationId: "test-conv",
  db: {} as never,
  config: {} as never,
};

Deno.test("google_contacts returns clear error when not connected", async () => {
  const result = await googleContactsTool.execute({ action: "list" }, fakeCtx);
  assertEquals(result.isError, true);
  assertStringIncludes(result.content, "not connected");
});

Deno.test("google_contacts rejects missing action", async () => {
  const result = await googleContactsTool.execute({}, fakeCtx);
  assertEquals(result.isError, true);
});

Deno.test("google_contacts description is first-person and lists all actions", () => {
  const desc = googleContactsTool.definition.function.description;
  assertStringIncludes(desc, "I ");
  assertStringIncludes(desc, "list");
  assertStringIncludes(desc, "read");
  assertStringIncludes(desc, "create");
  assertStringIncludes(desc, "update");
  assertStringIncludes(desc, "delete");
});

Deno.test("google_contacts description warns about permanent deletion + REPLACE semantics", () => {
  const desc = googleContactsTool.definition.function.description;
  assertStringIncludes(desc, "PERMANENT");
  assertStringIncludes(desc, "REPLACE");
});

Deno.test("google_contacts parameters include action enum + per-action fields", () => {
  const params = googleContactsTool.definition.function.parameters as {
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
  assertEquals(params.properties.resource_name?.type, "string");
  assertEquals(params.properties.given_name?.type, "string");
  assertEquals(params.properties.email_addresses?.type, "array");
  assertEquals(params.properties.biography?.type, "string");
});
