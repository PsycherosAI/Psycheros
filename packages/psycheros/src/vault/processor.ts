/**
 * Vault Document Processor
 *
 * Extracts text content from various file types for vault documents.
 * Supports: .md, .txt, .pdf, .docx, .xlsx
 */

import type { VaultFileType } from "./types.ts";

/**
 * Extract text content from a file based on its type.
 *
 * @param filePath - Path to the file on disk
 * @param fileType - The file type extension
 * @returns Extracted text content
 */
export async function extractText(
  filePath: string,
  fileType: VaultFileType,
): Promise<string> {
  switch (fileType) {
    case "md":
    case "txt":
      return await Deno.readTextFile(filePath);

    case "pdf":
      return await extractPdfText(filePath);

    case "docx":
      return await extractDocxText(filePath);

    case "xlsx":
      return await extractXlsxText(filePath);

    default:
      throw new Error(`Unsupported vault file type: ${fileType}`);
  }
}

/**
 * Determine the vault file type from a file's MIME type or name.
 */
export function resolveFileType(
  filename: string,
  mimeType?: string,
): VaultFileType | null {
  // Try MIME type first
  if (mimeType) {
    const { VAULT_MIME_TYPES } = requireTypes();
    const mapped = VAULT_MIME_TYPES[mimeType];
    if (mapped) return mapped;
  }

  // Fall back to extension
  const ext = filename.split(".").pop()?.toLowerCase();
  if (
    ext === "md" || ext === "txt" || ext === "pdf" || ext === "docx" ||
    ext === "xlsx"
  ) {
    return ext as VaultFileType;
  }

  return null;
}

/** Inline require to avoid top-level await issues */
function requireTypes() {
  // VAULT_MIME_TYPES is a compile-time constant, safe to reference directly
  return {
    VAULT_MIME_TYPES: {
      "text/markdown": "md",
      "text/plain": "txt",
      "application/pdf": "pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        "xlsx",
    } as Record<string, VaultFileType>,
  };
}

/**
 * Extract text from a PDF file using pdf-parse.
 */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const pdfParse = await importPdfParse();
    const buffer = await Deno.readFile(filePath);
    const result = await pdfParse(buffer);
    return result.text || "";
  } catch (error) {
    console.error("[Vault] Failed to extract PDF text:", error);
    throw new Error(
      `Failed to extract PDF text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Extract text from a DOCX file using mammoth.
 */
async function extractDocxText(filePath: string): Promise<string> {
  try {
    const mammoth = await importMammoth();
    const buffer = await Deno.readFile(filePath);
    const result = await mammoth.extractRawText({
      buffer: new Uint8Array(buffer),
    });
    return result.value || "";
  } catch (error) {
    console.error("[Vault] Failed to extract DOCX text:", error);
    throw new Error(
      `Failed to extract DOCX text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Extract text from an XLSX file using xlsx.
 */
async function extractXlsxText(filePath: string): Promise<string> {
  try {
    const xlsx = await importXlsx();
    const buffer = await Deno.readFile(filePath);
    const workbook = xlsx.read(buffer, { type: "buffer" });

    const sheets: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = xlsx.utils.sheet_to_csv(sheet);
      if (csv.trim()) {
        sheets.push(`## Sheet: ${sheetName}\n\n${csv}`);
      }
    }

    return sheets.join("\n\n");
  } catch (error) {
    console.error("[Vault] Failed to extract XLSX text:", error);
    throw new Error(
      `Failed to extract XLSX text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Dynamic import helpers — cached to avoid re-parsing the same module.

// deno-lint-ignore no-explicit-any
let pdfParseModule: any = null;
async function importPdfParse() {
  if (!pdfParseModule) {
    pdfParseModule = await import("pdf-parse");
  }
  return pdfParseModule.default || pdfParseModule;
}

// deno-lint-ignore no-explicit-any
let mammothModule: any = null;
async function importMammoth() {
  if (!mammothModule) {
    mammothModule = await import("mammoth");
  }
  return mammothModule.default || mammothModule;
}

// deno-lint-ignore no-explicit-any
let xlsxModule: any = null;
async function importXlsx() {
  if (!xlsxModule) {
    xlsxModule = await import("xlsx");
  }
  return xlsxModule.default || xlsxModule;
}
