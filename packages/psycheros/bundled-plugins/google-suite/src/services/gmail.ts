/**
 * Gmail API wrapper.
 *
 * Wraps https://gmail.googleapis.com/gmail/v1/users/me/. Methods take a
 * GoogleClient and return typed results. Errors throw GoogleApiError.
 *
 * Message format:
 *   - Send: construct RFC 822 message (To/From/Subject/Content-Type + body)
 *     then base64url-encode and POST `{ "raw": "<base64>" }` to messages.send.
 *   - Read: response has nested `payload.parts[]` for multipart messages;
 *     walk the tree to find the text/plain body. Attachments are separate
 *     parts with `filename` + `attachmentId` — fetching their content needs
 *     a separate messages.attachments.get call (out of scope for v1; we
 *     surface filename + size only).
 *
 * Rate limits: 250 quota units/user/sec. messages.list = 5 units,
 * messages.get = 5 units, messages.send = 100 units. We don't enforce
 * client-side throttling — Google's 429 with Retry-After is the backoff
 * signal. The GoogleClient's existing 401 retry path covers auth issues;
 * 429 propagates as GoogleApiError for the caller to surface.
 */

import { encodeBase64Url } from "@std/encoding/base64url";
import type { GoogleClient } from "../client/google-client.ts";
import { GoogleApiError } from "./calendar.ts";

export { GoogleApiError };

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailMessageHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string; // base64url-encoded
  };
  parts?: GmailMessagePart[];
}

export interface GmailMessagePayload {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  /** Short preview (~150 chars) of the message body. */
  snippet?: string;
  /** Size of the full message in bytes. */
  sizeEstimate?: number;
  /** Internal date as epoch ms (when the message was received). */
  internalDate?: string;
  payload?: GmailMessagePayload;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
  color?: { textColor: string; backgroundColor: string };
}

export interface ListMessagesOptions {
  /** Gmail search query (e.g. "from:alice@example.com has:attachment after:2026/07/01"). */
  q?: string;
  /** Filter to specific label IDs. */
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
}

export interface ListMessagesResult {
  /** Just IDs + threadIds — caller must fetch each via getMessage for full content. */
  messages: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GetMessageOptions {
  /**
   * Level of detail. `metadata` (headers + labels only, no body) is the right
   * default for tools that just need subject/sender. `full` walks the parts
   * tree; needed to extract body text. Default: full.
   */
  format?: "minimal" | "full" | "raw" | "metadata";
}

export interface NewGmailMessage {
  to: Array<{ email: string; displayName?: string }>;
  cc?: Array<{ email: string; displayName?: string }>;
  bcc?: Array<{ email: string; displayName?: string }>;
  subject: string;
  body: string;
  /** Optional reply-to message ID (sets In-Reply-To + References headers). */
  inReplyTo?: string;
}

export interface SendMessageResult {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

export interface ModifyMessageOptions {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

const MAX_LIST_RESULTS_CAP = 500;
const DEFAULT_LIST_RESULTS = 20;

/**
 * Search/list messages by query. Returns IDs only — Gmail's list endpoint
 * doesn't return bodies. Caller fetches each via getMessage.
 */
export async function listMessages(
  client: GoogleClient,
  opts: ListMessagesOptions = {},
): Promise<ListMessagesResult> {
  const url = new URL(`${GMAIL_API_BASE}/messages`);
  if (opts.q) url.searchParams.set("q", opts.q);
  if (opts.labelIds && opts.labelIds.length > 0) {
    for (const id of opts.labelIds) url.searchParams.append("labelIds", id);
  }
  const maxResults = opts.maxResults !== undefined
    ? Math.min(Math.max(1, opts.maxResults), MAX_LIST_RESULTS_CAP)
    : DEFAULT_LIST_RESULTS;
  url.searchParams.set("maxResults", String(maxResults));
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const data = await client.fetchJson<ListMessagesResponse>(url.toString());
  return {
    messages: data.messages ?? [],
    nextPageToken: data.nextPageToken,
    resultSizeEstimate: data.resultSizeEstimate,
  };
}

/**
 * Get a single message by ID. Default format "full" extracts the body.
 * For metadata-only calls (subject + sender + labels), pass format:"metadata".
 */
export async function getMessage(
  client: GoogleClient,
  messageId: string,
  opts: GetMessageOptions = {},
): Promise<GmailMessage> {
  const format = opts.format ?? "full";
  const url = new URL(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`,
  );
  url.searchParams.set("format", format);
  return await client.fetchJson<GmailMessage>(url.toString());
}

/**
 * Send a message. Constructs RFC 822 from the typed input, base64url-encodes,
 * POSTs to messages.send. Returns the assigned message ID + thread ID.
 */
export async function sendMessage(
  client: GoogleClient,
  message: NewGmailMessage,
): Promise<SendMessageResult> {
  const raw = constructRfc822(message);
  const body = { raw };
  return await client.fetchJson<SendMessageResult>(
    `${GMAIL_API_BASE}/messages/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/**
 * Add and/or remove labels on a message in one call. Use this for:
 *   - mark read: removeLabelIds: ["UNREAD"]
 *   - mark unread: addLabelIds: ["UNREAD"]
 *   - star: addLabelIds: ["STARRED"]
 *   - archive: removeLabelIds: ["INBOX"]
 *   - trash: addLabelIds: ["TRASH"]
 *   - apply user label: addLabelIds: ["Label_123"] (use listLabels to find IDs)
 */
export async function modifyMessage(
  client: GoogleClient,
  messageId: string,
  opts: ModifyMessageOptions,
): Promise<{ labelIds: string[] }> {
  if (
    (!opts.addLabelIds || opts.addLabelIds.length === 0) &&
    (!opts.removeLabelIds || opts.removeLabelIds.length === 0)
  ) {
    throw new GoogleApiError(
      "modifyMessage requires at least one of addLabelIds or removeLabelIds",
      400,
    );
  }
  const data = await client.fetchJson<{ labelIds?: string[] }>(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addLabelIds: opts.addLabelIds ?? [],
        removeLabelIds: opts.removeLabelIds ?? [],
      }),
    },
  );
  return { labelIds: data.labelIds ?? [] };
}

/**
 * List all labels (system + user). Useful for finding label IDs to pass to
 * modifyMessage or listMessages.
 */
export async function listLabels(
  client: GoogleClient,
): Promise<GmailLabel[]> {
  const data = await client.fetchJson<{ labels?: GmailLabel[] }>(
    `${GMAIL_API_BASE}/labels`,
  );
  return data.labels ?? [];
}

/**
 * Batch modify labels on up to 1000 messages in a single API call.
 * Uses Gmail's native batchModify endpoint — far more efficient than
 * looping modifyMessage.
 */
export async function batchModifyMessages(
  client: GoogleClient,
  messageIds: string[],
  opts: ModifyMessageOptions,
): Promise<void> {
  if (messageIds.length === 0) {
    throw new GoogleApiError(
      "batchModifyMessages requires at least one message ID",
      400,
    );
  }
  if (messageIds.length > 1000) {
    throw new GoogleApiError(
      "batchModifyMessages max 1000 messages per call",
      400,
    );
  }
  await client.fetchJson(`${GMAIL_API_BASE}/messages/batchModify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ids: messageIds,
      addLabelIds: opts.addLabelIds ?? [],
      removeLabelIds: opts.removeLabelIds ?? [],
    }),
  });
}

/**
 * Permanently delete up to 1000 messages in a single API call.
 * Uses Gmail's native batchDelete endpoint. This is IRREVERSIBLE —
 * not the same as trashing (which uses modifyMessage with TRASH label).
 */
export async function batchDeleteMessages(
  client: GoogleClient,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) {
    throw new GoogleApiError(
      "batchDeleteMessages requires at least one message ID",
      400,
    );
  }
  if (messageIds.length > 1000) {
    throw new GoogleApiError(
      "batchDeleteMessages max 1000 messages per call",
      400,
    );
  }
  await client.fetchJson(`${GMAIL_API_BASE}/messages/batchDelete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: messageIds }),
  });
}

/**
 * Extract the text/plain body from a message payload by walking the parts
 * tree. Returns undefined if no text/plain part exists (rare — most email
 * clients include one alongside the HTML).
 *
 * Caller is responsible for passing a message fetched with format:"full".
 * format:"metadata" returns no payload body.
 */
export function extractTextBody(message: GmailMessage): string | undefined {
  if (!message.payload) return undefined;
  return findTextPart(message.payload);
}

function findTextPart(
  part: GmailMessagePayload | GmailMessagePart,
): string | undefined {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64UrlUtf8(part.body.data);
  }
  if (part.parts) {
    for (const child of part.parts) {
      const found = findTextPart(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Walk the parts tree collecting attachments (filename + size, NOT content).
 * Fetching attachment content needs a separate messages.attachments.get call
 * per attachment — out of scope for v1.
 */
export function listAttachments(
  message: GmailMessage,
): Array<{ filename: string; size: number; mimeType: string }> {
  if (!message.payload) return [];
  const attachments: Array<
    { filename: string; size: number; mimeType: string }
  > = [];
  walkForAttachments(message.payload, attachments);
  return attachments;
}

function walkForAttachments(
  part: GmailMessagePayload | GmailMessagePart,
  out: Array<{ filename: string; size: number; mimeType: string }>,
): void {
  if (part.filename && part.filename.length > 0) {
    out.push({
      filename: part.filename,
      size: part.body?.size ?? 0,
      mimeType: part.mimeType ?? "application/octet-stream",
    });
  }
  if (part.parts) {
    for (const child of part.parts) walkForAttachments(child, out);
  }
}

/**
 * Find a header by name (case-insensitive). Returns undefined if not present.
 * Gmail headers live on payload.headers for the root, but multipart messages
 * also have headers per part — for the common case (Subject, From, To, Date)
 * we only look at the root.
 */
export function findHeader(
  message: GmailMessage,
  name: string,
): string | undefined {
  const headers = message.payload?.headers ?? [];
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return undefined;
}

function constructRfc822(message: NewGmailMessage): string {
  const lines: string[] = [];
  const toHeader = message.to.map((r) =>
    r.displayName ? `${rfc822Escape(r.displayName)} <${r.email}>` : r.email
  ).join(", ");
  lines.push(`To: ${toHeader}`);
  if (message.cc && message.cc.length > 0) {
    const ccHeader = message.cc.map((r) =>
      r.displayName ? `${rfc822Escape(r.displayName)} <${r.email}>` : r.email
    ).join(", ");
    lines.push(`Cc: ${ccHeader}`);
  }
  if (message.bcc && message.bcc.length > 0) {
    const bccHeader = message.bcc.map((r) =>
      r.displayName ? `${rfc822Escape(r.displayName)} <${r.email}>` : r.email
    ).join(", ");
    lines.push(`Bcc: ${bccHeader}`);
  }
  // RFC 5322 requires a properly-encoded Subject. For ASCII subjects this is
  // passthrough; for Unicode we should MIME-encode (=?UTF-8?B?...?=) — left
  // as a future enhancement. Most subjects are ASCII anyway.
  lines.push(`Subject: ${encodeSubject(message.subject)}`);
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("MIME-Version: 1.0");
  if (message.inReplyTo) {
    lines.push(`In-Reply-To: ${message.inReplyTo}`);
    lines.push(`References: ${message.inReplyTo}`);
  }
  lines.push("");
  lines.push(message.body);
  const raw = lines.join("\r\n");
  return encodeBase64Url(new TextEncoder().encode(raw));
}

function rfc822Escape(name: string): string {
  // Display names containing "," or special chars must be quoted; quotes
  // inside are escaped with backslash. Conservative escape — covers the
  // common cases.
  if (/["\\\r\n]/.test(name)) {
    return `"${name.replace(/["\\]/g, "\\$&")}"`;
  }
  if (/[,;<>()@:]/.test(name)) {
    return `"${name}"`;
  }
  return name;
}

/**
 * MIME-encode a Subject header per RFC 2047 if it contains non-ASCII
 * characters. Gmail decodes =?UTF-8?B?...?= correctly. ASCII subjects
 * pass through unchanged.
 */
function encodeSubject(subject: string): string {
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  const bytes = new TextEncoder().encode(subject);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function decodeBase64UrlUtf8(data: string): string {
  // Gmail's body.data is base64url-encoded. Convert to standard base64 by
  // replacing URL-safe chars + adding padding, then decode.
  const standard = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(
    standard.length + (4 - standard.length % 4) % 4,
    "=",
  );
  const bytes = atob(padded);
  // Re-encode as UTF-8 — Gmail bodies are UTF-8 per Content-Type above.
  const utf8 = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) utf8[i] = bytes.charCodeAt(i);
  return new TextDecoder("utf-8").decode(utf8);
}

interface ListMessagesResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
