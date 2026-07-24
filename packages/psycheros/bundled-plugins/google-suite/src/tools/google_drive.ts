/**
 * google_drive omni-tool — all Drive operations in one tool.
 *
 * Action parameter selects the operation; per-action args vary. Replaces the
 * five-tool split (list_drive_files / read_drive_file / create_drive_file /
 * update_drive_file / delete_drive_file) for consistency with the rest of
 * the google-suite plugin (one tool per service).
 *
 * Drive has no prompt hook — file state doesn't change turn-to-turn. Entity
 * queries on demand.
 *
 * drive.file scope: the API only sees files this app created (or files the
 * operator opened via the Google Drive Picker, which we don't ship). The
 * description below surfaces this to the entity so it knows the limits.
 */

import type { Tool } from "../../../../src/tools/types.ts";
import { getGoogleClient } from "../plugin-state.ts";
import {
  createFolder,
  createTextFile,
  deleteDriveFile,
  type DriveFile,
  GoogleApiError,
  listDriveFiles,
  readDriveFile,
  updateDriveFile,
} from "../services/drive.ts";

interface DriveArgs {
  action?: "list" | "read" | "create" | "update" | "delete";
  // list args
  query?: string;
  parent_id?: string;
  include_trashed?: boolean;
  max_results?: number;
  order_by?: string;
  // read / update / delete args
  file_id?: string;
  // create args
  name?: string;
  content?: string;
  description?: string;
  type?: "file" | "folder";
  mime_type?: string;
  // update args
  add_parents?: string[];
  remove_parents?: string[];
  // delete arg
  permanent?: boolean;
}

const MAX_LIST_RESULTS_CAP = 1000;
const DEFAULT_LIST_RESULTS = 50;

export const googleDriveTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "google_drive",
      description:
        "Manage files in my user's Google Drive. Pass `action` to pick the " +
        "operation: 'list' (query for files), 'read' (fetch content + metadata " +
        "by ID), 'create' (new text file or folder), 'update' (rename/move/" +
        "replace content), 'delete' (trash or permanent). IMPORTANT: with the " +
        "privacy-friendly drive.file scope, I only see files this app created " +
        "— I cannot see the user's entire Drive. I use this on demand when " +
        "the user asks me to save notes, drafts, or organize files.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "read", "create", "update", "delete"],
            description: "Operation to perform.",
          },
          query: {
            type: "string",
            description:
              "list: Drive query DSL. Examples: 'name = \"foo\"', \"'folderId' in parents\", 'modifiedTime > \"2026-07-01\"'.",
          },
          parent_id: {
            type: "string",
            description:
              "list/create: folder ID to scope listing or create within.",
          },
          include_trashed: {
            type: "boolean",
            description: "list: include trashed files. Default false.",
          },
          max_results: {
            type: "integer",
            description:
              `list: cap on files returned. Default ${DEFAULT_LIST_RESULTS}, max ${MAX_LIST_RESULTS_CAP}.`,
          },
          order_by: {
            type: "string",
            description: "list: sort clause, e.g. 'modifiedTime desc'.",
          },
          file_id: {
            type: "string",
            description:
              "read/update/delete: file ID — from list or create result.",
          },
          name: {
            type: "string",
            description: "create/update: file or folder name.",
          },
          content: {
            type: "string",
            description:
              "create/update: text content of the file. Ignored when type='folder'.",
          },
          description: {
            type: "string",
            description:
              "create/update: file description (visible in Drive's details panel).",
          },
          type: {
            type: "string",
            enum: ["file", "folder"],
            description:
              "create: what to create. Default 'file'. Use 'folder' for a folder.",
          },
          mime_type: {
            type: "string",
            description:
              "create: override MIME type. Default 'text/plain'. Use for 'text/markdown', 'text/csv', 'application/json', etc.",
          },
          add_parents: {
            type: "array",
            items: { type: "string" },
            description: "update: folder IDs to add to the file's parents.",
          },
          remove_parents: {
            type: "array",
            items: { type: "string" },
            description: "update: folder IDs to remove from parents.",
          },
          permanent: {
            type: "boolean",
            description:
              "delete: if true, permanently delete (irreversible). If false (default), move to trash.",
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
    const parsed = args as DriveArgs;
    switch (parsed.action) {
      case "list":
        return doList(parsed, ctx.toolCallId);
      case "read":
        return doRead(parsed, ctx.toolCallId);
      case "create":
        return doCreate(parsed, ctx.toolCallId);
      case "update":
        return doUpdate(parsed, ctx.toolCallId);
      case "delete":
        return doDelete(parsed, ctx.toolCallId);
      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Missing or invalid action "${
            parsed.action ?? "(missing)"
          }". Use one of: list, read, create, update, delete.`,
          isError: true,
        };
    }
  },
};

async function doList(args: DriveArgs, toolCallId: string) {
  const client = getGoogleClient()!;
  try {
    const result = await listDriveFiles(client, {
      q: args.query,
      parentId: args.parent_id,
      includeTrashed: args.include_trashed,
      maxResults: args.max_results,
      orderBy: args.order_by,
    });
    if (result.files.length === 0) {
      return {
        toolCallId,
        content:
          "No files visible to this app. With drive.file scope, I only see files I've created — call google_drive with action='create' to add new ones.",
      };
    }
    return {
      toolCallId,
      content: formatFilesList(result.files, result.incomplete),
    };
  } catch (error) {
    return errorResult(toolCallId, "list files", error);
  }
}

async function doRead(args: DriveArgs, toolCallId: string) {
  if (!args.file_id?.trim()) {
    return missingField(toolCallId, "file_id");
  }
  const client = getGoogleClient()!;
  try {
    const result = await readDriveFile(client, args.file_id);
    return {
      toolCallId,
      content: formatReadResult(result),
    };
  } catch (error) {
    return errorResult(toolCallId, "read file", error);
  }
}

async function doCreate(args: DriveArgs, toolCallId: string) {
  if (!args.name?.trim()) {
    return missingField(toolCallId, "name");
  }
  const client = getGoogleClient()!;
  try {
    let created: DriveFile;
    if (args.type === "folder") {
      created = await createFolder(client, {
        name: args.name,
        parentId: args.parent_id,
      });
    } else {
      if (args.content === undefined) {
        return {
          toolCallId,
          content:
            "Missing required field for file creation: content (set type='folder' to create a folder, or pass content for a file).",
          isError: true,
        };
      }
      created = await createTextFile(client, {
        name: args.name,
        content: args.content,
        parentId: args.parent_id,
        description: args.description,
        mimeType: args.mime_type,
      });
    }
    const typeLabel = args.type === "folder" ? "Folder" : "File";
    const link = created.webViewLink ? `\nView: ${created.webViewLink}` : "";
    return {
      toolCallId,
      content:
        `${typeLabel} "${created.name}" created (id: ${created.id}).${link}`,
    };
  } catch (error) {
    return errorResult(toolCallId, "create file", error);
  }
}

async function doUpdate(args: DriveArgs, toolCallId: string) {
  if (!args.file_id?.trim()) {
    return missingField(toolCallId, "file_id");
  }
  const client = getGoogleClient()!;
  try {
    const updated = await updateDriveFile(client, args.file_id, {
      name: args.name,
      description: args.description,
      addParents: args.add_parents,
      removeParents: args.remove_parents,
      content: args.content,
    });
    const link = updated.webViewLink ? `\nView: ${updated.webViewLink}` : "";
    return {
      toolCallId,
      content: `Updated "${updated.name}" (id: ${updated.id}).${link}`,
    };
  } catch (error) {
    return errorResult(toolCallId, "update file", error);
  }
}

async function doDelete(args: DriveArgs, toolCallId: string) {
  if (!args.file_id?.trim()) {
    return missingField(toolCallId, "file_id");
  }
  const client = getGoogleClient()!;
  try {
    await deleteDriveFile(client, args.file_id, {
      permanent: args.permanent === true,
    });
    const action = args.permanent === true ? "Permanently deleted" : "Trashed";
    return {
      toolCallId,
      content: `${action} file ${args.file_id}.`,
    };
  } catch (error) {
    return errorResult(toolCallId, "delete file", error);
  }
}

function formatFilesList(files: DriveFile[], incomplete?: boolean): string {
  const lines = files.map((f) => {
    const type = f.mimeType === "application/vnd.google-apps.folder"
      ? "📁"
      : "📄";
    const size = f.size ? ` (${formatBytes(parseInt(f.size, 10))})` : "";
    const parent = f.parents && f.parents.length > 0
      ? ` [parent: ${f.parents[0]}]`
      : "";
    return `  - ${type} ${f.name} (id: ${f.id})${size}${parent}`;
  });
  const note = incomplete
    ? " (partial results — some files skipped due to permissions)"
    : "";
  return `Found ${files.length} file(s)${note}:\n${lines.join("\n")}`;
}

function formatReadResult(
  result: {
    metadata: DriveFile;
    content?: string;
    contentOmitted?: boolean;
    note?: string;
  },
): string {
  const lines: string[] = [];
  lines.push(`Name: ${result.metadata.name}`);
  if (result.metadata.mimeType) lines.push(`Type: ${result.metadata.mimeType}`);
  if (result.metadata.size) lines.push(`Size: ${result.metadata.size} bytes`);
  if (result.metadata.modifiedTime) {
    lines.push(`Modified: ${result.metadata.modifiedTime}`);
  }
  if (result.metadata.webViewLink) {
    lines.push(`View: ${result.metadata.webViewLink}`);
  }
  if (result.note) lines.push(`Note: ${result.note}`);
  if (result.content !== undefined) {
    lines.push("");
    lines.push("Content:");
    lines.push(result.content);
  } else if (!result.contentOmitted && !result.note) {
    lines.push("");
    lines.push("(no readable content for this file type)");
  }
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
    ? `Google Drive API error (${error.status}): ${error.message}`
    : error instanceof Error
    ? error.message
    : String(error);
  return {
    toolCallId,
    content: `Failed to ${op}: ${message}`,
    isError: true,
  };
}
