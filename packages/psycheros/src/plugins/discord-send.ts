/**
 * Discord attachment sending for plugins.
 *
 * I post one message with file attachments to a Discord channel on the
 * entity's behalf, using the host's bot token. The token stays here — plugin
 * code receives this service through `services.discord`, never the raw
 * credential.
 */

import type { PluginEventLevel } from "./event-log.ts";

export interface PsycherosDiscordSendParams {
  channelId: string;
  /** Optional text sent alongside the attachments. */
  content?: string;
  /** Message ID to reply under (threaded reference). */
  messageReferenceId?: string;
  /**
   * Optional idempotency key — the host derives the Discord nonce from it
   * and sets enforce_nonce, so a retried send with the same key dedupes
   * server-side (best-effort, window-scoped).
   */
  idempotencyKey?: string;
  files: Array<{
    filename: string;
    contentType?: string;
    data: Uint8Array | ArrayBuffer;
  }>;
}

export interface SendDiscordAttachmentsOptions {
  token: string;
  /** Optional event-log sink for the send outcome. */
  record?: (event: {
    level: PluginEventLevel;
    message: string;
    details?: Record<string, unknown>;
  }) => void;
}

/** Bot upload cap per file. */
const DISCORD_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DISCORD_MAX_FILES = 10;
const SEND_TIMEOUT_MS = 30_000;

function toBlobPart(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof Uint8Array) {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
  }
  return data;
}

/** Discord caps message nonces at 25 characters. */
async function nonceFromIdempotencyKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 25);
}

/**
 * Send one message with file attachments. Throws on validation failure,
 * rate limiting, or any non-OK response — the caller (plugin tool) surfaces
 * the message to the entity.
 */
export async function sendDiscordAttachments(
  params: PsycherosDiscordSendParams,
  options: SendDiscordAttachmentsOptions,
): Promise<{ messageIds: string[] }> {
  const { channelId, content, messageReferenceId, files } = params;

  if (!channelId?.trim()) {
    throw new Error("sendAttachments: channelId is required");
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("sendAttachments: at least one file is required");
  }
  if (files.length > DISCORD_MAX_FILES) {
    throw new Error(
      `sendAttachments: ${files.length} files exceed Discord's limit of ${DISCORD_MAX_FILES} per message`,
    );
  }
  for (const file of files) {
    if (!file.filename?.trim()) {
      throw new Error("sendAttachments: every file needs a filename");
    }
    const bytes = toBlobPart(file.data ?? new Uint8Array());
    if (bytes.byteLength === 0) {
      throw new Error(`sendAttachments: file "${file.filename}" is empty`);
    }
    if (bytes.byteLength > DISCORD_MAX_FILE_BYTES) {
      throw new Error(
        `sendAttachments: file "${file.filename}" is over the 8 MB bot upload cap`,
      );
    }
  }

  const payload: Record<string, unknown> = {};
  if (content?.trim()) payload.content = content.trim();
  if (messageReferenceId?.trim()) {
    payload.message_reference = {
      message_id: messageReferenceId.trim(),
      channel_id: channelId,
    };
  }
  if (params.idempotencyKey?.trim()) {
    payload.nonce = await nonceFromIdempotencyKey(params.idempotencyKey);
    payload.enforce_nonce = true;
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  files.forEach((file, index) => {
    form.append(
      `files[${index}]`,
      new Blob([toBlobPart(file.data ?? new Uint8Array())], {
        type: file.contentType || "application/octet-stream",
      }),
      file.filename,
    );
  });

  let response: Response;
  try {
    response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: { "Authorization": `Bot ${options.token}` },
        body: form,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.record?.({
      level: "error",
      message: `attachment send to channel ${channelId} failed: ${message}`,
    });
    throw new Error(`sendAttachments: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const delay = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;
      options.record?.({
        level: "warn",
        message: `attachment send rate limited — retry after ${
          Math.round(delay)
        }ms`,
      });
      throw new Error(
        `sendAttachments: rate limited (429). Retry after ${
          Math.round(delay)
        }ms.`,
      );
    }
    options.record?.({
      level: "error",
      message: `attachment send failed: ${response.status}`,
      details: { body: body.substring(0, 200) },
    });
    throw new Error(
      `sendAttachments: ${response.status} ${body.substring(0, 200)}`,
    );
  }

  const data = await response.json() as { id?: string };
  options.record?.({
    level: "info",
    message: `sent ${files.length} attachment(s) to channel ${channelId}`,
    details: { filenames: files.map((file) => file.filename) },
  });
  return { messageIds: data.id ? [data.id] : [] };
}
