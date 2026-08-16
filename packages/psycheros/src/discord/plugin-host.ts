import type {
  DiscordMessageProcessor,
  DiscordMessageProcessorResult,
  DiscordPluginEventType,
  DiscordPluginMessageEvent,
} from "../../../plugin-api/src/mod.ts";
import type { DiscordMessage } from "./gateway.ts";

export const DISCORD_PLUGIN_HOST_CAPABILITIES = [
  "discord.events.v1",
  "discord.preprocess.v1",
  "discord.scoped-tools.v1",
  "discord.scoped-instructions.v1",
  "discord.secure-media-fetch.v1",
  "media.animated-images.v1",
  "voice.encoded-stt.v1",
  "voice.encoded-tts.v1",
  "discord.native-voice-transport.v1",
  "delivery.exclusive.v1",
  "readiness.profiles.v1",
  "gif.search.v1",
  "image-generation.configured.v1",
  "discord.outgoing-media.v1",
  "plugin.durable-state.v1",
] as const;

type EventHandler = (
  event: DiscordPluginMessageEvent,
) => void | Promise<void>;

interface ProcessorRegistration {
  pluginId: string;
  processor: DiscordMessageProcessor;
}

/** I isolate plugin Discord hooks from my gateway and private credentials. */
export class DiscordPluginHost {
  private handlers = new Map<DiscordPluginEventType, Set<EventHandler>>();
  private processors: ProcessorRegistration[] = [];
  private mediaReferences = new Map<string, string>();
  private mediaReferenceOrder: string[] = [];
  private exclusiveOwner = "legacy-core";

  subscribe(
    types: DiscordPluginEventType[],
    handler: EventHandler,
  ): () => void {
    for (const type of types) {
      const handlers = this.handlers.get(type) ?? new Set<EventHandler>();
      handlers.add(handler);
      this.handlers.set(type, handlers);
    }
    return () => {
      for (const type of types) this.handlers.get(type)?.delete(handler);
    };
  }

  registerProcessor(
    pluginId: string,
    processor: DiscordMessageProcessor,
  ): () => void {
    const registration = { pluginId, processor };
    this.processors.push(registration);
    this.processors.sort((left, right) =>
      (left.processor.priority ?? 0) - (right.processor.priority ?? 0) ||
      left.pluginId.localeCompare(right.pluginId) ||
      left.processor.name.localeCompare(right.processor.name)
    );
    return () => {
      this.processors = this.processors.filter((item) => item !== registration);
    };
  }

  claimMediaPipeline(owner: string): boolean {
    if (
      this.exclusiveOwner !== "legacy-core" && this.exclusiveOwner !== owner
    ) {
      return false;
    }
    this.exclusiveOwner = owner;
    return true;
  }

  releaseMediaPipeline(owner: string): void {
    if (this.exclusiveOwner === owner) this.exclusiveOwner = "legacy-core";
  }

  getMediaPipelineOwner(): string {
    return this.exclusiveOwner;
  }

  resolveMediaReference(reference: string): string | undefined {
    return this.mediaReferences.get(reference);
  }

  async publish(
    type: DiscordPluginEventType,
    message: Partial<DiscordMessage> & { id: string; channel_id: string },
  ): Promise<void> {
    const event = this.sanitize(type, message);
    for (const handler of this.handlers.get(type) ?? []) {
      try {
        await handler(event);
      } catch (error) {
        console.error(
          `[DiscordPluginHost] Event hook failed: type=${type}, message=${message.id}, reason=${
            safeError(error)
          }`,
        );
      }
    }
  }

  async process(
    channelId: string,
    messages: DiscordPluginMessageEvent[],
    signal: AbortSignal,
  ): Promise<DiscordMessageProcessorResult> {
    const result: DiscordMessageProcessorResult = {};
    for (const { pluginId, processor } of this.processors) {
      try {
        const timeoutMs = processor.timeoutMs ?? 15_000;
        const output = await withTimeout(
          processor.process({ channelId, messages, signal }),
          timeoutMs,
        );
        if (!output) continue;
        if (output.appendedText?.trim()) {
          result.appendedText = [result.appendedText, output.appendedText]
            .filter(Boolean).join("\n\n");
        }
        if (output.visionImages?.length) {
          result.visionImages = [
            ...(result.visionImages ?? []),
            ...output.visionImages,
          ].slice(0, 4);
        }
      } catch (error) {
        console.error(
          `[DiscordPluginHost] Processor failed: plugin=${pluginId}, processor=${processor.name}, reason=${
            safeError(error)
          }`,
        );
      }
    }
    return result;
  }

  sanitize(
    type: DiscordPluginEventType,
    message: Partial<DiscordMessage> & { id: string; channel_id: string },
  ): DiscordPluginMessageEvent {
    const register = (kind: string, index: number, url?: string): string => {
      const reference = `${message.id}:${kind}:${index}`;
      if (url) this.rememberReference(reference, url);
      return reference;
    };
    return {
      type,
      messageId: message.id,
      channelId: message.channel_id,
      guildId: message.guild_id ?? null,
      authorId: message.author?.id ?? "unknown",
      authorBot: message.author?.bot ?? false,
      content: message.content ?? "",
      flags: message.flags,
      attachments: (message.attachments ?? []).map((attachment, index) => ({
        reference: register(
          "attachment",
          index,
          attachment.proxy_url ?? attachment.url,
        ),
        id: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.content_type,
        width: attachment.width,
        height: attachment.height,
        durationSecs: attachment.duration_secs,
      })),
      embeds: (message.embeds ?? []).map((embed, embedIndex) => ({
        type: embed.type,
        hasImage: Boolean(embed.image || embed.thumbnail),
        hasVideo: Boolean(embed.video),
        references: [
          embed.video?.proxy_url,
          embed.image?.proxy_url,
          embed.thumbnail?.proxy_url,
          embed.video?.url,
          embed.image?.url,
          embed.thumbnail?.url,
        ].flatMap((url, urlIndex) =>
          url ? [register(`embed-${embedIndex}`, urlIndex, url)] : []
        ),
      })),
    };
  }

  clear(): void {
    this.handlers.clear();
    this.processors = [];
    this.mediaReferences.clear();
    this.mediaReferenceOrder = [];
    this.exclusiveOwner = "legacy-core";
  }

  private rememberReference(reference: string, url: string): void {
    this.mediaReferences.set(reference, url);
    this.mediaReferenceOrder.push(reference);
    while (this.mediaReferenceOrder.length > 1024) {
      const oldest = this.mediaReferenceOrder.shift();
      if (oldest) this.mediaReferences.delete(oldest);
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`hook timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
