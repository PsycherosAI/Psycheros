import { assertEquals } from "@std/assert";
import type { VoiceProfile } from "../llm/voice-settings.ts";
import { transcribeEncodedAudio } from "./stt.ts";

Deno.test("encoded STT sends Discord Ogg directly to OpenAI", async () => {
  const source = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
  let uploadedType = "";
  let uploadedName = "";
  let uploadedBytes = new Uint8Array();
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    const file = form.get("file") as File;
    uploadedType = file.type;
    uploadedName = file.name;
    uploadedBytes = new Uint8Array(await file.arrayBuffer());
    return new Response(JSON.stringify({ text: "heard" }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const profile = {
    providerSettings: {
      stt: {
        provider: "openai",
        openai: {
          apiKey: "secret",
          baseUrl: "https://api.openai.com/v1",
          model: "whisper-1",
        },
      },
    },
    sttCorrections: [],
  } as unknown as VoiceProfile;

  const result = await transcribeEncodedAudio(
    source,
    { mediaType: "audio/ogg", filename: "discord.ogg" },
    profile,
    { fetcher },
  );
  assertEquals(result.text, "heard");
  assertEquals(uploadedType, "audio/ogg");
  assertEquals(uploadedName, "discord.ogg");
  assertEquals(uploadedBytes, source);
});
