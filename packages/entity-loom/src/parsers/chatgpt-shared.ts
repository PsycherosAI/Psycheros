/**
 * Entity Loom — ChatGPT Shared Types & Utilities
 *
 * Shared type definitions and helper functions used by both the official
 * OpenAI export parser and the 3rd-party plugin export parser.
 */

interface ChatGPTContentPart {
  content_type: string;
  text?: string;
  asset_pointer?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
}

export interface ChatGPTMessage {
  id: string;
  author: { role: string; name?: string; metadata?: Record<string, unknown> };
  content: {
    content_type: string;
    parts?: Array<string | ChatGPTContentPart>;
    [key: string]: unknown;
  };
  create_time: number | null;
  update_time: number | null;
  metadata?: {
    model_slug?: string;
    resolved_model_slug?: string;
    is_user_system_message?: boolean;
    is_visually_hidden_from_conversation?: boolean;
    conversation_id?: string;
    user_id?: string;
    parent_message_id?: string;
    [key: string]: unknown;
  };
  status?: string;
  end_turn?: boolean | null;
  weight?: number;
}

export interface ChatGPTNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

export interface ChatGPTConversation {
  title?: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, ChatGPTNode>;
  current_node: string;
  conversation_template?: string | null;
  conversation_mode?: Record<string, unknown> | null;
  gizmo_id?: string | null;
  is_archived?: boolean;
  id?: string;
  conversation_id?: string;
  default_model_slug?: string;
}

/**
 * Clamp a Unix timestamp to a reasonable range (2020–2030).
 * ChatGPT exports can contain corrupt timestamps (e.g., year 57374).
 */
export function clampTimestamp(unixTs: number): number {
  const MIN = 1577836800; // 2020-01-01 UTC
  const MAX = 1893456000; // 2030-01-01 UTC
  return Math.max(MIN, Math.min(MAX, unixTs));
}

/**
 * Walk the conversation tree from current_node to root,
 * collecting nodes in chronological order (oldest first).
 */
export function walkTree(
  mapping: Record<string, ChatGPTNode>,
  current_node: string,
): ChatGPTNode[] {
  const nodes: ChatGPTNode[] = [];
  let nodeId: string | null = current_node;

  while (nodeId) {
    const node: ChatGPTNode | undefined = mapping[nodeId];
    if (!node) break;
    if (node.message !== null) {
      nodes.unshift(node); // Build oldest-first
    }
    nodeId = node.parent;
  }

  return nodes;
}

/**
 * Extract text content from a ChatGPT message.
 * Handles multimodal content by replacing images with [image was here].
 */
export function extractText(msg: ChatGPTMessage): string {
  if (!msg.content?.parts) return "";

  const textParts: string[] = [];

  for (const part of msg.content.parts) {
    if (typeof part === "string") {
      textParts.push(part);
    } else if (part.content_type === "text" && part.text) {
      textParts.push(part.text);
    } else if (part.asset_pointer) {
      // Image or other media asset
      textParts.push("[image was here]");
    }
  }

  return textParts.join("\n");
}

/**
 * Extract thinking/reasoning content from a ChatGPT message.
 * o1/o3 models store reasoning as parts with content_type "thinking".
 */
export function extractThinking(msg: ChatGPTMessage): string {
  if (!msg.content?.parts) return "";

  const parts: string[] = [];
  for (const part of msg.content.parts) {
    if (
      typeof part !== "string" && part.content_type === "thinking" &&
      part.text
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/**
 * Extract system prompt text from a message.
 * Handles both standard parts-based format and GerTex's user_editable_context.
 */
export function extractSystemPromptText(msg: ChatGPTMessage): string {
  if (msg.content?.content_type === "user_editable_context") {
    const parts: string[] = [];
    const userInstructions = msg.content.user_instructions as
      | string
      | undefined;
    const userProfile = msg.content.user_profile as string | undefined;
    if (userProfile?.trim()) parts.push(userProfile.trim());
    if (userInstructions?.trim()) parts.push(userInstructions.trim());
    return parts.join("\n\n");
  }
  return extractText(msg);
}
