"""
Psycheros Voice Bot — Pipecat Sidecar

FastAPI WebSocket server that runs the STT → LLM → TTS audio pipeline.
Started by the Deno daemon, communicates over WebSocket using a JSON
control protocol + binary PCM audio frames.

Usage:
    uv run --directory packages/psycheros/pipecat bot.py --port 8080
"""

import argparse
import asyncio
import json
import logging
import re
import struct
import time
from datetime import datetime
from typing import Any

import aiohttp

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import WorkerRunner
from pipecat.pipeline.task import PipelineWorker
from pipecat.services.openai.base_llm import BaseOpenAILLMService
from pipecat.services.minimax.tts import MiniMaxHttpTTSService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.openai.tts import OpenAITTSService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
    SpeechTimeoutUserTurnStopStrategy,
)
from pipecat.turns.user_stop.base_user_turn_stop_strategy import (
    BaseUserTurnStopStrategy,
)
from pipecat.turns.user_start.min_words_user_turn_start_strategy import (
    MinWordsUserTurnStartStrategy,
)
from pipecat.turns.types import ProcessFrameResult
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    TTSAudioRawFrame,
    TranscriptionFrame,
    ErrorFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("psycheros-voice")

app = FastAPI()

INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000  # MiniMax TTS outputs at 24kHz


# =============================================================================
# Fixed MiniMax TTS (patches streaming buffer bug in Pipecat 1.3.0)
# =============================================================================

class FixedMiniMaxTTSService(MiniMaxHttpTTSService):
    """MiniMax TTS with fixed streaming response parser and GroupId handling.

    Pipecat's MiniMaxHttpTTSService.run_tts() drops the last audio data block
    because it waits for a "data:" prefix that never comes (the HTTP stream
    ends). This override processes leftover buffer data after the stream ends.
    Also fixes the base URL when group_id is empty (Pipecat always appends
    ?GroupId= which causes a misleading "insufficient balance" error).
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Fix base URL: if group_id is empty, strip the broken ?GroupId= suffix
        if not self._group_id:
            base = self._base_url.split("?GroupId=")[0]
            self._base_url = base
        logger.info(f"[MiniMax] Fixed init: url={self._base_url[:60]}")

    async def run_tts(self, text: str, context_id: str):
        headers = {
            "accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
        }
        voice_setting = {
            "voice_id": self._settings.voice,
            "speed": self._settings.speed,
            "vol": self._settings.volume,
            "pitch": self._settings.pitch,
        }
        if self._settings.emotion is not None:
            voice_setting["emotion"] = self._settings.emotion
        if self._settings.text_normalization is not None:
            voice_setting["text_normalization"] = self._settings.text_normalization
        if self._settings.latex_read is not None:
            voice_setting["latex_read"] = self._settings.latex_read
        audio_setting = {
            "bitrate": self._audio_bitrate,
            "format": self._audio_format,
            "channel": self._audio_channel,
            "sample_rate": self._audio_sample_rate,
        }
        payload = {
            "stream": self._stream,
            "voice_setting": voice_setting,
            "audio_setting": audio_setting,
            "model": self._settings.model,
            "text": text,
        }
        if self._settings.language_boost is not None:
            payload["language_boost"] = self._settings.language_boost

        try:
            async with self._session.post(
                self._base_url, headers=headers, json=payload
            ) as response:
                if response.status != 200:
                    yield ErrorFrame(error=f"MiniMax TTS error: HTTP {response.status}")
                    return

                await self.start_tts_usage_metrics(text)

                CHUNK_SIZE = self.chunk_size
                buffer = bytearray()
                data_blocks_found = 0

                async for chunk in response.content.iter_chunked(CHUNK_SIZE):
                    if not chunk:
                        continue
                    buffer.extend(chunk)
                    # Process all complete data blocks in buffer.
                    # MiniMax SSE uses bare "data:" prefix (no \n delimiter between events).
                    while b"data:" in buffer:
                        start = buffer.find(b"data:")
                        next_start = buffer.find(b"data:", start + 5)
                        if next_start == -1:
                            if start > 0:
                                buffer = buffer[start:]
                            break
                        data_block = buffer[start:next_start]
                        buffer = buffer[next_start:]
                        data_blocks_found += 1
                        async for frame in self._parse_data_block(data_block, context_id):
                            yield frame

                # Process any remaining data in buffer after stream ends
                if b"data:" in buffer:
                    data_blocks_found += 1
                    async for frame in self._parse_data_block(bytes(buffer), context_id):
                        yield frame

                logger.info(f"[MiniMax] run_tts done: status={response.status}, data_blocks={data_blocks_found}, buffer_remaining={len(buffer)}")

        except Exception as e:
            logger.error(f"[MiniMax] run_tts exception: {e}")
            yield ErrorFrame(error=f"MiniMax TTS error: {e}", exception=e)
            yield ErrorFrame(error=f"MiniMax TTS error: {e}", exception=e)
        finally:
            await self.stop_ttfb_metrics()

    @staticmethod
    async def _parse_data_block(data_block: bytes, context_id: str):
        """Parse a single data: block and yield TTSAudioRawFrames."""
        try:
            data = json.loads(data_block[5:].decode("utf-8"))
            if "extra_info" in data:
                return
            chunk_data = data.get("data", {})
            if not chunk_data:
                return
            audio_data = chunk_data.get("audio")
            if not audio_data:
                return
            chunk_size = 4096
            for i in range(0, len(audio_data), chunk_size * 2):
                hex_chunk = audio_data[i:i + chunk_size * 2]
                if not hex_chunk:
                    continue
                try:
                    audio_chunk = bytes.fromhex(hex_chunk)
                    if audio_chunk:
                        yield TTSAudioRawFrame(
                            audio=audio_chunk,
                            sample_rate=24000,
                            num_channels=1,
                            context_id=context_id,
                        )
                except ValueError:
                    continue
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass


# =============================================================================
# Pipeline Probe (temporary diagnostic)
# =============================================================================

class PipelineProbe(FrameProcessor):
    """Logs all frames passing through for debugging. Remove once pipeline works."""

    _counts: dict = {}

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        name = type(frame).__name__
        PipelineProbe._counts[name] = PipelineProbe._counts.get(name, 0) + 1
        total = PipelineProbe._counts[name]
        if name not in ("HeartbeatFrame", "MetricsFrame", "UserSpeakingFrame",
                        "UserStoppedSpeakingFrame"):
            logger.info(f"[Probe] {name} (#{total})")
            if isinstance(frame, (TTSAudioRawFrame, OutputAudioRawFrame)):
                logger.info(f"[Probe]   audio={len(frame.audio)} bytes @ {frame.sample_rate}Hz")
        await self.push_frame(frame, direction)


# =============================================================================
# WebSocket Output Processor
# =============================================================================

class WebSocketOutputProcessor(FrameProcessor):
    """Sends audio frames back through the WebSocket, resampling to 16kHz."""

    def __init__(self, websocket: WebSocket, **kwargs):
        super().__init__(**kwargs)
        self._ws = websocket
        self._next_send_time = 0
        self._send_interval = 0.02
        self._audio_count = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, (OutputAudioRawFrame, TTSAudioRawFrame)):
            self._audio_count += 1
            if self._audio_count <= 5 or self._audio_count % 50 == 0:
                logger.info(f"[WSOut] audio frame #{self._audio_count}: {len(frame.audio)} bytes @ {frame.sample_rate}Hz")
            audio = bytes(frame.audio)
            src_rate = frame.sample_rate
            # Resample to 16kHz if needed
            if src_rate != INPUT_SAMPLE_RATE:
                audio = self._resample(audio, src_rate, INPUT_SAMPLE_RATE)
            try:
                await self._ws.send_bytes(audio)
            except Exception:
                pass
            await self._playback_sleep()
        await self.push_frame(frame, direction)

    @staticmethod
    def _resample(pcm_bytes: bytes, src_rate: int, dst_rate: int) -> bytes:
        """Resample Int16 PCM from src_rate to dst_rate (linear interpolation)."""
        if src_rate == dst_rate:
            return pcm_bytes
        n_samples = len(pcm_bytes) // 2
        src = struct.unpack(f"<{n_samples}h", pcm_bytes)
        ratio = src_rate / dst_rate
        dst_len = int(n_samples / ratio)
        dst = [0] * dst_len
        for i in range(dst_len):
            pos = i * ratio
            idx = int(pos)
            frac = pos - idx
            if idx + 1 < n_samples:
                dst[i] = int(src[idx] * (1 - frac) + src[idx + 1] * frac)
            else:
                dst[i] = src[min(idx, n_samples - 1)]
        return struct.pack(f"<{dst_len}h", *dst)

    async def _playback_sleep(self):
        current = time.monotonic()
        delay = max(0, self._next_send_time - current)
        await asyncio.sleep(delay)
        if delay == 0:
            self._next_send_time = time.monotonic() + self._send_interval
        else:
            self._next_send_time += self._send_interval


# =============================================================================
# Pronunciation Processor
# =============================================================================

class PronunciationProcessor(FrameProcessor):
    """Pre-TTS processor that substitutes phonetic spellings before TTS."""

    def __init__(self, entries: list[dict[str, str]], **kwargs):
        super().__init__(**kwargs)
        self.patterns: list[tuple[re.Pattern, str]] = []
        for entry in entries:
            written = entry.get("written", "").strip()
            spoken = entry.get("spoken", "").strip()
            if written and spoken:
                pattern = re.compile(r"\b" + re.escape(written) + r"\b", re.IGNORECASE)
                self.patterns.append((pattern, spoken))

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and not getattr(frame, "skip_tts", False):
            for pattern, replacement in self.patterns:
                frame.text = pattern.sub(replacement, frame.text)
        await self.push_frame(frame, direction)


# =============================================================================
# Transcript Forwarder
# =============================================================================

class TranscriptForwarder(FrameProcessor):
    """Intercepts TranscriptionFrames and sends them back through the WebSocket."""

    def __init__(self, websocket: WebSocket, **kwargs):
        super().__init__(**kwargs)
        self._ws = websocket

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.finalized:
            try:
                await self._ws.send_json({
                    "type": "transcript",
                    "role": "user",
                    "text": frame.text,
                })
            except Exception:
                pass
        await self.push_frame(frame, direction)


# =============================================================================
# Bot speaking state (module-level, shared between tracker and turn strategy)
# =============================================================================

_bot_speaking = False

_ts_pattern = re.compile(r"\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2")

def _strip_timestamps(text: str) -> str:
    """Strip timestamp prefixes like [2026-06-12T23:00:00] from message content."""
    return _ts_pattern.sub("", text).strip()


class TTagStripper:
    """Strips Psycheros <t>Day YYYY-MM-DD HH:MM</t> tags from LLM streaming.

    Format: <t>Fri 2026-06-13 00:16</t> (see formatMessageTimestamp in loop.ts).
    Tags span multiple streaming chunks. Buffers up to 40 chars when a <t> is
    seen without a matching </t>. If the buffer overflows (glitched/unclosed tag),
    the buffered text is emitted as-is rather than lost.
    """

    _MAX_BUF = 30

    def __init__(self):
        self._buf = ""

    def process(self, chunk: str) -> str:
        text = self._buf + chunk
        self._buf = ""
        out = []
        i = 0
        while i < len(text):
            start = text.find("<t>", i)
            if start == -1:
                out.append(text[i:])
                break
            out.append(text[i:start])
            end = text.find("</t>", start)
            if end != -1:
                # Complete tag — drop it entirely
                i = end + 4
            else:
                # Incomplete — buffer if short enough
                remainder = text[start:]
                if len(remainder) <= self._MAX_BUF:
                    self._buf = remainder
                else:
                    # Too long for a valid tag — emit text after <t> opener
                    out.append(text[start + 3:])
                break
        return "".join(out)


# =============================================================================
# Turn Start: Lock during bot speech
# =============================================================================

class BotSpeakingTurnLock(MinWordsUserTurnStartStrategy):
    """Only allows user turns when the bot is NOT speaking.

    Pipecat's turn start strategies can't see BotStartedSpeakingFrame because
    TTS is downstream of the user aggregator. So we track bot speaking state
    at module level, set by BotSpeakingTracker (placed after TTS).
    """

    async def _handle_transcription(self, frame):
        global _bot_speaking
        if _bot_speaking:
            await self.trigger_reset_aggregation()
            return ProcessFrameResult.CONTINUE
        word_count = len(frame.text.split())
        if word_count >= 1:
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        await self.trigger_reset_aggregation()
        return ProcessFrameResult.CONTINUE


class BotSpeakingTurnGate(BaseUserTurnStopStrategy):
    """Wraps SpeechTimeoutUserTurnStopStrategy but suppresses turn-end while TTS is active.

    The inner strategy calls trigger_user_turn_stopped() when its timers fire.
    We override that method on the inner instance so it checks _bot_speaking
    before actually triggering the turn stop.

    Also filters out VAD echo blips: speech bursts shorter than MIN_SPEECH_SECS
    don't count toward the silence timer.
    """

    MIN_SPEECH_SECS = 0.8

    def __init__(self, inner: SpeechTimeoutUserTurnStopStrategy, **kwargs):
        super().__init__(**kwargs)
        self._inner = inner
        self._suppressed = 0
        self._vad_started_at: float | None = None
        self._real_speech_secs = 0.0
        # Monkey-patch the inner's trigger to gate on _bot_speaking
        inner.trigger_user_turn_stopped = self._gated_trigger

    async def _gated_trigger(self):
        global _bot_speaking
        if _bot_speaking:
            self._suppressed += 1
            logger.info(f"[TurnGate] Suppressed turn stop while bot speaking (#{self._suppressed})")
            return
        if self._real_speech_secs < self.MIN_SPEECH_SECS:
            self._suppressed += 1
            logger.info(f"[TurnGate] Suppressed turn stop — only {self._real_speech_secs:.2f}s of real speech (need {self.MIN_SPEECH_SECS}s, #{self._suppressed})")
            return
        logger.info(f"[TurnGate] Allowing turn stop — {self._real_speech_secs:.2f}s of real speech (suppressed {self._suppressed} prior)")
        self._real_speech_secs = 0.0
        await self.trigger_user_turn_stopped()

    async def reset(self):
        await self._inner.reset()

    async def setup(self, task_manager):
        await self._inner.setup(task_manager)

    async def cleanup(self):
        await self._inner.cleanup()

    async def process_frame(self, frame):
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self._vad_started_at = time.monotonic()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            if self._vad_started_at is not None:
                burst_duration = time.monotonic() - self._vad_started_at
                if burst_duration >= self.MIN_SPEECH_SECS:
                    self._real_speech_secs += burst_duration
                self._vad_started_at = None
        return await self._inner.process_frame(frame)


# =============================================================================
# Bot Speaking Tracker (placed after TTS in pipeline)
# =============================================================================

class BotSpeakingTracker(FrameProcessor):
    """Tracks when TTS is active using TTSStartedFrame/TTSStoppedFrame counts.

    A long LLM response produces multiple text segments, each with its own
    TTSStartedFrame/TTSStoppedFrame pair. We use a counter so _bot_speaking
    stays True from the first TTS start until the last TTS end.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._tts_active = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        global _bot_speaking
        if isinstance(frame, TTSStartedFrame):
            self._tts_active += 1
            if self._tts_active == 1:
                _bot_speaking = True
                logger.info("[BotTracker] Bot started speaking")
        elif isinstance(frame, TTSStoppedFrame):
            self._tts_active = max(0, self._tts_active - 1)
            if self._tts_active == 0:
                _bot_speaking = False
                logger.info("[BotTracker] Bot stopped speaking")
        await self.push_frame(frame, direction)


# =============================================================================
# Z.ai-Aware LLM Service
# =============================================================================

class ZaiLLMService(BaseOpenAILLMService):
    """OpenAI-compatible LLM that filters Z.ai's reasoning_content.

    Z.ai models (glm-5-turbo, glm-4.7) send reasoning_content (chain-of-thought)
    in delta.reasoning_content BEFORE the actual response in delta.content. The
    base class only checks delta.content, which is correct — we just need to
    ensure reasoning_content is never pushed to TTS.

    Also disables Z.ai's thinking mode via extra_body (the openai SDK doesn't
    natively support the 'thinking' parameter).
    """

    async def get_chat_completions(self, context):
        from pipecat.services.openai.base_llm import assert_given

        adapter = self.get_llm_adapter()
        params_from_context = adapter.get_llm_invocation_params(
            context,
            system_instruction=assert_given(self._settings.system_instruction),
            convert_developer_to_user=not self.supports_developer_role,
        )
        params = self.build_chat_completion_params(params_from_context)

        # Extract 'thinking' from extra — the openai SDK rejects it as a kwarg,
        # so we pass it via extra_body instead.
        thinking = params.pop("thinking", None)
        log_params = {k: v for k, v in params.items() if k != "messages"}
        logger.info(f"[ZaiLLM] Request params: {log_params}, extra_body={thinking}")

        if thinking is not None:
            chunks = await self._client.chat.completions.create(
                **params,
                extra_body={"thinking": thinking},
            )
        else:
            chunks = await self._client.chat.completions.create(**params)
        return chunks

    async def _process_context(self, context):
        content_chunks = 0
        reasoning_chunks = 0
        tag_stripper = TTagStripper()
        try:
            chunk_iter = await self.get_chat_completions(context)
        except Exception as e:
            logger.error(f"[ZaiLLM] get_chat_completions failed: {e}")
            return

        global _bot_speaking
        _bot_speaking = True

        async for chunk in chunk_iter:
            if chunk.choices is None or len(chunk.choices) == 0:
                continue

            if not chunk.choices[0].delta:
                continue

            delta = chunk.choices[0].delta

            if delta.content:
                content_chunks += 1
                cleaned = tag_stripper.process(delta.content)
                if cleaned:
                    if content_chunks <= 3:
                        logger.info(f"[ZaiLLM] content chunk: {repr(cleaned[:80])}")
                    await self._push_llm_text(cleaned)

            elif hasattr(delta, "reasoning_content") and delta.reasoning_content:
                reasoning_chunks += 1
                if reasoning_chunks <= 3:
                    logger.info(f"[ZaiLLM] reasoning chunk: {repr(delta.reasoning_content[:80])}")

        logger.info(f"[ZaiLLM] Done: {content_chunks} content, {reasoning_chunks} reasoning chunks")


# =============================================================================
# Bot Session
# =============================================================================

async def run_session(websocket: WebSocket, config: dict[str, Any]):
    """Build and run a Pipecat pipeline for one voice session."""

    profile = config.get("profile", {})
    tts_config = profile.get("tts", {})
    stt_config = profile.get("stt", {})
    pronunciation_entries = profile.get("pronunciation", [])
    history = config.get("history", [])
    vad_threshold = profile.get("vadThreshold", 0.5)
    allow_interruptions = profile.get("allowInterruptions", False)
    end_of_turn_silence = profile.get("endOfTurnSilence", 2.0)
    system_prompt = config.get("systemPrompt", "")

    # --- STT ---
    stt_provider = stt_config.get("provider")
    if stt_provider == "local":
        local_stt = stt_config.get("local", {})
        stt_model = local_stt.get("model", "base")
        stt_language = local_stt.get("language") or "en"
        logger.info(f"[Voice] Using local Whisper STT (model={stt_model})")
        stt = WhisperSTTService(model=stt_model, language=stt_language)
    elif stt_provider == "custom":
        cust_stt = stt_config.get("custom", {})
        stt = OpenAISTTService(
            api_key=cust_stt.get("apiKey", "") or "not-needed",
            base_url=cust_stt.get("baseUrl", "http://localhost:8000/v1"),
            model=cust_stt.get("model", "whisper-small"),
        )
    else:
        logger.warning("[Voice] No STT configured")
        stt = None

    # --- LLM Context ---
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    # Pre-seed with recent conversation history so the entity has context
    # from the text chat that preceded this voice call.
    # Strip timestamp prefixes so the entity doesn't read them aloud.
    for msg in history:
        messages.append({"role": msg["role"], "content": _strip_timestamps(msg["content"])})
    if messages:
        logger.info(f"[Voice] LLM context: system + {len(history)} history messages")
    context = LLMContext(messages=messages)

    logger.info(f"[Voice] Turn settings: end_of_turn_silence={end_of_turn_silence}s, interruptions={allow_interruptions}")
    stop_inner = SpeechTimeoutUserTurnStopStrategy(
        user_speech_timeout=end_of_turn_silence,
    )
    agg = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                start=[
                    BotSpeakingTurnLock(
                        min_words=1,
                        enable_interruptions=allow_interruptions,
                    ),
                ],
                stop=[
                    BotSpeakingTurnGate(inner=stop_inner),
                ],
            ),
        ),
    )
    user_aggregator = agg.user()
    assistant_aggregator = agg.assistant()

    transcript_forwarder = TranscriptForwarder(websocket)

    # --- VAD ---
    vad = VADProcessor(
        vad_analyzer=SileroVADAnalyzer(
            params=VADParams(confidence=vad_threshold, start_secs=0.5),
        ),
    )

    # --- LLM ---
    llm_config = config.get("llm", {})
    llm_api_key = llm_config.get("apiKey", "")
    llm_base_url = llm_config.get("baseUrl", "https://api.openai.com/v1")
    llm_model = llm_config.get("model", "gpt-4o")

    if llm_api_key:
        llm = ZaiLLMService(
            api_key=llm_api_key,
            base_url=llm_base_url,
            model=llm_model,
            params=BaseOpenAILLMService.InputParams(
                extra={"thinking": {"type": "disabled"}},
            ),
        )
    else:
        logger.error("[Voice] No LLM API key")
        await websocket.send_json({"type": "error", "message": "No LLM API key configured"})
        await websocket.close()
        return

    # --- TTS ---
    tts_provider = tts_config.get("provider", "minimax")
    if tts_provider == "minimax":
        mm = tts_config.get("minimax", {})
        tts = FixedMiniMaxTTSService(
            api_key=mm.get("apiKey", ""),
            group_id=mm.get("groupId", ""),
            voice_id=mm.get("voiceId", ""),
            aiohttp_session=aiohttp.ClientSession(),
        )
    elif tts_provider == "elevenlabs":
        el = tts_config.get("elevenlabs", {})
        tts = ElevenLabsTTSService(
            api_key=el.get("apiKey", ""),
            voice_id=el.get("voiceId", ""),
            model=el.get("model", "eleven_multilingual_v2"),
        )
    elif tts_provider == "custom":
        cust_tts = tts_config.get("custom", {})
        tts = OpenAITTSService(
            api_key=cust_tts.get("apiKey", "") or "not-needed",
            base_url=cust_tts.get("baseUrl", "http://localhost:8000/v1"),
            voice=cust_tts.get("voice", "default"),
            model=cust_tts.get("model", "tts-1"),
        )
    else:
        logger.error(f"[Voice] Unknown TTS provider: {tts_provider}")
        await websocket.send_json({"type": "error", "message": f"Unknown TTS provider: {tts_provider}"})
        await websocket.close()
        return

    pronunciation = PronunciationProcessor(pronunciation_entries)
    ws_output = WebSocketOutputProcessor(websocket)
    bot_tracker = BotSpeakingTracker()

    # --- Build pipeline ---
    # VAD → STT → UserAggregator → TranscriptForwarder → LLM →
    # Pronunciation → TTS → BotTracker → Probe → AssistantAggregator → WSOutput
    # Note: AssistantAggregator MUST be after TTS because it consumes
    # TextFrame/LLMFullResponse* without forwarding them. TTS needs those
    # frames directly from LLM.
    # Note: BotTracker MUST be after TTS to receive BotStartedSpeakingFrame.
    probe = PipelineProbe()
    processors: list = [vad]
    if stt:
        processors.append(stt)
    processors.append(user_aggregator)
    processors.append(transcript_forwarder)
    processors.append(llm)
    processors.append(pronunciation)
    processors.append(tts)
    processors.append(bot_tracker)
    processors.append(probe)
    processors.append(assistant_aggregator)
    processors.append(ws_output)

    pipeline = Pipeline(processors)
    task = PipelineWorker(
        pipeline,
        idle_timeout_secs=None,
        enable_rtvi=False,
        cancel_timeout_secs=45,
    )

    logger.info("[Voice] Pipeline built")

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(task)

    pipeline_task = asyncio.create_task(_run_pipeline(runner))

    logger.info("[Voice] Pipeline running, reading from websocket")

    # Read from websocket in request handler context
    _audio_count = 0
    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type", "")
            if msg_type == "websocket.disconnect":
                logger.info(f"[Voice] Client disconnect: code={message.get('code')}")
                break
            if "text" in message and message["text"] is not None:
                try:
                    ctrl = json.loads(message["text"])
                    if ctrl.get("type") == "end_session":
                        logger.info("[Voice] Received end_session")
                        break
                except (json.JSONDecodeError, KeyError):
                    pass
            if "bytes" in message and message["bytes"] is not None:
                _audio_count += 1
                if _audio_count == 1:
                    logger.info("[Voice] First audio frame received from websocket")
                frame = InputAudioRawFrame(
                    audio=bytes(message["bytes"]),
                    sample_rate=INPUT_SAMPLE_RATE,
                    num_channels=1,
                )
                await task.queue_frame(frame)
    except asyncio.CancelledError:
        logger.info("[Voice] Session cancelled")
    except Exception as e:
        logger.error(f"[Voice] WebSocket read error: {e.__class__.__name__}: {e}")
    finally:
        logger.info(f"[Voice] Ending session (audio frames received: {_audio_count})")
        await runner.cancel(reason="session end")


async def _run_pipeline(runner: WorkerRunner):
    try:
        await runner.run(auto_end=False)
    except asyncio.CancelledError:
        logger.info("[Voice] Pipeline cancelled")
    except Exception as e:
        logger.error(f"[Voice] Pipeline error: {e}")


# =============================================================================
# Endpoints
# =============================================================================

@app.get("/health")
async def health():
    return PlainTextResponse("ok")


@app.websocket("/session/{session_id}")
async def voice_session(websocket: WebSocket, session_id: str):
    """Handle a voice session. First message must be a config object."""
    await websocket.accept()
    logger.info(f"[Voice] Session connected: {session_id}")

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        config = json.loads(raw)

        if config.get("type") != "config":
            await websocket.send_json({
                "type": "error",
                "message": "First message must be a config object",
            })
            await websocket.close()
            return

        await websocket.send_json({"type": "ready", "sessionId": session_id})
        await run_session(websocket, config)
    except asyncio.TimeoutError:
        logger.warning(f"[Voice] Session {session_id}: config timeout")
        await websocket.send_json({"type": "error", "message": "Config timeout"})
        await websocket.close()
    except WebSocketDisconnect:
        logger.info(f"[Voice] Session disconnected: {session_id}")
    except Exception as e:
        logger.error(f"[Voice] Session {session_id} error: {e}")
    finally:
        logger.info(f"[Voice] Session ended: {session_id}")


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="Psycheros Voice Bot (Pipecat)")
    parser.add_argument("--port", type=int, default=8080, help="WebSocket port")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Bind host")
    args = parser.parse_args()

    logger.info(f"[Voice] Starting Pipecat bot on {args.host}:{args.port}")
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
