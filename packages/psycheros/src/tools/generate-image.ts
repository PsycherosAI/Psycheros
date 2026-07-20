/**
 * Image Generation Tool Implementation
 *
 * I use this tool to generate images through configured providers
 * (OpenRouter, ComfyUI, or native). I choose the appropriate generator
 * based on context, and can include anchor images for style/character
 * consistency or user-uploaded images as references.
 */

import { join } from "@std/path";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { ImageGenConfig } from "../llm/image-gen-settings.ts";
import { captionImageDual } from "./describe-image.ts";
import { generateThumbnail } from "../utils/thumbnail.ts";

// =============================================================================
// Tool Definition
// =============================================================================

export const generateImageTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "I use this to generate an image or iterate on a previous one. I choose the appropriate generator_id " +
        "based on the user's request and available generators. I can include " +
        "anchor_images by ID as style/character references, user_image_path " +
        "if the user provided an image with their message, or input_image_path " +
        "with a path to a previously generated image for reference-based iteration. " +
        "Images I generate appear as actual images in the conversation automatically. " +
        "I do NOT output [IMAGE:] markers or image code in my text — I simply describe " +
        "or discuss the image naturally, and it will appear visually for the user.",
      parameters: {
        type: "object",
        properties: {
          generator_id: {
            type: "string",
            description:
              "The ID (not the display name) of the image generator to use. The ID is the alphanumeric string shown after 'ID:' in the generators list (e.g. 'a1b2c3d4').",
          },
          prompt: {
            type: "string",
            description:
              "The image generation prompt describing what I want to create",
          },
          negative_prompt: {
            type: "string",
            description:
              "Optional negative prompt — things I want to avoid in the image",
          },
          anchor_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of anchor image IDs to include as style/character references",
          },
          user_image_path: {
            type: "string",
            description:
              "Optional path to a user-uploaded image to use as reference",
          },
          input_image_path: {
            type: "string",
            description:
              "Optional path to an existing image to use as a starting reference for iteration/modification",
          },
          aspect_ratio: {
            type: "string",
            description:
              "Optional aspect ratio for the generated image. Supported values: '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '5:4', '4:5', '21:9'. If not provided, uses the generator's default.",
          },
        },
        required: ["generator_id", "prompt"],
      },
    },
  },
  execute,
};

// =============================================================================
// OpenRouter Provider
// =============================================================================

/**
 * OpenRouter model families that only emit image output. Requesting
 * `modalities: ["image", "text"]` against one of these fails on the provider
 * side (observed locally as a 404 for Flux). I match by substring on the model
 * id so vendor rebranding (e.g. `black-forest-labs/flux.2-max`) still hits.
 */
const OPENROUTER_IMAGE_ONLY_PATTERNS = [
  "black-forest-labs", // Flux
  "flux",
  "sourceful",
  "recraft",
  "mai-image", // Microsoft MAI Image
  "grok-imagine",
  "seedream",
];

export function isOpenRouterImageOnlyModel(model: string): boolean {
  const lower = model.toLowerCase();
  return OPENROUTER_IMAGE_ONLY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Normalize a user-pasted OpenRouter base URL. I strip trailing slashes and a
 * trailing `/chat/completions` so that pasting the full endpoint — a common
 * copy-paste mistake — does not double the path into
 * `…/chat/completions/chat/completions`.
 */
export function normalizeOpenRouterBaseUrl(raw: string): string {
  return raw.trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions\/?$/i, "");
}

/**
 * Extract image data from an OpenRouter chat completions response.
 * The response `content` may be:
 *   - An array of content parts: [{ type: "image_url", image_url: { url: "data:..." } }, ...]
 *   - A string containing a data URI or markdown image
 *   - A string with no image (error)
 */
function extractImageFromContent(
  content: unknown,
): { imageData: string; mediaType: string } {
  // Handle content as array of parts (standard for image-generating models)
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "image_url" && part.image_url?.url) {
        const url = part.image_url.url;
        // Base64 data URI
        const dataMatch = url.match(/^data:(image\/\w+);base64,(.+)$/);
        if (dataMatch) {
          return { imageData: dataMatch[2], mediaType: dataMatch[1] };
        }
        // Remote URL — download it
        // (handled after the loop below)
      }
      // Also handle inlineData (some providers return this format through OpenRouter)
      if (part?.inlineData && !part.thought) {
        return {
          imageData: (part.inlineData as { data: string }).data,
          mediaType: (part.inlineData as { mimeType?: string }).mimeType ||
            "image/png",
        };
      }
    }
    // If no base64 data URI found, check for remote URLs in image_url parts
    for (const part of content) {
      if (part?.type === "image_url" && part.image_url?.url) {
        const url = String(part.image_url.url);
        if (url.startsWith("http")) {
          // Return a marker that the caller should fetch
          throw new Error(`OpenRouter returned a remote image URL: ${url}`);
        }
      }
    }
    throw new Error("OpenRouter response content array contained no image");
  }

  // Handle content as string
  if (typeof content === "string") {
    // Check for base64 data URI
    const base64Match = content.match(
      /data:image\/(\w+);base64,([A-Za-z0-9+/=]+)/,
    );
    if (base64Match) {
      return {
        imageData: base64Match[2],
        mediaType: `image/${base64Match[1]}`,
      };
    }
    // Check for markdown image syntax
    const urlMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
    if (urlMatch) {
      throw new Error(`OpenRouter returned a remote image URL: ${urlMatch[1]}`);
    }
    throw new Error("OpenRouter response text did not contain an image");
  }

  throw new Error("OpenRouter returned no content in the response");
}

async function generateViaOpenRouter(
  config: ImageGenConfig,
  prompt: string,
  negativePrompt: string | undefined,
  anchorImages: Array<{ data: string; mediaType: string }>,
  userImage: { data: string; mediaType: string } | undefined,
  inputImage: { data: string; mediaType: string } | undefined,
): Promise<{ imageData: string; mediaType: string }> {
  const settings = config.settings.openrouter;
  if (!settings) {
    throw new Error("OpenRouter settings not configured for this generator");
  }

  const baseUrl = normalizeOpenRouterBaseUrl(
    settings.baseUrl || "https://openrouter.ai/api/v1",
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${sanitizeHeaderValue(settings.apiKey)}`,
  };

  // Build user message content — include reference images inline
  const messageContent: Array<
    { type: string; text?: string; image_url?: { url: string } }
  > = [];

  for (const img of anchorImages) {
    messageContent.push({
      type: "image_url",
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    });
  }

  if (userImage) {
    messageContent.push({
      type: "image_url",
      image_url: {
        url: `data:${userImage.mediaType};base64,${userImage.data}`,
      },
    });
  }

  if (inputImage) {
    messageContent.push({
      type: "image_url",
      image_url: {
        url: `data:${inputImage.mediaType};base64,${inputImage.data}`,
      },
    });
  }

  // Build text part — fold in negative prompt if present
  let textPrompt = prompt;
  if (negativePrompt) {
    textPrompt += `\n\nStyle requirements: avoid ${negativePrompt}.`;
  }
  messageContent.push({ type: "text", text: textPrompt });

  const params = config.settings.params;
  const aspectRatio = params.aspect_ratio ||
    mapToAspectRatio(params.width, params.height);
  const imageSize = mapToImageSize(params.width);

  const imageConfig: Record<string, string> = {
    aspect_ratio: aspectRatio,
  };
  if (imageSize !== "1K") {
    imageConfig.image_size = imageSize;
  }

  const modalities = isOpenRouterImageOnlyModel(settings.model)
    ? ["image"]
    : ["image", "text"];

  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [{ role: "user", content: messageContent }],
    modalities,
    image_config: imageConfig,
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  const chatData = await response.json() as Record<string, unknown>;

  const choices = chatData.choices as
    | Array<Record<string, unknown>>
    | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;

  // OpenRouter returns images in message.images[] (not message.content)
  // Format: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }]
  const images = message?.images as Array<Record<string, unknown>> | undefined;
  if (images && images.length > 0) {
    const imgUrl = images[0]?.image_url as Record<string, string> | undefined;
    if (imgUrl?.url) {
      const url = imgUrl.url;
      const dataMatch = url.match(/^data:(image\/\w+);base64,(.+)$/);
      if (dataMatch) {
        return { imageData: dataMatch[2], mediaType: dataMatch[1] };
      }
      if (url.startsWith("http")) {
        const imgResponse = await fetch(url);
        if (imgResponse.ok) {
          const buffer = await imgResponse.arrayBuffer();
          const base64 = uint8ToBase64(new Uint8Array(buffer));
          const contentType = imgResponse.headers.get("content-type") ||
            "image/png";
          return { imageData: base64, mediaType: contentType };
        }
      }
    }
  }

  // Fallback: check message.content (some models/providers may return it there)
  const content = message?.content;

  // Log what we received for debugging when image extraction fails
  console.error(
    `[ImageGen] OpenRouter: no image in message.images[]. ` +
      `content type=${typeof content}, hasImages=${
        !!images && images.length > 0
      }. ` +
      `message keys=${message ? Object.keys(message).join(",") : "undefined"}`,
  );
  if (typeof content === "string") {
    console.error(
      `[ImageGen] OpenRouter content (first 200 chars): ${
        content.slice(0, 200)
      }`,
    );
  }

  try {
    return extractImageFromContent(content);
  } catch (err) {
    // If the error message contains a remote URL, try to download it
    const urlMatch = err instanceof Error &&
      err.message.match(/remote image URL: (https?:\/\/[^\s]+)/);
    if (urlMatch) {
      const imgResponse = await fetch(urlMatch[1]);
      if (imgResponse.ok) {
        const buffer = await imgResponse.arrayBuffer();
        const base64 = uint8ToBase64(new Uint8Array(buffer));
        const contentType = imgResponse.headers.get("content-type") ||
          "image/png";
        return { imageData: base64, mediaType: contentType };
      }
    }
    throw err;
  }
}

// =============================================================================
// Gemini Provider
// =============================================================================

/**
 * Map width/height to the closest supported Gemini aspect ratio string.
 * Returns "1:1" if no close match is found.
 */
function mapToAspectRatio(width: number, height: number): string {
  const ratio = width / height;
  const candidates: Array<{ ratio: number; label: string }> = [
    { ratio: 1, label: "1:1" },
    { ratio: 4 / 3, label: "4:3" },
    { ratio: 3 / 4, label: "3:4" },
    { ratio: 3 / 2, label: "3:2" },
    { ratio: 2 / 3, label: "2:3" },
    { ratio: 16 / 9, label: "16:9" },
    { ratio: 9 / 16, label: "9:16" },
    { ratio: 5 / 4, label: "5:4" },
    { ratio: 4 / 5, label: "4:5" },
    { ratio: 21 / 9, label: "21:9" },
  ];
  let best = candidates[0];
  let bestDiff = Math.abs(ratio - best.ratio);
  for (const c of candidates) {
    const diff = Math.abs(ratio - c.ratio);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best.label;
}

/**
 * Derive imageSize from the configured width (Gemini uses "1K", "2K", "4K" tokens).
 */
function mapToImageSize(width: number): string {
  if (width >= 4096) return "4K";
  if (width >= 2048) return "2K";
  return "1K"; // default
}

async function generateViaGemini(
  config: ImageGenConfig,
  prompt: string,
  negativePrompt: string | undefined,
  anchorImages: Array<{ data: string; mediaType: string }>,
  userImage: { data: string; mediaType: string } | undefined,
  inputImage: { data: string; mediaType: string } | undefined,
): Promise<{ imageData: string; mediaType: string }> {
  const settings = config.settings.gemini;
  if (!settings) {
    throw new Error("Gemini settings not configured for this generator");
  }

  const model = settings.model || "gemini-2.0-flash-exp-image-generation";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Build parts — text prompt + reference images
  const parts: Array<
    { text: string } | { inline_data: { mime_type: string; data: string } }
  > = [];

  // If there's a negative prompt, fold it into the prompt semantically
  // (Gemini doesn't have a negative prompt parameter)
  let fullPrompt = prompt;
  if (negativePrompt) {
    fullPrompt += `\n\nStyle requirements: avoid ${negativePrompt}.`;
  }
  parts.push({ text: fullPrompt });

  // Add anchor images as inline_data references
  for (const img of anchorImages) {
    parts.push({
      inline_data: {
        mime_type: img.mediaType,
        data: img.data,
      },
    });
  }

  // Add user-uploaded image as inline_data reference
  if (userImage) {
    parts.push({
      inline_data: {
        mime_type: userImage.mediaType,
        data: userImage.data,
      },
    });
  }

  // Add input image for iteration as inline_data reference
  if (inputImage) {
    parts.push({
      inline_data: {
        mime_type: inputImage.mediaType,
        data: inputImage.data,
      },
    });
  }

  // Build generation config
  const params = config.settings.params;
  const aspectRatio = params.aspect_ratio ||
    mapToAspectRatio(params.width, params.height);
  const imageSize = mapToImageSize(params.width);

  const body: Record<string, unknown> = {
    contents: [{
      role: "user",
      parts,
    }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: aspectRatio,
        imageSize: imageSize,
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": sanitizeHeaderValue(settings.apiKey),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<Record<string, unknown>>;
      };
      finishReason?: string;
    }>;
  };

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error("Gemini returned no candidates in the response");
  }

  // Find the first non-thought image part
  // Gemini response uses camelCase: inlineData, mimeType
  for (const candidate of data.candidates) {
    if (!candidate.content?.parts) continue;
    for (const part of candidate.content.parts) {
      const isThought = (part.thought as boolean) ?? false;
      // Try camelCase first (Gemini standard), then snake_case
      const inlineData = (part.inlineData ?? part.inline_data) as {
        mimeType?: string;
        data: string;
      } | undefined;
      if (inlineData && !isThought) {
        return {
          imageData: inlineData.data,
          mediaType: inlineData.mimeType || "image/png",
        };
      }
    }
  }

  throw new Error("Gemini response did not contain a generated image");
}

// =============================================================================
// Venice AI Provider
// =============================================================================

/**
 * I use Venice's native /image/generate endpoint. Venice's inpaint parameter
 * was deprecated on May 19, 2025 and the OpenAI-compatible /images/generations
 * endpoint does not accept image input, so this path is text-to-image only.
 * Anchor/user/input images are dropped here; the execute() function appends a
 * note to the tool result so I learn to pick a different generator when I
 * need image references.
 */
async function generateViaVenice(
  config: ImageGenConfig,
  prompt: string,
  negativePrompt: string | undefined,
): Promise<{ imageData: string; mediaType: string }> {
  const settings = config.settings.venice;
  if (!settings) {
    throw new Error("Venice settings not configured for this generator");
  }

  const baseUrl = (settings.baseUrl || "https://api.venice.ai/api/v1").trim()
    .replace(/\/+$/, "");

  const params = config.settings.params;
  const aspectRatio = params.aspect_ratio ||
    mapToAspectRatio(params.width, params.height);

  const body: Record<string, unknown> = {
    model: settings.model,
    prompt,
    aspect_ratio: aspectRatio,
    format: "png",
    safe_mode: !config.nsfw,
  };
  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }

  const response = await fetch(`${baseUrl}/image/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sanitizeHeaderValue(settings.apiKey)}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Venice API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { images?: string[] };
  if (!data.images || data.images.length === 0) {
    throw new Error("Venice returned no images in the response");
  }

  return {
    imageData: data.images[0],
    mediaType: "image/png",
  };
}

// =============================================================================
// NanoGPT Provider
// =============================================================================

/**
 * Map an aspect ratio string to a WIDTHxHEIGHT size token for NanoGPT's
 * OpenAI-compatible /images/generations endpoint. Defaults to 1024x1024.
 */
function mapAspectRatioToSize(aspectRatio: string | undefined): string {
  switch (aspectRatio) {
    case "16:9":
      return "1024x576";
    case "9:16":
      return "576x1024";
    case "4:3":
      return "1024x768";
    case "3:4":
      return "768x1024";
    case "3:2":
      return "1024x683";
    case "2:3":
      return "683x1024";
    case "5:4":
      return "1024x819";
    case "4:5":
      return "819x1024";
    case "21:9":
      return "1024x439";
    case "1:1":
    default:
      return "1024x1024";
  }
}

/**
 * I use NanoGPT's OpenAI-compatible /images/generations endpoint. Supports
 * image-to-image via imageDataUrl (single image) or imageDataUrls (multiple —
 * model-dependent, e.g. flux-kontext, gpt-4o-image, gpt-image-1).
 */
async function generateViaNanoGPT(
  config: ImageGenConfig,
  prompt: string,
  negativePrompt: string | undefined,
  anchorImages: Array<{ data: string; mediaType: string }>,
  userImage: { data: string; mediaType: string } | undefined,
  inputImage: { data: string; mediaType: string } | undefined,
): Promise<{ imageData: string; mediaType: string }> {
  const settings = config.settings.nanogpt;
  if (!settings) {
    throw new Error("NanoGPT settings not configured for this generator");
  }

  const baseUrl = (settings.baseUrl || "https://nano-gpt.com/v1").trim()
    .replace(/\/+$/, "");

  // Combine every input image. The endpoint takes one (imageDataUrl) or many
  // (imageDataUrls); model support for plural varies.
  const allImages = [
    ...anchorImages,
    ...(userImage ? [userImage] : []),
    ...(inputImage ? [inputImage] : []),
  ];

  const params = config.settings.params;
  const size = mapAspectRatioToSize(params.aspect_ratio);

  // The OpenAI-compatible spec has no negative_prompt field — fold it in.
  let fullPrompt = prompt;
  if (negativePrompt) {
    fullPrompt += `\n\nAvoid: ${negativePrompt}.`;
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    prompt: fullPrompt,
    n: 1,
    size,
  };

  if (allImages.length === 1) {
    body.imageDataUrl = `data:${allImages[0].mediaType};base64,${
      allImages[0].data
    }`;
  } else if (allImages.length > 1) {
    body.imageDataUrls = allImages.map((img) =>
      `data:${img.mediaType};base64,${img.data}`
    );
  }

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sanitizeHeaderValue(settings.apiKey)}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NanoGPT API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  const first = data.data?.[0];
  if (!first) {
    throw new Error("NanoGPT returned no data in the response");
  }

  if (first.b64_json) {
    return {
      imageData: first.b64_json,
      mediaType: "image/png",
    };
  }

  if (first.url) {
    // Hosted URL — download and inline. Presigned URLs expire (~1h).
    const imgResponse = await fetch(first.url);
    if (!imgResponse.ok) {
      throw new Error(
        `NanoGPT returned URL but download failed (${imgResponse.status})`,
      );
    }
    const buffer = await imgResponse.arrayBuffer();
    const base64 = uint8ToBase64(new Uint8Array(buffer));
    const contentType = imgResponse.headers.get("content-type") || "image/png";
    return { imageData: base64, mediaType: contentType };
  }

  throw new Error("NanoGPT response did not contain b64_json or url");
}

// =============================================================================
// Tool Executor
// =============================================================================

async function execute(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const {
    generator_id,
    prompt,
    negative_prompt,
    anchor_ids,
    user_image_path,
    input_image_path,
    aspect_ratio,
  } = args as {
    generator_id: string;
    prompt: string;
    negative_prompt?: string;
    anchor_ids?: string[];
    user_image_path?: string;
    input_image_path?: string;
    aspect_ratio?: string;
  };

  // Get image gen settings from config
  const settings = ctx.config.imageGenSettings;
  if (!settings) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        "Error: Image generation is not configured. No image generators available.",
      isError: true,
    };
  }

  // Find the generator
  const generator = settings.generators.find((g) => g.id === generator_id);
  if (!generator) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `Error: Generator '${generator_id}' not found. Available generators: ${
          settings.generators.map((g) => g.id).join(", ") || "(none)"
        }`,
      isError: true,
    };
  }

  if (!generator.enabled) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `Error: Generator '${generator.name}' (${generator_id}) is disabled.`,
      isError: true,
    };
  }

  const dataRoot = ctx.config.dataRoot;

  // Load anchor images if provided
  const anchorImages: Array<{ data: string; mediaType: string }> = [];
  if (anchor_ids && anchor_ids.length > 0) {
    for (const anchorId of anchor_ids) {
      try {
        const row = ctx.db.getRawDb()
          .prepare("SELECT filename FROM anchor_images WHERE id = ?")
          .get<{ filename: string }>(anchorId);
        if (!row) {
          return {
            toolCallId: ctx.toolCallId,
            content: `Error: Anchor image '${anchorId}' not found in database.`,
            isError: true,
          };
        }
        const filePath = join(
          dataRoot,
          ".psycheros",
          "anchors",
          row.filename,
        );
        const fileData = await Deno.readFile(filePath);
        const base64 = uint8ToBase64(fileData);
        const mediaType = getMediaType(row.filename);
        anchorImages.push({ data: base64, mediaType });
      } catch (error) {
        return {
          toolCallId: ctx.toolCallId,
          content: `Error: Failed to read anchor image '${anchorId}': ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
        };
      }
    }
  }

  // Load user-uploaded image if provided
  let userImage: { data: string; mediaType: string } | undefined;
  if (user_image_path) {
    try {
      // user_image_path is relative to .psycheros/
      const filePath = join(dataRoot, ".psycheros", user_image_path);
      const fileData = await Deno.readFile(filePath);
      const base64 = uint8ToBase64(fileData);
      const mediaType = getMediaType(user_image_path);
      userImage = { data: base64, mediaType };
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: Failed to read user image '${user_image_path}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }

  // Load input image for iteration if provided
  let inputImage: { data: string; mediaType: string } | undefined;
  if (input_image_path) {
    try {
      const filePath = join(dataRoot, ".psycheros", input_image_path);
      const fileData = await Deno.readFile(filePath);
      const base64 = uint8ToBase64(fileData);
      const mediaType = getMediaType(input_image_path);
      inputImage = { data: base64, mediaType };
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: Failed to read input image '${input_image_path}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  }

  try {
    // Apply per-call aspect ratio override if provided
    if (aspect_ratio) {
      generator.settings.params.aspect_ratio = aspect_ratio;
    }

    let result: { imageData: string; mediaType: string };

    // Venice drops image references (inpaint deprecated May 2025). I track
    // whether any were provided so I can note it in the tool result.
    const veniceDroppedImages = generator.provider === "venice" &&
      (anchorImages.length > 0 || userImage || inputImage);

    switch (generator.provider) {
      case "openrouter":
        result = await generateViaOpenRouter(
          generator,
          prompt,
          negative_prompt,
          anchorImages,
          userImage,
          inputImage,
        );
        break;
      case "gemini":
        result = await generateViaGemini(
          generator,
          prompt,
          negative_prompt,
          anchorImages,
          userImage,
          inputImage,
        );
        break;
      case "venice":
        result = await generateViaVenice(
          generator,
          prompt,
          negative_prompt,
        );
        break;
      case "nanogpt":
        result = await generateViaNanoGPT(
          generator,
          prompt,
          negative_prompt,
          anchorImages,
          userImage,
          inputImage,
        );
        break;
      case "comfyui":
        return {
          toolCallId: ctx.toolCallId,
          content: "Error: ComfyUI provider is not yet implemented.",
          isError: true,
        };
      case "native":
        return {
          toolCallId: ctx.toolCallId,
          content:
            "Error: Native image generation provider is not yet implemented.",
          isError: true,
        };
      default:
        return {
          toolCallId: ctx.toolCallId,
          content: `Error: Unknown provider '${generator.provider}'.`,
          isError: true,
        };
    }

    // Save the generated image to disk
    const ext = getExtensionFromMediaType(result.mediaType);
    const filename = `${crypto.randomUUID()}.${ext}`;
    const generatedDir = join(dataRoot, ".psycheros", "generated-images");
    await Deno.mkdir(generatedDir, { recursive: true });
    const filePath = join(generatedDir, filename);
    const imageBytes = Uint8Array.from(
      atob(result.imageData),
      (c) => c.charCodeAt(0),
    );
    await Deno.writeFile(filePath, imageBytes);

    try {
      await generateThumbnail(
        filePath,
        join(generatedDir, "thumbs", `${filename}.webp`),
      );
    } catch (thumbError) {
      console.warn("[ImageGen] Thumbnail generation failed:", thumbError);
    }

    // Auto-caption the generated image if captioning is configured
    let description: string | undefined;
    let shortDescription: string | undefined;
    const captioningSettings = ctx.config.imageGenSettings?.captioning;
    if (captioningSettings?.provider) {
      try {
        const caption = await captionImageDual(
          result.imageData,
          result.mediaType,
          captioningSettings,
        );
        description = caption.long;
        shortDescription = caption.short;
      } catch (captionError) {
        console.error("[ImageGen] Auto-captioning failed:", captionError);
      }
    }

    // Build the image sidecar — the canonical structured source for the
    // generated image. The loop persists it as `metadata.image` on the tool
    // message row, the tool-card UI renders from it directly, and the
    // in-memory fader rewrites `description` → `shortDescription` after
    // IMAGE_DESCRIPTION_FADE_TURNS.
    const imagePath = `/generated-images/${filename}`;
    const relativeFilePath = `generated-images/${filename}`;
    const imageSidecar: NonNullable<
      NonNullable<ToolResult["metadata"]>["image"]
    > = {
      path: imagePath,
      filePath: relativeFilePath,
      prompt,
      generatorName: generator.name,
    };
    if (description) imageSidecar.description = description;
    if (shortDescription) imageSidecar.shortDescription = shortDescription;

    // LLM-visible content text. Plain prose, no `[image_generated]` prefix
    // (hallucination trigger), no `[IMAGE:...]` marker (UI-only metadata
    // that lived here historically), no `[short:...]` suffix (the short
    // description lives in the sidecar now). The file path is spelled out
    // verbatim so the model can pass it through unchanged to tools like
    // send_discord_dm that need it.
    let resultText = "Image generated successfully.";
    if (description) resultText += ` ${description}`;
    resultText +=
      `\n\nFile path (use verbatim for send_discord_dm image_path argument): ${relativeFilePath}`;

    if (veniceDroppedImages) {
      resultText +=
        "\n\nNote: Venice AI does not currently support image input " +
        "(inpaint was deprecated May 2025). The request was processed as " +
        "text-to-image only; provided anchor_ids, user_image_path, and " +
        "input_image_path were ignored. If image-reference-based generation " +
        "is needed, choose a different generator.";
    }

    return {
      toolCallId: ctx.toolCallId,
      content: resultText,
      metadata: { image: imageSidecar },
    };
  } catch (error) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Error generating image: ${
        error instanceof Error ? error.message : String(error)
      }`,
      isError: true,
    };
  }
}

// =============================================================================
// Helpers (exported for reuse by captioning)
// =============================================================================

/**
 * Ensure a string is valid for use as an HTTP header value.
 * Strips characters outside the Latin-1 range (code points > 255) that cause
 * "headers of RequestInit is not valid ByteString" Fetch API errors.
 * Also strips control characters that shouldn't appear in header values.
 * This typically catches invisible Unicode characters (zero-width spaces, BOM, etc.)
 * that get accidentally pasted in when copying API keys.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E\x80-\xFF]/g, "");
}

/**
 * Encode a Uint8Array to base64 without blowing the call stack.
 * btoa(String.fromCharCode(...largeArray)) exceeds max call stack size
 * because spread passes each element as a separate argument.
 */
export function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function getMediaType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function getExtensionFromMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}
