# Loom Standard Import Format

## What this is

The Loom Standard Import Format is a stable JSON format for feeding conversation
histories into Entity Loom. If your chat platform isn't natively supported, or
the native parser is broken by a format change, you (or an AI coding agent like
Codex or Claude Code) can convert the platform's raw export into this format
instead. Entity Loom will ingest it directly.

**You are an AI coding agent.** Your job: read a conversation/chat export from
some platform, understand its structure, and produce a single JSON file in the
format described below. The file must pass every rule in the
[Validation Checklist](#validation-checklist) at the end of this document.

---

## File structure

The file is a JSON object with a `conversations` array. Each conversation has an
ordered `messages` array. Timestamps are ISO 8601 strings (not Unix epochs).

```json
{
  "format": "loom-standard",
  "version": 1,
  "originPlatform": "ChatGPT",
  "conversations": [
    {
      "id": "string (required)",
      "title": "string (optional)",
      "createdAt": "ISO 8601 timestamp (required)",
      "updatedAt": "ISO 8601 timestamp (required)",
      "originPlatform": "string (optional, overrides file-level default)",
      "messages": [
        {
          "id": "string (required)",
          "role": "user | assistant (required)",
          "content": "string (required, non-empty)",
          "createdAt": "ISO 8601 timestamp (required)",
          "model": "string (optional)",
          "reasoning": "string (optional)"
        }
      ]
    }
  ]
}
```

---

## Field reference

### Top-level fields

| Field            | Type   | Required | Description                                                                                                                                                                                                       |
| ---------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`         | string | **Yes**  | Must be `"loom-standard"`. This is how Entity Loom identifies the file.                                                                                                                                           |
| `version`        | number | No       | Format version. Currently `1`. If omitted, defaults to 1.                                                                                                                                                         |
| `originPlatform` | string | **Yes**  | The real platform these conversations came from (e.g., `"ChatGPT"`, `"Claude"`, `"Replika"`, `"Character.AI"`). This value appears in memory tags and conversation titles. It can be overridden per-conversation. |
| `conversations`  | array  | **Yes**  | Array of conversation objects. Can be empty.                                                                                                                                                                      |

### Conversation fields

| Field            | Type   | Required | Description                                                                                                                                                                                                   |
| ---------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string | **Yes**  | Unique, stable conversation identifier. Must be unique across all conversations in the file. Used as the primary key — the same ID on re-import triggers replace semantics, so keep it stable across exports. |
| `title`          | string | No       | Human-readable conversation title. If omitted, Entity Loom generates a fallback from the date range.                                                                                                          |
| `createdAt`      | string | **Yes**  | ISO 8601 timestamp of when the conversation started.                                                                                                                                                          |
| `updatedAt`      | string | **Yes**  | ISO 8601 timestamp of the last activity in the conversation.                                                                                                                                                  |
| `originPlatform` | string | No       | Overrides the file-level `originPlatform` for this conversation only. Use if conversations in the same file came from different platforms.                                                                    |
| `messages`       | array  | **Yes**  | Ordered array of message objects, oldest first.                                                                                                                                                               |

### Message fields

| Field       | Type   | Required | Description                                                                                                                                                                                                                 |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | string | **Yes**  | Unique within the conversation. If missing, a sequential fallback (`msg-0`, `msg-1`, ...) is generated.                                                                                                                     |
| `role`      | string | **Yes**  | Must be `"user"` or `"assistant"`. Other values (`"system"`, `"tool"`) are accepted but filtered out during database write — include them only if the source has them and you want to preserve the gap in message ordering. |
| `content`   | string | **Yes**  | The message text. Must be non-empty after trimming whitespace — empty messages are silently dropped.                                                                                                                        |
| `createdAt` | string | **Yes**  | ISO 8601 timestamp of when the message was sent.                                                                                                                                                                            |
| `model`     | string | No       | Model identifier if available (e.g., `"gpt-4"`, `"claude-3-opus"`).                                                                                                                                                         |
| `reasoning` | string | No       | Extended thinking / chain-of-thought text if the platform provides it. Goes here, NOT in `content`.                                                                                                                         |

---

## Critical rules

These are the load-bearing requirements. Getting any of them wrong will either
crash the import or silently produce broken memories.

### 1. Timestamps MUST be ISO 8601 with timezone

Every `createdAt` and `updatedAt` field must be a valid ISO 8601 string that
JavaScript's `new Date()` can parse. UTC with the `Z` suffix is preferred:

```
"2024-01-15T10:30:00.000Z"     ✓
"2024-01-15T10:30:00Z"         ✓
"2024-01-15T10:30:00-05:00"   ✓ (timezone offset)
"2024-01-15"                    ✓ (date only, midnight UTC)
```

Do NOT use:

- Unix epoch seconds: `1705312200` — convert to ISO first
- Locale-dependent formats: `"01/15/2024 10:30 AM"`
- Relative time: `"2 days ago"`

Entity Loom groups messages by date using SQL's `DATE()` function on these
timestamps. Invalid timestamps cause messages to land on the wrong day or be
invisibly lost from daily memory generation.

### 2. Messages MUST be ordered oldest-first

The `messages` array must be in chronological order with the first message at
index 0. Entity Loom preserves array order end-to-end — it does not re-sort. If
the source export has messages in reverse or random order, sort them by
timestamp before writing.

### 3. Conversation IDs MUST be stable and unique

The `id` field is the primary key. If the same ID appears twice in a file, the
second one is skipped. If a re-import has the same ID with different content,
the old conversation is replaced. Use the source platform's native conversation
ID when available — do NOT generate random IDs on each conversion or re-imports
will create duplicates instead of updating.

### 4. Message IDs MUST be unique within their conversation

If two messages in the same conversation share an ID, one will overwrite the
other. Use the source platform's message ID, or generate sequential IDs if the
source doesn't provide them.

### 5. Content MUST be non-empty

Messages with empty or whitespace-only content are silently dropped. If the
source has a message with only an image attachment (no text), replace the
content with a placeholder like `"[image was here]"` rather than leaving it
empty.

### 6. Roles must be `user` or `assistant`

Only `user` and `assistant` messages survive into the database. If the source
export has `system`, `tool`, or other role labels, you can include them (they'll
be filtered) or drop them entirely. Map the source platform's role names:

- `"human"`, `"me"`, `"customer"` → `"user"`
- `"ai"`, `"bot"`, `"model"`, `"character"` → `"assistant"`

### 7. Reasoning goes in `reasoning`, not `content`

Some platforms (Claude, ChatGPT with extended thinking) expose the model's
chain-of-thought. Put this in the `reasoning` field. The `content` field should
contain only the final response text that was shown to the user.

### 8. Set `originPlatform` to the real platform name

This value flows into memory tags (`[via:ChatGPT]`) and title prefixes
(`[ChatGPT] My conversation`). Use the platform's common name as users would
recognize it: `"ChatGPT"`, `"Claude"`, `"Replika"`, `"Character.AI"`,
`"SillyTavern"`, etc.

---

## Complete example

A minimal valid file with two conversations:

```json
{
  "format": "loom-standard",
  "version": 1,
  "originPlatform": "ChatGPT",
  "conversations": [
    {
      "id": "conv-aaa-001",
      "title": "Discussion about space travel",
      "createdAt": "2024-03-10T14:00:00.000Z",
      "updatedAt": "2024-03-10T14:45:30.000Z",
      "messages": [
        {
          "id": "msg-001",
          "role": "user",
          "content": "Do you think we'll have cities on Mars in our lifetime?",
          "createdAt": "2024-03-10T14:00:00.000Z"
        },
        {
          "id": "msg-002",
          "role": "assistant",
          "content": "I think it's possible within the next few decades, though there are enormous engineering challenges around radiation shielding, life support, and psychological effects of isolation.",
          "createdAt": "2024-03-10T14:00:45.000Z",
          "model": "gpt-4"
        },
        {
          "id": "msg-003",
          "role": "user",
          "content": "That's fascinating. What about the psychological effects specifically?",
          "createdAt": "2024-03-10T14:01:30.000Z"
        },
        {
          "id": "msg-004",
          "role": "assistant",
          "content": "Long-term isolation, distance from Earth, communication delays of up to 22 minutes each way, and the constant awareness of a hostile environment outside a thin hull...",
          "createdAt": "2024-03-10T14:02:15.000Z",
          "model": "gpt-4"
        }
      ]
    },
    {
      "id": "conv-bbb-002",
      "createdAt": "2024-03-12T09:00:00.000Z",
      "updatedAt": "2024-03-12T09:10:00.000Z",
      "messages": [
        {
          "id": "msg-005",
          "role": "user",
          "content": "Quick question — what's the capital of New Zealand?",
          "createdAt": "2024-03-12T09:00:00.000Z"
        },
        {
          "id": "msg-006",
          "role": "assistant",
          "content": "Wellington.",
          "createdAt": "2024-03-12T09:00:03.000Z"
        }
      ]
    }
  ]
}
```

Note that the second conversation has no `title` — Entity Loom will generate
`[ChatGPT] Mar 12, 2024` as a fallback.

---

## Common platform mapping patterns

### General approach

1. **Read the source export** and understand its conversation/message structure.
2. **Map each conversation** to the Loom Standard conversation shape.
3. **Map each message**: extract role, content, timestamp. Map role names to
   `user`/`assistant`.
4. **Convert timestamps** to ISO 8601 if the source uses epoch seconds, custom
   date formats, or missing timezones.
5. **Handle special content**: images → `"[image was here]"`, tool calls →
   summarize or drop, multi-part content → concatenate text parts.
6. **Write the output** as a single JSON file.

### ChatGPT exports (`conversations.json`)

ChatGPT exports use a tree structure with `mapping` and `current_node`. To
flatten:

- Walk the tree from the root, following children in order.
- Each node has `message.author.role` (`"user"`, `"assistant"`, `"tool"`,
  `"system"`).
- Content is in `message.content.parts[]` — concatenate the string parts.
- Timestamps are in `message.create_time` (Unix epoch seconds as a float) —
  convert with `new Date(create_time * 1000).toISOString()`.
- The conversation ID is the top-level `id` or `title` slug.
- Extended thinking (if present) goes in the `reasoning` field.

### Claude exports

Claude exports come in two formats — JSONL (one conversation per line) or JSON
array:

- **JSONL**: Each line has `conversation` (array of messages), `uuid`, `title`,
  `created_at`, `updated_at`.
- **JSON array**: Array of objects with `chat_messages`, `uuid`, `name`,
  `created_at`, `updated_at`.
- Messages have `sender` (`"human"`/`"assistant"`) → map to `"user"`/
  `"assistant"`.
- Text is in `text` field (or `content[].text` parts for the array format).
- Thinking chains in `thinking` or `thinking_blocks[].thinking` → `reasoning`.
- Timestamps are already ISO 8601.

### Generic platforms

For any platform not listed above:

1. Identify the conversation boundaries (files, array entries, JSONL lines).
2. Find the message array within each conversation.
3. Map the role field to `user`/`assistant` — if uncertain, check which side
   asks questions (user) and which responds (assistant).
4. Find or generate timestamps for each message.
5. Generate stable IDs from the platform's native IDs, or derive from
   `conversationId-messageIndex`.

---

## Validation checklist

Before writing the output file, verify every item:

- [ ] Top-level `format` is `"loom-standard"`
- [ ] Top-level `originPlatform` is set to the real platform name
- [ ] `conversations` is an array (can be empty)
- [ ] Every conversation has a non-empty `id`, unique within the file
- [ ] Every conversation has valid ISO 8601 `createdAt` and `updatedAt`
- [ ] Every conversation has a `messages` array ordered oldest-first
- [ ] Every message has a `role` of `"user"` or `"assistant"`
- [ ] Every message has non-empty `content` (after trimming whitespace)
- [ ] Every message has a valid ISO 8601 `createdAt`
- [ ] Message IDs are unique within their conversation
- [ ] No Unix epoch timestamps remain — all converted to ISO 8601
- [ ] Multi-part content has been concatenated into a single string
- [ ] Images/attachments have been replaced with placeholder text
- [ ] Reasoning/thinking chains are in `reasoning`, not `content`
- [ ] The output is valid JSON (no trailing commas, no comments)
