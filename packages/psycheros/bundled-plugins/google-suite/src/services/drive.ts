/**
 * Google Drive API wrapper.
 *
 * Wraps https://www.googleapis.com/drive/v3/. Methods take a GoogleClient
 * and return typed results. Errors throw GoogleApiError (re-exported from
 * calendar.ts so callers share one error type).
 *
 * Scope note (drive.file — privacy-friendly default):
 *   With drive.file scope, the API can ONLY see files created by this app
 *   OR files the operator explicitly opened via the Google Drive Picker
 *   (which we don't ship). Practically, listDriveFiles returns just files
 *   the entity itself created. Users who want full-Drive access must change
 *   the scope to `drive` (sensitive, requires Google verification) — out
 *   of scope for v1.
 *
 * Google Workspace formats (Docs/Sheets/Slides) need `files.export` to
 * convert to downloadable form. readDriveFile auto-detects these and
 * exports as text/plain (Docs), text/csv (Sheets), or PDF (Slides).
 *
 * Upload shape:
 *   - createDriveFile with content → multipart/related with metadata + media
 *   - updateDriveFile metadata → simple PATCH
 *   - updateDriveFile content → PATCH with uploadType=media
 */

import type { GoogleClient } from "../client/google-client.ts";
import { GoogleApiError } from "./calendar.ts";

export { GoogleApiError };

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
/** Cap for inline content reads — anything larger returns metadata only. */
const MAX_INLINE_READ_BYTES = 5 * 1024 * 1024; // 5 MB

const GOOGLE_WORKSPACE_MIME_TYPES = {
  DOCUMENT: "application/vnd.google-apps.document",
  SPREADSHEET: "application/vnd.google-apps.spreadsheet",
  PRESENTATION: "application/vnd.google-apps.presentation",
  FOLDER: "application/vnd.google-apps.folder",
} as const;

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  description?: string;
  /** Parent folder IDs — a file can have multiple parents. */
  parents?: string[];
  /** ISO timestamp of last modification. */
  modifiedTime?: string;
  /** ISO timestamp of creation. */
  createdTime?: string;
  /** Size in bytes (as string — Drive returns sizes as strings). */
  size?: string;
  webViewLink?: string;
  /** True if the file is in the trash. */
  trashed?: boolean;
}

export interface ListDriveFilesOptions {
  /**
   * Drive query DSL. Examples:
   *   - "name = 'foo.txt'"
   *   - "mimeType = 'application/vnd.google-apps.folder'"
   *   - "'<folderId>' in parents"
   *   - "trashed = false"
   *   - "modifiedTime > '2026-07-01T00:00:00'"
   * Operators: =, !=, <, <=, >, >=, in, contains, has.
   * Leave undefined to list all (visible to this app) files.
   */
  q?: string;
  /** Folder ID to scope the listing to. Translates to "'<id>' in parents". */
  parentId?: string;
  /** Include trashed files in results. Default false. */
  includeTrashed?: boolean;
  maxResults?: number;
  pageToken?: string;
  /** Order clause, e.g. "modifiedTime desc". */
  orderBy?: string;
}

export interface ListDriveFilesResult {
  files: DriveFile[];
  nextPageToken?: string;
  /** Whether partial results were returned due to permissions. */
  incomplete?: boolean;
}

export interface ReadDriveFileOptions {
  /** Override the export mimeType for Google Workspace files. */
  exportMimeType?: string;
}

export interface ReadDriveFileResult {
  metadata: DriveFile;
  /** File content as text. Undefined if the file was too large to inline. */
  content?: string;
  /** True if content was omitted because the file exceeded the inline cap. */
  contentOmitted?: boolean;
  /** Why content was omitted, when applicable. */
  note?: string;
}

export interface CreateDriveFileOptions {
  name: string;
  /** Folder ID to create in. Omit for root. */
  parentId?: string;
  description?: string;
}

export interface CreateTextFileOptions extends CreateDriveFileOptions {
  /** Text content of the file. */
  content: string;
  /** MIME type of the content. Default "text/plain". */
  mimeType?: string;
}

export interface CreateFolderOptions {
  name: string;
  parentId?: string;
}

export interface UpdateDriveFileOptions {
  name?: string;
  description?: string;
  /** Add these folder IDs to the file's parents. */
  addParents?: string[];
  /** Remove these folder IDs from the file's parents. */
  removeParents?: string[];
  /** Replace file content (only for non-Workspace files). */
  content?: string;
}

const MAX_LIST_RESULTS_CAP = 1000;
const DEFAULT_LIST_RESULTS = 50;

/**
 * List files visible to this app. With `drive.file` scope, that's files
 * this app created — not the user's entire Drive. Document this clearly
 * to operators; full-Drive access would require the sensitive `drive` scope
 * and Google verification.
 */
export async function listDriveFiles(
  client: GoogleClient,
  opts: ListDriveFilesOptions = {},
): Promise<ListDriveFilesResult> {
  const url = new URL(`${DRIVE_API_BASE}/files`);
  const clauses: string[] = [];
  if (opts.q) clauses.push(`(${opts.q})`);
  if (opts.parentId) {
    clauses.push(`'${escapeQueryString(opts.parentId)}' in parents`);
  }
  if (!opts.includeTrashed) clauses.push("trashed = false");
  if (clauses.length > 0) url.searchParams.set("q", clauses.join(" and "));

  const maxResults = opts.maxResults !== undefined
    ? Math.min(Math.max(1, opts.maxResults), MAX_LIST_RESULTS_CAP)
    : DEFAULT_LIST_RESULTS;
  url.searchParams.set("pageSize", String(maxResults));
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
  if (opts.orderBy) url.searchParams.set("orderBy", opts.orderBy);

  // Default fields — enough for list view; caller fetches more via getDriveFile.
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,modifiedTime,size,parents,webViewLink,trashed),nextPageToken,incompleteSearch",
  );

  const data = await client.fetchJson<{
    files?: DriveFile[];
    nextPageToken?: string;
    incompleteSearch?: boolean;
  }>(url.toString());
  return {
    files: data.files ?? [],
    nextPageToken: data.nextPageToken,
    incomplete: data.incompleteSearch,
  };
}

/**
 * Get a single file's metadata by ID.
 */
export async function getDriveFile(
  client: GoogleClient,
  fileId: string,
): Promise<DriveFile> {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set(
    "fields",
    "id,name,mimeType,description,parents,modifiedTime,createdTime,size,webViewLink,trashed",
  );
  return await client.fetchJson<DriveFile>(url.toString());
}

/**
 * Read a file's content + metadata. For Google Workspace formats (Docs/
 * Sheets/Slides) the content is exported as text — plain for Docs, CSV for
 * Sheets, PDF-binary for Slides (we surface as note "binary content omitted"
 * since PDF bytes aren't useful inline).
 *
 * Files larger than 5 MB return metadata + a `contentOmitted` flag rather
 * than dumping the body into the entity's context.
 */
export async function readDriveFile(
  client: GoogleClient,
  fileId: string,
  opts: ReadDriveFileOptions = {},
): Promise<ReadDriveFileResult> {
  const metadata = await getDriveFile(client, fileId);
  const sizeBytes = metadata.size ? parseInt(metadata.size, 10) : 0;
  if (sizeBytes > MAX_INLINE_READ_BYTES) {
    return {
      metadata,
      contentOmitted: true,
      note: `File is ${formatBytes(sizeBytes)} — exceeds the ${
        formatBytes(MAX_INLINE_READ_BYTES)
      } inline read limit. Metadata only.`,
    };
  }

  // Google Workspace formats need export.
  if (metadata.mimeType === GOOGLE_WORKSPACE_MIME_TYPES.DOCUMENT) {
    const exported = await exportWorkspaceFile(
      client,
      fileId,
      opts.exportMimeType ?? "text/plain",
    );
    return { metadata, content: exported };
  }
  if (metadata.mimeType === GOOGLE_WORKSPACE_MIME_TYPES.SPREADSHEET) {
    const exported = await exportWorkspaceFile(
      client,
      fileId,
      opts.exportMimeType ?? "text/csv",
    );
    return { metadata, content: exported };
  }
  if (metadata.mimeType === GOOGLE_WORKSPACE_MIME_TYPES.PRESENTATION) {
    // Slides export targets are PDF, PNG, JPEG, PPTX — all binary. Don't
    // attempt to surface bytes inline. Caller can use webViewLink.
    return {
      metadata,
      note:
        "Google Slides file — binary export formats (PDF/PPTX/PNG) only. Use the web view link.",
    };
  }

  // Regular file: fetch content via alt=media.
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  const response = await client.fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new GoogleApiError(
      `read ${response.status}: ${body}`,
      response.status,
      body,
    );
  }
  const content = await response.text();
  return { metadata, content };
}

/**
 * Create a text file with content. Uses multipart upload so name + content
 * land in one request.
 */
export async function createTextFile(
  client: GoogleClient,
  opts: CreateTextFileOptions,
): Promise<DriveFile> {
  const mimeType = opts.mimeType ?? "text/plain";
  const metadata: Record<string, unknown> = { name: opts.name, mimeType };
  if (opts.parentId) metadata.parents = [opts.parentId];
  if (opts.description) metadata.description = opts.description;

  // Two-step creation: first create the file with metadata only (simple
  // JSON POST, no multipart), then upload content via media upload.
  // Avoids multipart/related body construction issues entirely.
  const createUrl = new URL(`${DRIVE_API_BASE}/files`);
  createUrl.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,size,webViewLink,parents",
  );

  const created = await client.fetchJson<DriveFile>(createUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });

  // Upload content via raw fetch — bypass client.fetchJson to avoid
  // Content-Type interference when sending non-JSON bodies.
  if (opts.content) {
    const uploadUrl = `${DRIVE_UPLOAD_BASE}/files/${
      encodeURIComponent(created.id)
    }?uploadType=media&fields=id,name,mimeType,modifiedTime,size,webViewLink`;
    const token = await client.getAccessToken();
    const uploadResp = await fetch(uploadUrl, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: opts.content,
    });
    if (!uploadResp.ok) {
      const errBody = await uploadResp.text();
      throw new GoogleApiError(
        `upload ${uploadResp.status}: ${errBody}`,
        uploadResp.status,
        errBody,
      );
    }
    const uploaded = await uploadResp.json() as DriveFile;
    return { ...created, ...uploaded };
  }

  return created;
}

/**
 * Create a folder. Folders are files with mimeType
 * `application/vnd.google-apps.folder` and no content.
 */
export async function createFolder(
  client: GoogleClient,
  opts: CreateFolderOptions,
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = {
    name: opts.name,
    mimeType: GOOGLE_WORKSPACE_MIME_TYPES.FOLDER,
  };
  if (opts.parentId) metadata.parents = [opts.parentId];

  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set(
    "fields",
    "id,name,mimeType,modifiedTime,webViewLink,parents",
  );

  return await client.fetchJson<DriveFile>(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
}

/**
 * Update file metadata (name, description, parents). For content updates,
 * pass `content` — that's handled as a separate media upload.
 *
 * When both metadata and content are provided, we make two PATCH calls
 * (metadata first, then content). Drive's API doesn't have a single-call
 * "update both" path without multipart.
 */
export async function updateDriveFile(
  client: GoogleClient,
  fileId: string,
  opts: UpdateDriveFileOptions,
): Promise<DriveFile> {
  const metadataUpdate: Record<string, unknown> = {};
  if (opts.name !== undefined) metadataUpdate.name = opts.name;
  if (opts.description !== undefined) {
    metadataUpdate.description = opts.description;
  }

  const hasMetadata = Object.keys(metadataUpdate).length > 0;
  const hasParents = (opts.addParents && opts.addParents.length > 0) ||
    (opts.removeParents && opts.removeParents.length > 0);
  const hasContent = opts.content !== undefined;

  if (!hasMetadata && !hasParents && !hasContent) {
    throw new GoogleApiError(
      "updateDriveFile requires at least one of name, description, addParents, removeParents, or content",
      400,
    );
  }

  // Metadata + parents PATCH.
  if (hasMetadata || hasParents) {
    const url = new URL(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set(
      "fields",
      "id,name,mimeType,description,parents,modifiedTime,size,webViewLink,trashed",
    );
    if (opts.addParents && opts.addParents.length > 0) {
      url.searchParams.set("addParents", opts.addParents.join(","));
    }
    if (opts.removeParents && opts.removeParents.length > 0) {
      url.searchParams.set("removeParents", opts.removeParents.join(","));
    }
    await client.fetchJson<DriveFile>(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadataUpdate),
    });
  }

  // Content PATCH (media upload).
  if (hasContent) {
    const url = new URL(
      `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("uploadType", "media");
    url.searchParams.set(
      "fields",
      "id,name,mimeType,modifiedTime,size,webViewLink",
    );
    await client.fetchJson<DriveFile>(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "text/plain" },
      body: opts.content,
    });
  }

  // Return the final metadata.
  return await getDriveFile(client, fileId);
}

/**
 * Trash or permanently delete a file. Default is trash (recoverable);
 * pass `permanent: true` for irreversible deletion.
 */
export async function deleteDriveFile(
  client: GoogleClient,
  fileId: string,
  opts: { permanent?: boolean } = {},
): Promise<void> {
  if (opts.permanent) {
    const response = await client.fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 204) {
      const body = await response.text();
      throw new GoogleApiError(
        `delete ${response.status}: ${body}`,
        response.status,
        body,
      );
    }
    return;
  }
  // Trash: PATCH with trashed=true. Simpler than the dedicated trash endpoint.
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,trashed");
  await client.fetchJson<DriveFile>(url.toString(), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}

/**
 * Export a Google Workspace file (Docs/Sheets/Slides) to a target mimeType.
 * Returns the exported content as text. Throws for binary export mimeTypes
 * when the response isn't decodable as text.
 */
async function exportWorkspaceFile(
  client: GoogleClient,
  fileId: string,
  mimeType: string,
): Promise<string> {
  const url = new URL(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export`,
  );
  url.searchParams.set("mimeType", mimeType);
  const response = await client.fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new GoogleApiError(
      `export ${response.status}: ${body}`,
      response.status,
      body,
    );
  }
  return await response.text();
}

function escapeQueryString(s: string): string {
  // Drive query language uses single quotes for string literals; literal
  // single quotes inside are escaped as \\'.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export { formatBytes };
