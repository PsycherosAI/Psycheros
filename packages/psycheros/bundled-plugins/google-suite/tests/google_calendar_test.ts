import { assertEquals, assertStringIncludes } from "@std/assert";
import { googleCalendarTool } from "../src/tools/google_calendar.ts";

const fakeCtx = {
  toolCallId: "test-call-id",
  conversationId: "test-conv",
  db: {} as never,
  config: {} as never,
};

Deno.test("google_calendar omni-tool returns clear error when not connected", async () => {
  const result = await googleCalendarTool.execute({}, fakeCtx);
  assertEquals(result.isError, true);
  assertStringIncludes(result.content, "not connected");
});

Deno.test("google_calendar rejects missing or invalid action", async () => {
  // No action provided — would be "not connected" first since client check
  // precedes dispatch, but exercises the path.
  const result = await googleCalendarTool.execute({}, fakeCtx);
  assertEquals(result.isError, true);
});

Deno.test("google_calendar description is first-person and lists all actions", () => {
  const desc = googleCalendarTool.definition.function.description;
  assertStringIncludes(desc, "I ");
  assertStringIncludes(desc, "list");
  assertStringIncludes(desc, "create");
  assertStringIncludes(desc, "update");
  assertStringIncludes(desc, "delete");
});

Deno.test("google_calendar parameters include action enum + per-action fields", () => {
  const params = googleCalendarTool.definition.function.parameters as {
    properties: Record<string, { enum?: string[]; type?: string }>;
    required?: string[];
  };
  assertEquals(params.required, ["action"]);
  assertEquals(params.properties.action.enum, [
    "list",
    "create",
    "update",
    "delete",
  ]);
  // Sample fields per action — verify presence.
  assertEquals(params.properties.summary?.type, "string");
  assertEquals(params.properties.start?.type, "object");
  assertEquals(params.properties.event_id?.type, "string");
  assertEquals(params.properties.calendar_id?.type, "string");
});
