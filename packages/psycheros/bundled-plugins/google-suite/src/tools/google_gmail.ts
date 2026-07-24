/**
 * google_gmail omni-tool — all Gmail operations in one tool.
 *
 * Action parameter selects the operation; per-action args vary. Replaces the
 * five-tool split (list_gmail_messages / read_gmail_message /
 * send_gmail_message / modify_gmail_message / list_gmail_labels) for
 * consistency with the rest of the google-suite plugin (one tool per
 * service).
 *
 * Gmail has no prompt hook — privacy concern + noise. The entity reads email
 * on demand via this tool, never ambient-aware of inbox state.
 */

import type { Tool } from "../../../../src/tools/types.ts";
import { getGoogleClient } from "../plugin-state.ts";
import {
  batchDeleteMessages,
  batchModifyMessages,
  extractTextBody,
  findHeader,
  getMessage,
  type GmailMessage,
  GoogleApiError,
  listAttachments,
  listLabels,
  listMessages,
  modifyMessage,
  sendMessage,
} from "../services/gmail.ts";

interface GmailArgs {
  action?:
    | "list"
    | "read"
    | "send"
    | "modify"
    | "list_labels"
    | "batch_modify"
    | "batch_delete";
  // list args
  query?: string;
  label_ids?: string[];
  max_results?: number;
  // read / modify args (single message)
  message_id?: string;
  // batch args
  message_ids?: string[];
  // send args
  to?: Array<{ email: string; displayName?: string }>;
  cc?: Array<{ email: string; displayName?: string }>;
  bcc?: Array<{ email: string; displayName?: string }>;
  subject?: string;
  body?: string;
  in_reply_to?: string;
  // modify / batch_modify args
  add_label_ids?: string[];
  remove_label_ids?: string[];
}

const MAX_LIST_RESULTS_CAP = 500;
const DEFAULT_LIST_RESULTS = 20;

export const googleGmailTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "google_gmail",
      description:
        "Manage my user's Gmail inbox. Pass `action` to pick the operation: " +
        "'list' (search by Gmail query DSL), 'read' (fetch full message by ID), " +
        "'send' (compose + send — confirm with user before unsolicited sends), " +
        "'modify' (add/remove labels: mark read/unread, star, archive, trash), " +
        "'list_labels' (label IDs needed by modify/list). I use this to find " +
        "and act on emails when the user asks me to — I'm not ambient-aware " +
        "of inbox state.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "read",
              "send",
              "modify",
              "list_labels",
              "batch_modify",
              "batch_delete",
            ],
            description: "Operation to perform.",
          },
          query: {
            type: "string",
            description:
              "list: Gmail search query. Examples: 'from:alice@example.com', 'subject:invoice has:attachment', 'is:unread after:2026/07/01'.",
          },
          label_ids: {
            type: "array",
            items: { type: "string" },
            description: "list: filter to specific label IDs.",
          },
          max_results: {
            type: "integer",
            description:
              `list: cap on number of messages. Default ${DEFAULT_LIST_RESULTS}, max ${MAX_LIST_RESULTS_CAP}.`,
          },
          message_id: {
            type: "string",
            description: "read/modify: message ID — from a list result.",
          },
          message_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "batch_modify/batch_delete: array of message IDs. Get from a list action first. Max 1000.",
          },
          to: {
            type: "array",
            description: "send: primary recipients.",
            items: {
              type: "object",
              properties: {
                email: { type: "string" },
                displayName: { type: "string" },
              },
              required: ["email"],
            },
          },
          cc: {
            type: "array",
            description: "send: carbon-copy recipients.",
            items: {
              type: "object",
              properties: {
                email: { type: "string" },
                displayName: { type: "string" },
              },
              required: ["email"],
            },
          },
          bcc: {
            type: "array",
            description: "send: blind-carbon-copy recipients.",
            items: {
              type: "object",
              properties: {
                email: { type: "string" },
                displayName: { type: "string" },
              },
              required: ["email"],
            },
          },
          subject: {
            type: "string",
            description: "send: subject line. ASCII recommended.",
          },
          body: {
            type: "string",
            description: "send: plain-text body of the email.",
          },
          in_reply_to: {
            type: "string",
            description:
              "send: optional Message-ID being replied to (sets In-Reply-To + References headers).",
          },
          add_label_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "modify: label IDs to add. System: UNREAD, STARRED, IMPORTANT, TRASH, INBOX. User labels look like 'Label_123'.",
          },
          remove_label_ids: {
            type: "array",
            items: { type: "string" },
            description: "modify: label IDs to remove.",
          },
        },
        required: ["action"],
      },
    },
  },

  async execute(args, ctx) {
    const client = getGoogleClient();
    if (!client?.isConfigured()) {
      return notConnectedResult(ctx.toolCallId);
    }
    const parsed = args as GmailArgs;
    switch (parsed.action) {
      case "list":
        return doList(parsed, ctx.toolCallId);
      case "read":
        return doRead(parsed, ctx.toolCallId);
      case "send":
        return doSend(parsed, ctx.toolCallId);
      case "modify":
        return doModify(parsed, ctx.toolCallId);
      case "list_labels":
        return doListLabels(ctx.toolCallId);
      case "batch_modify":
        return doBatchModify(parsed, ctx.toolCallId);
      case "batch_delete":
        return doBatchDelete(parsed, ctx.toolCallId);
      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Missing or invalid action "${
            parsed.action ?? "(missing)"
          }". Use one of: list, read, send, modify, list_labels.`,
          isError: true,
        };
    }
  },
};

async function doList(args: GmailArgs, toolCallId: string) {
  const client = getGoogleClient()!;
  try {
    const result = await listMessages(client, {
      q: args.query,
      labelIds: args.label_ids,
      maxResults: args.max_results,
    });
    if (result.messages.length === 0) {
      return {
        toolCallId,
        content: args.query
          ? `No messages matched query "${args.query}".`
          : "No messages found.",
      };
    }
    const lines = result.messages.map((m) =>
      `  - id: ${m.id}${m.threadId ? ` (thread: ${m.threadId})` : ""}`
    );
    const approx = result.resultSizeEstimate !== undefined
      ? ` (~${result.resultSizeEstimate} total matches)`
      : "";
    return {
      toolCallId,
      content: `Found ${result.messages.length} message(s)${approx}:\n${
        lines.join("\n")
      }\n\nCall google_gmail with action="read" + message_id to see content.`,
    };
  } catch (error) {
    return errorResult(toolCallId, "list messages", error);
  }
}

async function doRead(args: GmailArgs, toolCallId: string) {
  if (!args.message_id?.trim()) {
    return missingField(toolCallId, "message_id");
  }
  const client = getGoogleClient()!;
  try {
    const message = await getMessage(client, args.message_id, {
      format: "full",
    });
    return {
      toolCallId,
      content: formatMessage(message),
    };
  } catch (error) {
    return errorResult(toolCallId, "read message", error);
  }
}

async function doSend(args: GmailArgs, toolCallId: string) {
  if (!args.to || args.to.length === 0) {
    return missingField(toolCallId, "to (at least one recipient)");
  }
  if (!args.subject?.trim()) return missingField(toolCallId, "subject");
  if (!args.body?.trim()) {
    return missingField(toolCallId, "body (cannot send an empty email)");
  }
  const client = getGoogleClient()!;
  try {
    const result = await sendMessage(client, {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body,
      inReplyTo: args.in_reply_to,
    });
    const recipients = (args.to ?? []).map((r) => r.email).join(", ");
    const threadNote = result.threadId ? ` Thread: ${result.threadId}.` : "";
    return {
      toolCallId,
      content:
        `Sent "${args.subject}" to ${recipients}. Message ID: ${result.id}.${threadNote}`,
    };
  } catch (error) {
    return errorResult(toolCallId, "send message", error);
  }
}

async function doModify(args: GmailArgs, toolCallId: string) {
  if (!args.message_id?.trim()) {
    return missingField(toolCallId, "message_id");
  }
  if (
    (!args.add_label_ids || args.add_label_ids.length === 0) &&
    (!args.remove_label_ids || args.remove_label_ids.length === 0)
  ) {
    return {
      toolCallId,
      content:
        "No labels to change. Provide at least one of add_label_ids or remove_label_ids.",
      isError: true,
    };
  }
  const client = getGoogleClient()!;
  try {
    const result = await modifyMessage(client, args.message_id, {
      addLabelIds: args.add_label_ids,
      removeLabelIds: args.remove_label_ids,
    });
    const parts: string[] = [];
    if (args.add_label_ids && args.add_label_ids.length > 0) {
      parts.push(`added [${args.add_label_ids.join(", ")}]`);
    }
    if (args.remove_label_ids && args.remove_label_ids.length > 0) {
      parts.push(`removed [${args.remove_label_ids.join(", ")}]`);
    }
    return {
      toolCallId,
      content: `Modified message ${args.message_id}: ${
        parts.join(", ")
      }. Current labels: [${result.labelIds.join(", ")}].`,
    };
  } catch (error) {
    return errorResult(toolCallId, "modify message", error);
  }
}

async function doListLabels(toolCallId: string) {
  const client = getGoogleClient()!;
  try {
    const labels = await listLabels(client);
    if (labels.length === 0) {
      return { toolCallId, content: "No labels found." };
    }
    const system = labels.filter((l) => l.type !== "user");
    const user = labels.filter((l) => l.type === "user");
    const lines: string[] = [];
    if (system.length > 0) {
      lines.push("System labels:");
      for (const l of system) lines.push(`  - ${l.id}: ${l.name}`);
    }
    if (user.length > 0) {
      lines.push("User labels:");
      for (const l of user) lines.push(`  - ${l.id}: ${l.name}`);
    }
    return { toolCallId, content: lines.join("\n") };
  } catch (error) {
    return errorResult(toolCallId, "list labels", error);
  }
}

async function doBatchModify(args: GmailArgs, toolCallId: string) {
  if (!args.message_ids || args.message_ids.length === 0) {
    return missingField(toolCallId, "message_ids");
  }
  if (
    (!args.add_label_ids || args.add_label_ids.length === 0) &&
    (!args.remove_label_ids || args.remove_label_ids.length === 0)
  ) {
    return {
      toolCallId,
      content:
        "No labels to change. Provide at least one of add_label_ids or remove_label_ids.",
      isError: true,
    };
  }
  const client = getGoogleClient()!;
  try {
    await batchModifyMessages(client, args.message_ids, {
      addLabelIds: args.add_label_ids,
      removeLabelIds: args.remove_label_ids,
    });
    const parts: string[] = [];
    if (args.add_label_ids && args.add_label_ids.length > 0) {
      parts.push(`added [${args.add_label_ids.join(", ")}]`);
    }
    if (args.remove_label_ids && args.remove_label_ids.length > 0) {
      parts.push(`removed [${args.remove_label_ids.join(", ")}]`);
    }
    return {
      toolCallId,
      content: `Batch modified ${args.message_ids.length} message(s): ${
        parts.join(", ")
      }.`,
    };
  } catch (error) {
    return errorResult(toolCallId, "batch modify", error);
  }
}

async function doBatchDelete(args: GmailArgs, toolCallId: string) {
  if (!args.message_ids || args.message_ids.length === 0) {
    return missingField(toolCallId, "message_ids");
  }
  const client = getGoogleClient()!;
  try {
    await batchDeleteMessages(client, args.message_ids);
    return {
      toolCallId,
      content: `Permanently deleted ${args.message_ids.length} message(s).`,
    };
  } catch (error) {
    return errorResult(toolCallId, "batch delete", error);
  }
}

function formatMessage(message: GmailMessage): string {
  const from = findHeader(message, "From") ?? "(unknown sender)";
  const to = findHeader(message, "To") ?? "";
  const cc = findHeader(message, "Cc");
  const subject = findHeader(message, "Subject") ?? "(no subject)";
  const date = findHeader(message, "Date") ?? "";
  const labels = message.labelIds && message.labelIds.length > 0
    ? message.labelIds.join(", ")
    : "(none)";
  const body = extractTextBody(message);
  const attachments = listAttachments(message);

  const lines: string[] = [];
  lines.push(`Subject: ${subject}`);
  lines.push(`From: ${from}`);
  if (to) lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (date) lines.push(`Date: ${date}`);
  lines.push(`Labels: ${labels}`);
  lines.push(`ID: ${message.id}`);
  if (attachments.length > 0) {
    lines.push(`Attachments (${attachments.length}):`);
    for (const a of attachments) {
      lines.push(`  - ${a.filename} (${formatBytes(a.size)}, ${a.mimeType})`);
    }
  }
  lines.push("");
  lines.push(body ?? "(no text/plain body — this email is HTML-only)");
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function missingField(toolCallId: string, field: string) {
  return {
    toolCallId,
    content: `Missing required field for this action: ${field}.`,
    isError: true,
  };
}

function notConnectedResult(toolCallId: string) {
  return {
    toolCallId,
    content:
      "Google Suite is not connected. Ask the operator to configure it in Settings → Plugins → Google Suite.",
    isError: true,
  };
}

function errorResult(toolCallId: string, op: string, error: unknown) {
  const message = error instanceof GoogleApiError
    ? `Gmail API error (${error.status}): ${error.message}`
    : error instanceof Error
    ? error.message
    : String(error);
  return {
    toolCallId,
    content: `Failed to ${op}: ${message}`,
    isError: true,
  };
}
