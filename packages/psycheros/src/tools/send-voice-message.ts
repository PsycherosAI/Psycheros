import type { VoiceProfile } from "../llm/voice-settings.ts";
import type { ToolResult } from "../types.ts";
import { claimDiscordDelivery } from "../discord/delivery-state.ts";
import { discordNonce, inspectOggOpus } from "../discord/voice-message.ts";
import { applyTTSPronunciation } from "../voice/pronunciation.ts";
import { synthesizeElevenLabsOgg } from "../voice/tts.ts";
import type { Tool, ToolContext } from "./types.ts";

const DISCORD_VOICE_FLAG = 1 << 13;
const DISCORD_UPLOAD_LIMIT = 10 * 1024 * 1024;
const MAX_VOICE_TEXT_LENGTH = 2000;

type Synthesizer = (text: string, profile: VoiceProfile) => Promise<Uint8Array>;

interface VoiceToolDeps {
  fetcher?: typeof fetch;
  synthesize?: Synthesizer;
}

export function createSendVoiceMessageTool(deps: VoiceToolDeps = {}): Tool {
  const fetcher = deps.fetcher ?? fetch;
  const synthesize = deps.synthesize ?? ((text, profile) => {
    const settings = profile.providerSettings.tts.elevenlabs;
    if (!settings) throw new Error("My ElevenLabs voice settings are missing");
    return synthesizeElevenLabsOgg(text, settings, fetcher);
  });
  const deliveries = new Map<string, Promise<ToolResult>>();

  return {
    definition: {
      type: "function",
      function: {
        name: "send_voice_message",
        description:
          "I use this occasionally when a spoken reply would feel especially natural or meaningful in Discord. It sends one native Discord voice note using my active ElevenLabs voice. I do not call act_in_discord for a text reply in the same turn; if voice delivery fails, this tool sends my fallback text itself.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The words I want to speak, up to 2000 characters.",
            },
            fallback_text: {
              type: "string",
              description:
                "The normal Discord text I want sent only if synthesis or voice upload fails. If omitted, my spoken text is used.",
            },
            message_id: {
              type: "string",
              description:
                "Optional Discord message ID this voice note replies to.",
            },
          },
          required: ["text"],
        },
      },
    },
    execute(args, ctx) {
      const discordContext = ctx.config.discordContext;
      const key = `${discordContext?.channelId ?? "none"}:${ctx.toolCallId}`;
      const existing = deliveries.get(key);
      if (existing) return existing;

      const delivery = executeVoiceMessage(args, ctx, fetcher, synthesize);
      deliveries.set(key, delivery);
      if (deliveries.size > 256) {
        deliveries.delete(deliveries.keys().next().value!);
      }
      return delivery;
    },
  };
}

async function executeVoiceMessage(
  args: Record<string, unknown>,
  ctx: ToolContext,
  fetcher: typeof fetch,
  synthesize: Synthesizer,
): Promise<ToolResult> {
  const discordContext = ctx.config.discordContext;
  const discordSettings = ctx.config.discordSettings;
  const voiceSettings = ctx.config.voiceSettings;
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const fallback =
    typeof args.fallback_text === "string" && args.fallback_text.trim()
      ? args.fallback_text.trim()
      : text;
  const messageId =
    typeof args.message_id === "string" && args.message_id.trim()
      ? args.message_id.trim()
      : undefined;

  if (!discordContext) {
    return fail(ctx, "I can only send a voice message during a Discord turn.");
  }
  if (!discordSettings?.botToken) {
    return fail(ctx, "My Discord bot token is not configured.");
  }
  if (!text || text.length > MAX_VOICE_TEXT_LENGTH) {
    return fail(ctx, "My voice-message text must contain 1–2000 characters.");
  }
  if (
    !claimDiscordDelivery(discordContext.deliveryState, "send_voice_message")
  ) {
    return fail(
      ctx,
      "I already sent a text message in this turn, so I skipped the voice message.",
    );
  }

  const profile = voiceSettings?.profiles.find((item) =>
    item.id === voiceSettings.activeProfileId
  );
  const elevenlabs = profile?.providerSettings.tts.provider === "elevenlabs" &&
      profile.providerSettings.tts.elevenlabs
    ? profile.providerSettings.tts.elevenlabs
    : undefined;
  const url =
    `https://discord.com/api/v10/channels/${discordContext.channelId}/messages`;
  const auth = { "Authorization": `Bot ${discordSettings.botToken}` };

  try {
    if (!voiceSettings?.enabled || !profile?.enabled || !elevenlabs) {
      throw new Error(
        "My active enabled ElevenLabs voice profile is unavailable",
      );
    }
    const spoken = applyTTSPronunciation(text, profile);
    console.log(
      `[DiscordVoice] Synthesizing ${spoken.length} characters with active profile ${profile.id}`,
    );
    const audio = await synthesize(spoken, profile);
    if (audio.byteLength > DISCORD_UPLOAD_LIMIT) {
      throw new Error(
        `Voice audio exceeds Discord's ${DISCORD_UPLOAD_LIMIT}-byte upload limit`,
      );
    }
    const metadata = inspectOggOpus(audio);
    const payload: Record<string, unknown> = {
      flags: DISCORD_VOICE_FLAG,
      nonce: discordNonce(ctx.toolCallId),
      enforce_nonce: true,
      attachments: [{
        id: "0",
        filename: "voice-message.ogg",
        duration_secs: metadata.durationSecs,
        waveform: metadata.waveform,
      }],
    };
    if (messageId) {
      payload.message_reference = {
        message_id: messageId,
        channel_id: discordContext.channelId,
      };
    }
    const form = new FormData();
    form.set("payload_json", JSON.stringify(payload));
    form.set(
      "files[0]",
      new Blob([audio.slice().buffer as ArrayBuffer], { type: "audio/ogg" }),
      "voice-message.ogg",
    );
    console.log(
      `[DiscordVoice] Upload begins: bytes=${audio.byteLength}, duration=${
        metadata.durationSecs.toFixed(2)
      }s`,
    );
    const response = await fetcher(url, {
      method: "POST",
      headers: auth,
      body: form,
    });
    await response.body?.cancel();
    console.log(
      `[DiscordVoice] Upload response: status=${response.status}`,
    );
    if (!response.ok) {
      throw new Error(
        `Discord voice upload HTTP ${response.status}`,
      );
    }
    return {
      toolCallId: ctx.toolCallId,
      content: "My native Discord voice message was sent.",
      isError: false,
    };
  } catch (error) {
    console.error(
      "[DiscordVoice] Voice delivery failed; sending text fallback:",
      error instanceof Error ? error.stack ?? error.message : error,
    );
    try {
      const body: Record<string, unknown> = {
        content: fallback.slice(0, 2000),
        nonce: discordNonce(ctx.toolCallId, "f"),
        enforce_nonce: true,
      };
      if (messageId) {
        body.message_reference = {
          message_id: messageId,
          channel_id: discordContext.channelId,
        };
      }
      const response = await fetcher(url, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await response.body?.cancel();
      console.log(
        `[DiscordVoice] Fallback response: status=${response.status}`,
      );
      if (!response.ok) {
        throw new Error(
          `Discord fallback HTTP ${response.status}`,
        );
      }
      return {
        toolCallId: ctx.toolCallId,
        content: "Voice delivery failed, so I sent my text fallback once.",
        isError: false,
      };
    } catch (fallbackError) {
      console.error(
        "[DiscordVoice] Text fallback failed:",
        fallbackError instanceof Error
          ? fallbackError.stack ?? fallbackError.message
          : fallbackError,
      );
      return fail(
        ctx,
        `My voice message and text fallback both failed: ${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }`,
      );
    }
  }
}

function fail(ctx: ToolContext, content: string): ToolResult {
  return { toolCallId: ctx.toolCallId, content, isError: true };
}

export const sendVoiceMessageTool = createSendVoiceMessageTool();
