/**
 * Entity Loom — Parser Interface
 *
 * Defines the contract that all platform parsers must implement.
 */

import type { ImportedConversation, PlatformType } from "../types.ts";

/**
 * Parser for a specific AI companion platform.
 *
 * Each parser takes a file path (or directory) and produces
 * a normalized array of ImportedConversation objects.
 */
export interface PlatformParser {
  /** The platform type this parser handles */
  readonly platform: PlatformType;

  /**
   * Detect if this parser can handle the given file.
   * Returns true if the file looks like it belongs to this platform.
   */
  detect(filePath: string): Promise<boolean>;

  /**
   * Parse the export file into normalized conversations.
   *
   * @param filePath - Path to the export file or directory
   * @returns Array of conversations with normalized messages
   */
  parse(filePath: string): Promise<ImportedConversation[]>;
}

/** Constructor type for platform parsers */
export type PlatformParserConstructor = new () => PlatformParser;
