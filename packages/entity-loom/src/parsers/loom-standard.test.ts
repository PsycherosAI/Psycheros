/**
 * Tests for the Loom Standard parser.
 *
 * Covers detection (format marker), parsing (well-formed and edge cases),
 * timestamp round-trip preservation, and the originPlatform inheritance
 * from both file-level default and per-conversation overrides.
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { LoomStandardParser } from "./loom-standard.ts";

async function writeTempFile(content: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "loom-standard-test-" });
  const path = join(dir, "export.json");
  await Deno.writeTextFile(path, content);
  return path;
}

const VALID_FILE = JSON.stringify({
  format: "loom-standard",
  version: 1,
  originPlatform: "ChatGPT",
  conversations: [
    {
      id: "conv-1",
      title: "First conversation",
      createdAt: "2024-01-15T10:30:00.000Z",
      updatedAt: "2024-01-15T11:00:00.000Z",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello!",
          createdAt: "2024-01-15T10:30:00.000Z",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Hi there!",
          createdAt: "2024-01-15T10:30:05.000Z",
          model: "gpt-4",
          reasoning: "The user greeted me.",
        },
      ],
    },
    {
      id: "conv-2",
      createdAt: "2024-02-01T09:00:00.000Z",
      updatedAt: "2024-02-01T09:30:00.000Z",
      messages: [
        {
          id: "msg-3",
          role: "user",
          content: "What's the weather?",
          createdAt: "2024-02-01T09:00:00.000Z",
        },
      ],
    },
  ],
});

Deno.test("LoomStandardParser.detect() returns true for valid format marker", async () => {
  const path = await writeTempFile(VALID_FILE);
  try {
    const parser = new LoomStandardParser();
    const result = await parser.detect(path);
    assertEquals(result, true);
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.detect() returns false for non-standard JSON", async () => {
  const path = await writeTempFile(
    JSON.stringify([{ mapping: {}, current_node: "root" }]),
  );
  try {
    const parser = new LoomStandardParser();
    const result = await parser.detect(path);
    assertEquals(result, false);
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.detect() returns false for .jsonl files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "loom-standard-test-" });
  const path = join(dir, "export.jsonl");
  await Deno.writeTextFile(
    path,
    JSON.stringify({ format: "loom-standard" }),
  );
  try {
    const parser = new LoomStandardParser();
    const result = await parser.detect(path);
    assertEquals(result, false);
  } finally {
    await Deno.remove(path).catch(() => {});
    await Deno.remove(dir).catch(() => {});
  }
});

Deno.test("LoomStandardParser.detect() handles whitespace in format marker", async () => {
  const path = await writeTempFile(
    '{ "format" :  "loom-standard" , "conversations": []}',
  );
  try {
    const parser = new LoomStandardParser();
    const result = await parser.detect(path);
    assertEquals(result, true);
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() produces correct conversations", async () => {
  const path = await writeTempFile(VALID_FILE);
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);

    assertEquals(conversations.length, 2);

    // First conversation
    const conv1 = conversations[0];
    assertEquals(conv1.id, "conv-1");
    assertEquals(conv1.platform, "loom-standard");
    assertEquals(conv1.originPlatform, "ChatGPT");
    assertEquals(conv1.title, "[ChatGPT] First conversation");
    assertEquals(conv1.messages.length, 2);

    // Message with model + reasoning
    const msg2 = conv1.messages[1];
    assertEquals(msg2.role, "assistant");
    assertEquals(msg2.model, "gpt-4");
    assertEquals(msg2.reasoning, "The user greeted me.");

    // Second conversation (no title — should get date-range fallback)
    const conv2 = conversations[1];
    assertEquals(conv2.id, "conv-2");
    assertExists(conv2.title);
    assertEquals(conv2.title.startsWith("[ChatGPT]"), true);
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() preserves timestamps exactly", async () => {
  const iso = "2024-06-15T14:30:00.000Z";
  const path = await writeTempFile(
    JSON.stringify({
      format: "loom-standard",
      originPlatform: "Test",
      conversations: [
        {
          id: "c1",
          createdAt: iso,
          updatedAt: iso,
          messages: [
            { id: "m1", role: "user", content: "hi", createdAt: iso },
          ],
        },
      ],
    }),
  );
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);
    assertEquals(conversations[0].createdAt.toISOString(), iso);
    assertEquals(conversations[0].updatedAt.toISOString(), iso);
    assertEquals(conversations[0].messages[0].createdAt.toISOString(), iso);
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() uses per-conversation originPlatform override", async () => {
  const path = await writeTempFile(
    JSON.stringify({
      format: "loom-standard",
      originPlatform: "ChatGPT",
      conversations: [
        {
          id: "c1",
          originPlatform: "Claude",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "hi",
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
        },
        {
          id: "c2",
          createdAt: "2024-01-02T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
          messages: [
            {
              id: "m2",
              role: "user",
              content: "hello",
              createdAt: "2024-01-02T00:00:00.000Z",
            },
          ],
        },
      ],
    }),
  );
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);

    // c1 overrides to Claude
    assertEquals(conversations[0].originPlatform, "Claude");
    assertEquals(conversations[0].title!.startsWith("[Claude]"), true);

    // c2 inherits the file-level default (ChatGPT)
    assertEquals(conversations[1].originPlatform, "ChatGPT");
    assertEquals(conversations[1].title!.startsWith("[ChatGPT]"), true);
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() defaults to Unknown when originPlatform missing", async () => {
  const path = await writeTempFile(
    JSON.stringify({
      format: "loom-standard",
      conversations: [
        {
          id: "c1",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "hi",
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    }),
  );
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);
    assertEquals(conversations[0].originPlatform, "Unknown");
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() filters messages with empty content", async () => {
  const path = await writeTempFile(
    JSON.stringify({
      format: "loom-standard",
      originPlatform: "Test",
      conversations: [
        {
          id: "c1",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "real message",
              createdAt: "2024-01-01T00:00:00.000Z",
            },
            {
              id: "m2",
              role: "user",
              content: "",
              createdAt: "2024-01-01T00:01:00.000Z",
            },
            {
              id: "m3",
              role: "user",
              content: "   ",
              createdAt: "2024-01-01T00:02:00.000Z",
            },
            {
              id: "m4",
              role: "assistant",
              content: "response",
              createdAt: "2024-01-01T00:03:00.000Z",
            },
          ],
        },
      ],
    }),
  );
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);
    assertEquals(conversations[0].messages.length, 2);
    assertEquals(conversations[0].messages[0].content, "real message");
    assertEquals(conversations[0].messages[1].content, "response");
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() filters messages with invalid roles", async () => {
  const path = await writeTempFile(
    JSON.stringify({
      format: "loom-standard",
      originPlatform: "Test",
      conversations: [
        {
          id: "c1",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "hi",
              createdAt: "2024-01-01T00:00:00.000Z",
            },
            {
              id: "m2",
              role: "moderator",
              content: "bad role",
              createdAt: "2024-01-01T00:01:00.000Z",
            },
            {
              id: "m3",
              role: "assistant",
              content: "ok",
              createdAt: "2024-01-01T00:02:00.000Z",
            },
          ],
        },
      ],
    }),
  );
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);
    assertEquals(conversations[0].messages.length, 2);
    assertEquals(conversations[0].messages[0].role, "user");
    assertEquals(conversations[0].messages[1].role, "assistant");
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() handles empty conversations array", async () => {
  const path = await writeTempFile(
    JSON.stringify({
      format: "loom-standard",
      originPlatform: "Test",
      conversations: [],
    }),
  );
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);
    assertEquals(conversations.length, 0);
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});

Deno.test("LoomStandardParser.parse() skips conversations with no valid messages", async () => {
  const path = await writeTempFile(
    JSON.stringify({
      format: "loom-standard",
      originPlatform: "Test",
      conversations: [
        {
          id: "empty",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          messages: [],
        },
        {
          id: "all-filtered",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "",
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
        },
        {
          id: "valid",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          messages: [
            {
              id: "m2",
              role: "user",
              content: "hello",
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    }),
  );
  try {
    const parser = new LoomStandardParser();
    const conversations = await parser.parse(path);
    assertEquals(conversations.length, 1);
    assertEquals(conversations[0].id, "valid");
  } finally {
    await Deno.remove(join(path, "..", "export.json")).catch(() => {});
    await Deno.remove(join(path, "..")).catch(() => {});
  }
});
