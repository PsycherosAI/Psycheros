/**
 * Memory File Writer
 *
 * Utilities for memory content formatting and chat ID extraction.
 * Note: All file I/O has been removed — memories are stored in entity-core via MCP.
 * Only formatting helpers remain.
 */

/**
 * Extract chat IDs from memory content.
 * Looks for patterns like [chat:abc123] or [chat:abc123, def456]
 *
 * @param content - The memory content to parse
 * @returns Array of unique chat IDs
 */
export function extractChatIds(content: string): string[] {
  const chatIds = new Set<string>();

  // Match [chat:id] or [chat:id1, id2, ...]
  const chatPattern = /\[chat:([a-f0-9,\s]+)\]/gi;
  let match;

  while ((match = chatPattern.exec(content)) !== null) {
    // Split by comma and trim each ID
    const ids = match[1].split(",").map((id) => id.trim()).filter((id) =>
      id.length > 0
    );
    ids.forEach((id) => chatIds.add(id));
  }

  return Array.from(chatIds);
}

/**
 * Format memory file content with proper header and structure.
 *
 * @param title - The title for the memory
 * @param bulletPoints - Array of memory bullet points
 * @returns Formatted markdown content
 */
export function formatMemoryContent(
  title: string,
  bulletPoints: string[],
): string {
  const bulletList = bulletPoints.map((point) => `- ${point}`).join("\n");

  return `# ${title}

${bulletList}
`;
}
