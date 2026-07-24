/**
 * Look Closer Tool
 *
 * I use this to look more closely at an image and get a detailed description.
 * Useful when I need to recall details about a previously generated or shared image
 * that has faded from my context.
 */

import { join } from "@std/path";
import { getMediaType, uint8ToBase64 } from "./generate-image.ts";
import { captionImage } from "./describe-image.ts";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

export const lookCloserTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "look_closer",
      description:
        "I use this to look more closely at an image and get a detailed description of it. " +
        "Useful when I need to recall details about a previously generated or shared image " +
        "whose description has faded from context.",
      parameters: {
        type: "object",
        properties: {
          image_path: {
            type: "string",
            description:
              "Path to the image file relative to .psycheros/ (e.g. /generated-images/abc.png, /chat-attachments/def.jpg)",
          },
          instructions: {
            type: "string",
            description:
              "Optional specific guidance for how I want this image described — " +
              "a particular aspect to focus on, level of detail, or framing. " +
              "Omit for a general detailed description; use only when I have a specific need.",
          },
        },
        required: ["image_path"],
      },
    },
  },
  execute: executeLookCloser,
};

async function executeLookCloser(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { image_path, instructions } = args as {
    image_path: string;
    instructions?: string;
  };

  if (!image_path) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: image_path is required.",
      isError: true,
    };
  }

  const captioningSettings = ctx.config.imageGenSettings?.captioning;
  if (!captioningSettings?.provider) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: Image captioning is not configured.",
      isError: true,
    };
  }

  try {
    let resolvedPath = join(ctx.config.dataRoot, ".psycheros", image_path);

    // If no extension, try to find the actual file by prefix
    try {
      await Deno.stat(resolvedPath);
    } catch {
      const dir = join(ctx.config.dataRoot, ".psycheros", image_path)
        .replace(/[^/]+$/, "");
      const prefix = image_path.split("/").pop()!;
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (entry.name.startsWith(prefix)) {
            resolvedPath = join(dir, entry.name);
            break;
          }
        }
      } catch { /* dir doesn't exist */ }
    }

    const fileData = await Deno.readFile(resolvedPath);
    const base64 = uint8ToBase64(fileData);
    const mediaType = getMediaType(resolvedPath);
    const description = await captionImage(
      base64,
      mediaType,
      captioningSettings,
      instructions,
    );

    return {
      toolCallId: ctx.toolCallId,
      content: `Looked closer at ${image_path}: ${description}`,
      metadata: {
        fade: {
          replacementContent:
            `Looked closer at ${image_path}: [description faded — use look_closer again for details]`,
        },
      },
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Error looking closer at image: ${
        error instanceof Error ? error.message : String(error)
      }`,
      isError: true,
    };
  }
}
