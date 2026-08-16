import sharp from "sharp";
import type {
  DiscordPluginHostServices,
  DiscordPreparedImage,
  ServiceReadiness,
} from "../../../plugin-api/src/mod.ts";
import type { ImageGenSettings } from "../llm/image-gen-settings.ts";
import type { DiscordSettings } from "../llm/discord-settings.ts";
import type { VoiceProfile, VoiceSettings } from "../llm/voice-settings.ts";
import type { GifPickerService } from "../media/gif-picker.ts";
import { generateImageWithConfig } from "../tools/generate-image.ts";
import { transcribeEncodedAudio } from "../voice/stt.ts";
import { synthesizeElevenLabsOgg } from "../voice/tts.ts";
import { discordNonce, inspectOggOpus } from "./voice-message.ts";
import type { DiscordPluginHost } from "./plugin-host.ts";

const SAFE_MEDIA_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
  "media.tenor.com",
  "c.tenor.com",
]);
const STATIC_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5_999_900;
const MAX_DISCORD_UPLOAD_BYTES = 10 * 1024 * 1024;
const MEDIA_TTL_MS = 5 * 60 * 1000;

interface StoredOutgoingMedia {
  bytes: Uint8Array;
  mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  filename: string;
  provider: string;
  publicUrl?: string;
  expiresAt: number;
}

export interface DiscordPluginServiceConfig {
  host: DiscordPluginHost;
  getDiscordSettings(): DiscordSettings;
  getImageGenSettings(): ImageGenSettings;
  getVoiceSettings(): VoiceSettings;
  gifPicker: GifPickerService;
  fetcher?: typeof fetch;
  generateImage?: typeof generateImageWithConfig;
}

export function createDiscordPluginServices(
  config: DiscordPluginServiceConfig,
): DiscordPluginHostServices {
  const fetcher = config.fetcher ?? fetch;
  const generateImage = config.generateImage ?? generateImageWithConfig;
  const storedMedia = new Map<string, StoredOutgoingMedia>();
  const deliveries = new Map<
    string,
    Promise<{ kind: "media" | "text_fallback"; messageId?: string }>
  >();
  const voiceDeliveries = new Map<
    string,
    Promise<{ kind: "voice" | "text_fallback" }>
  >();
  const activeVoiceProfile = (): VoiceProfile | undefined => {
    const settings = config.getVoiceSettings();
    return settings.enabled
      ? settings.profiles.find((profile) =>
        profile.id === settings.activeProfileId && profile.enabled
      )
      : undefined;
  };

  return {
    readiness: {
      discord: () => discordReadiness(config.getDiscordSettings()),
      vision: () => visionReadiness(config.getImageGenSettings()),
      stt: () => sttReadiness(activeVoiceProfile()),
      tts: () => ttsReadiness(activeVoiceProfile()),
      gifSearch: () => gifReadiness(config.gifPicker),
      imageGeneration: () =>
        imageGenerationReadiness(config.getImageGenSettings()),
    },
    events: {
      subscribe: (types, handler) => config.host.subscribe(types, handler),
    },
    mediaPipeline: {
      claim: (owner = "plugin") => config.host.claimMediaPipeline(owner),
      release: (owner = "plugin") => {
        const owned = config.host.getMediaPipelineOwner() === owner;
        config.host.releaseMediaPipeline(owner);
        if (owned) storedMedia.clear();
      },
      owner: () =>
        config.host.getMediaPipelineOwner() === "legacy-core"
          ? "legacy-core"
          : "plugin",
    },
    media: {
      async fetch(reference, options) {
        const source = config.host.resolveMediaReference(reference);
        if (!source) {
          throw new Error("media reference is unavailable or expired");
        }
        assertSafeUrl(source);
        const response = await fetcher(source, {
          redirect: "follow",
          signal: options.signal ??
            AbortSignal.timeout(Math.min(options.timeoutMs, 60_000)),
        });
        if (response.url) assertSafeUrl(response.url);
        if (!response.ok) {
          throw new Error(`media download returned HTTP ${response.status}`);
        }
        const bytes = await readLimited(
          response,
          Math.min(options.maxBytes, MAX_VOICE_BYTES),
        );
        return {
          bytes,
          mediaType: normalizeType(response.headers.get("content-type") ?? ""),
        };
      },
      async prepareImage(bytes, declaredType) {
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new Error("image exceeds the configured safety limit");
        }
        const metadata = await sharp(bytes).metadata();
        const mediaType = detectedImageType(metadata.format);
        if (
          !mediaType ||
          (declaredType && !STATIC_TYPES.has(normalizeType(declaredType)))
        ) {
          throw new Error("image format is unsupported");
        }
        return toDataUrl(bytes, mediaType);
      },
      async extractAnimatedFrames(bytes, options) {
        const metadata = await sharp(bytes, { animated: true }).metadata();
        const pages = metadata.pages ?? 1;
        const count = Math.min(4, Math.max(0, options.maxFrames), pages);
        const decodedLimit = Math.min(
          MAX_IMAGE_BYTES,
          options.maxDecodedBytes,
        );
        const indexes = count <= 1
          ? (count === 1 ? [0] : [])
          : Array.from({ length: count }, (_, index) =>
            Math.round(index * (pages - 1) / (count - 1)));
        const output: DiscordPreparedImage[] = [];
        for (const page of indexes) {
          const frame = await sharp(bytes, { animated: true, page, pages: 1 })
            .webp().toBuffer();
          if (frame.byteLength > decodedLimit) {
            throw new Error(
              "decoded image exceeds the configured safety limit",
            );
          }
          output.push(toDataUrl(frame, "image/webp"));
        }
        return output;
      },
    },
    voice: {
      async transcribeEncoded(audio, input) {
        const profile = activeVoiceProfile();
        if (!profile || profile.providerSettings.stt.provider === "browser") {
          throw new Error(
            "my active server speech-recognition profile is unavailable",
          );
        }
        return await transcribeEncodedAudio(
          audio,
          { mediaType: input.mediaType, filename: input.filename },
          profile,
          { signal: input.signal },
        );
      },
      async synthesizeEncoded(text, input) {
        if (input.signal?.aborted) throw input.signal.reason;
        const profile = activeVoiceProfile();
        const settings = profile?.providerSettings.tts.provider === "elevenlabs"
          ? profile.providerSettings.tts.elevenlabs
          : undefined;
        if (!settings) {
          throw new Error("my active ElevenLabs voice is unavailable");
        }
        return await synthesizeElevenLabsOgg(text, settings, fetcher);
      },
    },
    transport: {
      sendNativeVoiceMessage(input) {
        const key = `${input.channelId}:${input.toolCallId}`;
        const existing = voiceDeliveries.get(key);
        if (existing) return existing;
        const delivery = (async () => {
          const discord = config.getDiscordSettings();
          if (!discord.gatewayEnabled || !discord.botToken) {
            throw new Error("my Discord connection is unavailable");
          }
          if (input.audio.byteLength > MAX_VOICE_BYTES) {
            throw new Error("voice message exceeds Discord's upload limit");
          }
          const metadata = inspectOggOpus(input.audio);
          const payload: Record<string, unknown> = {
            flags: 1 << 13,
            nonce: discordNonce(input.toolCallId),
            enforce_nonce: true,
            attachments: [{
              id: "0",
              filename: "voice-message.ogg",
              duration_secs: metadata.durationSecs,
              waveform: metadata.waveform,
            }],
          };
          if (input.replyToMessageId) {
            payload.message_reference = {
              message_id: input.replyToMessageId,
              channel_id: input.channelId,
            };
          }
          const form = new FormData();
          form.set("payload_json", JSON.stringify(payload));
          form.set(
            "files[0]",
            new Blob([copyBuffer(input.audio)], { type: "audio/ogg" }),
            "voice-message.ogg",
          );
          const url =
            `https://discord.com/api/v10/channels/${input.channelId}/messages`;
          const response = await fetcher(url, {
            method: "POST",
            headers: { Authorization: `Bot ${discord.botToken}` },
            body: form,
          });
          if (response.ok) return { kind: "voice" as const };

          const fallbackPayload: Record<string, unknown> = {
            content: input.fallbackText.slice(0, 2000),
            nonce: discordNonce(input.toolCallId, "f"),
            enforce_nonce: true,
          };
          if (input.replyToMessageId) {
            fallbackPayload.message_reference = {
              message_id: input.replyToMessageId,
              channel_id: input.channelId,
            };
          }
          const fallback = await fetcher(url, {
            method: "POST",
            headers: {
              Authorization: `Bot ${discord.botToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(fallbackPayload),
          });
          if (!fallback.ok) {
            throw new Error(
              `Discord delivery failed with HTTP ${fallback.status}`,
            );
          }
          return { kind: "text_fallback" as const };
        })();
        voiceDeliveries.set(key, delivery);
        while (voiceDeliveries.size > 512) {
          voiceDeliveries.delete(voiceDeliveries.keys().next().value!);
        }
        return delivery;
      },
    },
    outgoingMedia: {
      async searchGifs(query) {
        return (await config.gifPicker.search(query)).map((candidate) => ({
          selectionReference: candidate.token,
          title: candidate.title,
          width: candidate.width,
          height: candidate.height,
        }));
      },
      async retrieveGif(selectionReference) {
        const media = await config.gifPicker.retrieve(selectionReference);
        const reference = rememberOutgoingMedia(storedMedia, {
          ...media,
          provider: "giphy",
          expiresAt: Date.now() + MEDIA_TTL_MS,
        });
        return { mediaReference: reference };
      },
      async generateImage(input) {
        const settings = config.getImageGenSettings();
        const generator = input.generatorId
          ? settings.generators.find((item) => item.id === input.generatorId)
          : settings.generators.find((item) => item.enabled);
        if (!generator?.enabled || !imageGeneratorConfigured(generator)) {
          throw new Error("my configured image generator is unavailable");
        }
        let generated: { imageData: string; mediaType: string };
        try {
          generated = await generateImage(generator, {
            prompt: input.prompt,
            negativePrompt: input.negativePrompt,
          });
        } catch {
          throw new Error(`image generation failed (${generator.provider})`);
        }
        const bytes = decodeBase64(generated.imageData);
        const mediaType = await validateOutgoingImage(
          bytes,
          generated.mediaType,
        );
        const reference = rememberOutgoingMedia(storedMedia, {
          bytes,
          mediaType,
          filename: `generated.${extensionFor(mediaType)}`,
          provider: generator.provider,
          expiresAt: Date.now() + MEDIA_TTL_MS,
        });
        return {
          mediaReference: reference,
          provider: generator.provider,
          mediaType,
        };
      },
      deliver(input) {
        const key = `${input.channelId}:${input.toolCallId}`;
        const existing = deliveries.get(key);
        if (existing) return existing;
        const delivery = deliverOutgoingMedia(
          input,
          config,
          storedMedia,
          fetcher,
        );
        deliveries.set(key, delivery);
        pruneDeliveries(deliveries);
        return delivery;
      },
      async sendFallback(input) {
        const key = `${input.channelId}:${input.toolCallId}`;
        const existing = deliveries.get(key);
        if (existing) {
          return await existing;
        }
        const delivery = sendDiscordFallback(input, config, fetcher);
        deliveries.set(key, delivery);
        pruneDeliveries(deliveries);
        const result = await delivery;
        return {
          kind: "text_fallback" as const,
          messageId: result.messageId,
        };
      },
    },
  };
}

interface OutgoingDeliveryInput {
  channelId: string;
  mediaReference: string;
  toolCallId: string;
  companionText?: string;
  fallbackText: string;
  replyToMessageId?: string;
  mode?: "auto" | "attachment" | "embed";
}

function rememberOutgoingMedia(
  store: Map<string, StoredOutgoingMedia>,
  media: StoredOutgoingMedia,
): string {
  pruneOutgoingMedia(store);
  const reference = `media_${crypto.randomUUID()}`;
  store.set(reference, media);
  while (store.size > 128) store.delete(store.keys().next().value!);
  return reference;
}

function pruneOutgoingMedia(store: Map<string, StoredOutgoingMedia>): void {
  const now = Date.now();
  for (const [reference, media] of store) {
    if (media.expiresAt <= now) store.delete(reference);
  }
}

function pruneDeliveries(
  deliveries: Map<
    string,
    Promise<{ kind: "media" | "text_fallback"; messageId?: string }>
  >,
): void {
  while (deliveries.size > 512) {
    deliveries.delete(deliveries.keys().next().value!);
  }
}

async function deliverOutgoingMedia(
  input: OutgoingDeliveryInput,
  config: DiscordPluginServiceConfig,
  store: Map<string, StoredOutgoingMedia>,
  fetcher: typeof fetch,
): Promise<{ kind: "media" | "text_fallback"; messageId?: string }> {
  try {
    const discord = config.getDiscordSettings();
    if (!discord.gatewayEnabled || !discord.botToken) {
      throw new Error("my Discord connection is unavailable");
    }
    pruneOutgoingMedia(store);
    const media = store.get(input.mediaReference);
    if (!media) throw new Error("media reference is unavailable or expired");
    validateOutgoingMedia(media);
    const payload: Record<string, unknown> = {
      nonce: discordNonce(input.toolCallId, "m"),
      enforce_nonce: true,
    };
    const companionText = input.companionText?.trim() ?? "";
    payload.content = companionText.slice(0, 2000);
    if (input.replyToMessageId) {
      payload.message_reference = {
        message_id: input.replyToMessageId,
        channel_id: input.channelId,
      };
    }
    payload.attachments = [{ id: "0", filename: media.filename }];
    const form = new FormData();
    form.set("payload_json", JSON.stringify(payload));
    form.set(
      "files[0]",
      new Blob([copyBuffer(media.bytes)], { type: media.mediaType }),
      media.filename,
    );
    console.log(
      `[DiscordMediaOut] Upload begins: type=${media.mediaType}, bytes=${media.bytes.byteLength}, provider=${media.provider}`,
    );
    const response = await fetcher(
      `https://discord.com/api/v10/channels/${input.channelId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bot ${discord.botToken}` },
        body: form,
      },
    );
    const messageId = await readDiscordMessageId(response);
    console.log(
      `[DiscordMediaOut] Upload outcome: status=${response.status}, messageId=${
        messageId ?? "none"
      }`,
    );
    if (!response.ok) {
      throw new Error(`Discord media upload HTTP ${response.status}`);
    }
    store.delete(input.mediaReference);
    return { kind: "media", messageId };
  } catch (error) {
    console.error(
      `[DiscordMediaOut] Upload failed: reason=${safeDiagnostic(error)}`,
    );
    return await sendDiscordFallback(input, config, fetcher);
  }
}

async function sendDiscordFallback(
  input: {
    channelId: string;
    toolCallId: string;
    fallbackText: string;
    replyToMessageId?: string;
  },
  config: DiscordPluginServiceConfig,
  fetcher: typeof fetch,
): Promise<{ kind: "text_fallback"; messageId?: string }> {
  const discord = config.getDiscordSettings();
  if (!discord.gatewayEnabled || !discord.botToken) {
    throw new Error("my Discord connection is unavailable");
  }
  const payload: Record<string, unknown> = {
    content: input.fallbackText.trim().slice(0, 2000),
    nonce: discordNonce(input.toolCallId, "f"),
    enforce_nonce: true,
  };
  if (!payload.content) throw new Error("my Discord fallback text is empty");
  if (input.replyToMessageId) {
    payload.message_reference = {
      message_id: input.replyToMessageId,
      channel_id: input.channelId,
    };
  }
  const response = await fetcher(
    `https://discord.com/api/v10/channels/${input.channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${discord.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const messageId = await readDiscordMessageId(response);
  console.log(
    `[DiscordMediaOut] Fallback outcome: status=${response.status}, messageId=${
      messageId ?? "none"
    }`,
  );
  if (!response.ok) throw new Error(`Discord fallback HTTP ${response.status}`);
  return { kind: "text_fallback", messageId };
}

async function readDiscordMessageId(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = await response.json() as { id?: unknown };
    return typeof body.id === "string" ? body.id : undefined;
  } catch {
    return undefined;
  }
}

function validateOutgoingMedia(media: StoredOutgoingMedia): void {
  if (
    media.bytes.byteLength === 0 ||
    media.bytes.byteLength > MAX_DISCORD_UPLOAD_BYTES
  ) {
    throw new Error("media exceeds Discord's upload limit");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(media.filename)) {
    throw new Error("media filename is invalid");
  }
  if (media.mediaType === "image/gif") {
    const signature = new TextDecoder().decode(media.bytes.subarray(0, 6));
    if (signature !== "GIF87a" && signature !== "GIF89a") {
      throw new Error("GIF signature is invalid");
    }
  }
}

async function validateOutgoingImage(
  bytes: Uint8Array,
  declaredType: string,
): Promise<StoredOutgoingMedia["mediaType"]> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DISCORD_UPLOAD_BYTES) {
    throw new Error("generated image exceeds Discord's upload limit");
  }
  const metadata = await sharp(bytes).metadata();
  const detected = detectedImageType(metadata.format);
  if (!detected || normalizeType(declaredType) !== detected) {
    throw new Error("generated image MIME type or signature is invalid");
  }
  return detected;
}

function extensionFor(mediaType: StoredOutgoingMedia["mediaType"]): string {
  return mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1];
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("image provider returned invalid encoded media");
  }
}

function imageGeneratorConfigured(
  generator: ImageGenSettings["generators"][number],
): boolean {
  if (!generator.enabled) return false;
  switch (generator.provider) {
    case "openrouter":
      return Boolean(
        generator.settings.openrouter?.apiKey &&
          generator.settings.openrouter?.model,
      );
    case "gemini":
      return Boolean(
        generator.settings.gemini?.apiKey && generator.settings.gemini?.model,
      );
    case "venice":
      return Boolean(
        generator.settings.venice?.apiKey && generator.settings.venice?.model,
      );
    case "nanogpt":
      return Boolean(
        generator.settings.nanogpt?.apiKey && generator.settings.nanogpt?.model,
      );
    case "comfyui":
    case "native":
      return false;
  }
}

function safeDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function discordReadiness(settings: DiscordSettings): ServiceReadiness {
  return settings.gatewayEnabled && Boolean(settings.botToken)
    ? { ready: true, settingsSection: "Discord" }
    : {
      ready: false,
      reason: "Connect my Discord bot in External Connections → Discord.",
      settingsSection: "Discord",
    };
}

function visionReadiness(settings: ImageGenSettings): ServiceReadiness {
  const captioning = settings.captioning;
  const provider = captioning?.provider === "gemini"
    ? captioning.gemini
    : captioning?.provider === "openrouter"
    ? captioning.openrouter
    : undefined;
  return captioning?.enabled && Boolean(provider?.apiKey)
    ? { ready: true, provider: captioning.provider, settingsSection: "Vision" }
    : {
      ready: false,
      reason: "Configure image captioning in Vision settings.",
      settingsSection: "Vision",
    };
}

function sttReadiness(profile?: VoiceProfile): ServiceReadiness {
  const provider = profile?.providerSettings.stt.provider;
  return profile && provider !== "browser"
    ? { ready: true, provider, settingsSection: "Voice" }
    : {
      ready: false,
      reason: "Select a server speech-recognition profile in Voice settings.",
      settingsSection: "Voice",
    };
}

function ttsReadiness(profile?: VoiceProfile): ServiceReadiness {
  const ready = profile?.providerSettings.tts.provider === "elevenlabs" &&
    Boolean(profile.providerSettings.tts.elevenlabs);
  return ready
    ? { ready: true, provider: "elevenlabs", settingsSection: "Voice" }
    : {
      ready: false,
      reason: "Select my companion voice in Voice settings.",
      settingsSection: "Voice",
    };
}

function gifReadiness(service: GifPickerService): ServiceReadiness {
  const status = service.status();
  return status.enabled && status.configured
    ? { ready: true, provider: "giphy", settingsSection: "Media" }
    : {
      ready: false,
      reason:
        "Configure my GIF service in the existing Psycheros media settings.",
      settingsSection: "Media",
    };
}

function imageGenerationReadiness(
  settings: ImageGenSettings,
): ServiceReadiness {
  const generator = settings.generators.find(imageGeneratorConfigured);
  return generator
    ? {
      ready: true,
      provider: generator.provider,
      settingsSection: "Vision",
    }
    : {
      ready: false,
      reason: "Configure an image generator in Vision settings.",
      settingsSection: "Vision",
    };
}

function assertSafeUrl(raw: string): void {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !SAFE_MEDIA_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("media URL is not an allowed Discord proxy or media host");
  }
}

async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("media exceeds the safety limit");
  }
  if (!response.body) throw new Error("media download was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("media exceeds the safety limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function normalizeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function detectedImageType(
  format?: string,
): "image/jpeg" | "image/png" | "image/webp" | undefined {
  return format === "jpeg"
    ? "image/jpeg"
    : format === "png"
    ? "image/png"
    : format === "webp"
    ? "image/webp"
    : undefined;
}

function toDataUrl(bytes: Uint8Array, mediaType: string): DiscordPreparedImage {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return {
    type: "image_url",
    image_url: { url: `data:${mediaType};base64,${btoa(binary)}` },
  };
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
