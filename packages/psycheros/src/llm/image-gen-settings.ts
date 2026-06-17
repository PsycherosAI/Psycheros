/**
 * Image Generation Settings Persistence
 *
 * Manages loading and saving image generator configuration settings to disk.
 * Settings are stored in `.psycheros/image-gen-settings.json`.
 */

import { join } from "@std/path";
import { maskApiKey } from "./settings.ts";

// =============================================================================
// Types
// =============================================================================

export type ImageGenProvider =
  | "openrouter"
  | "gemini"
  | "venice"
  | "nanogpt"
  | "comfyui"
  | "native";

export interface OpenRouterImageSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface GeminiImageSettings {
  apiKey: string;
  model: string;
}

export interface VeniceImageSettings {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface NanoGPTImageSettings {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface ComfyUIImageSettings {
  serverUrl: string;
  workflow: string;
}

export interface NativeImageSettings {
  modelPath: string;
  backend: string;
}

export interface CommonImageGenParams {
  width: number;
  height: number;
  steps: number;
  negative_prompt: string;
  /** Aspect ratio for providers that support it (e.g. Gemini: "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9") */
  aspect_ratio?: string;
}

export interface ImageGenProviderSettings {
  openrouter?: OpenRouterImageSettings;
  gemini?: GeminiImageSettings;
  venice?: VeniceImageSettings;
  nanogpt?: NanoGPTImageSettings;
  comfyui?: ComfyUIImageSettings;
  native?: NativeImageSettings;
  params: CommonImageGenParams;
}

export interface ImageGenConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  nsfw: boolean;
  provider: ImageGenProvider;
  settings: ImageGenProviderSettings;
}

export interface ImageGenSettings {
  generators: ImageGenConfig[];
  captioning?: CaptioningSettings;
}

// =============================================================================
// Captioning Types
// =============================================================================

export type CaptioningProvider = "gemini" | "openrouter";

export interface CaptioningGeminiSettings {
  apiKey: string;
  model: string;
}

export interface CaptioningOpenRouterSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface CaptioningSettings {
  enabled: boolean;
  provider: CaptioningProvider;
  gemini?: CaptioningGeminiSettings;
  openrouter?: CaptioningOpenRouterSettings;
}

// =============================================================================
// Defaults
// =============================================================================

export function getDefaultImageGenSettings(): ImageGenSettings {
  return { generators: [] };
}

// =============================================================================
// Load / Save
// =============================================================================

export async function loadImageGenSettings(
  dataRoot: string,
): Promise<ImageGenSettings> {
  const defaults = getDefaultImageGenSettings();
  const settingsPath = join(
    dataRoot,
    ".psycheros",
    "image-gen-settings.json",
  );

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<ImageGenSettings>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export async function saveImageGenSettings(
  dataRoot: string,
  settings: ImageGenSettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "image-gen-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}

/**
 * Get a masked version of image gen settings for safe display.
 */
export function maskImageGenSettings(
  settings: ImageGenSettings,
): ImageGenSettings {
  return {
    ...settings,
    generators: settings.generators.map((g) => ({
      ...g,
      settings: {
        ...g.settings,
        openrouter: g.settings.openrouter
          ? {
            ...g.settings.openrouter,
            apiKey: maskApiKey(g.settings.openrouter.apiKey || ""),
          }
          : undefined,
        gemini: g.settings.gemini
          ? {
            ...g.settings.gemini,
            apiKey: maskApiKey(g.settings.gemini.apiKey || ""),
          }
          : undefined,
        venice: g.settings.venice
          ? {
            ...g.settings.venice,
            apiKey: maskApiKey(g.settings.venice.apiKey || ""),
          }
          : undefined,
        nanogpt: g.settings.nanogpt
          ? {
            ...g.settings.nanogpt,
            apiKey: maskApiKey(g.settings.nanogpt.apiKey || ""),
          }
          : undefined,
      },
    })),
    captioning: settings.captioning
      ? {
        ...settings.captioning,
        gemini: settings.captioning.gemini
          ? {
            ...settings.captioning.gemini,
            apiKey: maskApiKey(settings.captioning.gemini.apiKey || ""),
          }
          : undefined,
        openrouter: settings.captioning.openrouter
          ? {
            ...settings.captioning.openrouter,
            apiKey: maskApiKey(settings.captioning.openrouter.apiKey || ""),
          }
          : undefined,
      }
      : undefined,
  };
}
