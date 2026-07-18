/**
 * LLM Module
 *
 * Provides the LLM client and settings management for multi-provider
 * LLM connection profiles. This module exports all types and the client
 * class for use throughout the Psycheros daemon.
 */

// Re-export types (only those used externally)
export type {
  ChatContent,
  ChatContentPart,
  ChatImageUrlPart,
  ChatMessage,
  ChatTextPart,
  LLMConfig,
  StreamChunk,
} from "./types.ts";

export { LLMError } from "./types.ts";

// Re-export client
export {
  createClientFromProfile,
  createDefaultClient,
  createWorkerClient,
  LLMClient,
} from "./client.ts";

// Re-export provider presets and profile types
export type {
  LLMConnectionProfile,
  LLMProfileSettings,
  LLMProvider,
  LLMProviderPreset,
} from "./provider-presets.ts";
export {
  createDefaultProfile,
  inferProvider,
  inferProviderName,
  LLM_PROVIDER_PRESETS,
} from "./provider-presets.ts";

// Re-export model capabilities
export type {
  FilterResult,
  ModelFamilyCapabilities,
  SamplingParam,
} from "./model-capabilities.ts";
export {
  detectModelCapabilities,
  filterSamplingParams,
} from "./model-capabilities.ts";

// Re-export settings
export type { LLMSettings } from "./settings.ts";
export {
  getActiveProfile,
  getDefaultSettings,
  // Profile-based settings
  loadProfileSettings,
  loadSettings,
  maskApiKey,
  maskProfileSettings,
  profileToLLMSettings,
  saveProfileSettings,
  saveSettings,
} from "./settings.ts";

// Re-export web search settings
export type { WebSearchSettings } from "./web-search-settings.ts";
export {
  getDefaultWebSearchSettings,
  loadWebSearchSettings,
  maskWebSearchSettings,
  saveWebSearchSettings,
} from "./web-search-settings.ts";

// Re-export Discord settings
export type {
  ChannelMode,
  DiscordChannelConfig,
  DiscordGatewayConfig,
  DiscordServerConfig,
  DiscordSettings,
  DmWhitelistEntry,
} from "./discord-settings.ts";
export {
  getDefaultDiscordGatewayConfig,
  getDefaultDiscordSettings,
  loadDiscordGatewayConfig,
  loadDiscordSettings,
  maskDiscordSettings,
  saveDiscordGatewayConfig,
  saveDiscordSettings,
} from "./discord-settings.ts";

// Re-export Home settings
export type { HomeDevice, HomeSettings } from "./home-settings.ts";
export {
  getDefaultHomeSettings,
  loadHomeSettings,
  saveHomeSettings,
} from "./home-settings.ts";

// Re-export Image Gen settings
export type {
  CaptioningGeminiSettings,
  CaptioningOpenRouterSettings,
  CaptioningProvider,
  CaptioningSettings,
  CommonImageGenParams,
  ImageGenConfig,
  ImageGenProvider,
  ImageGenProviderSettings,
  ImageGenSettings,
} from "./image-gen-settings.ts";
export {
  getDefaultImageGenSettings,
  loadImageGenSettings,
  maskImageGenSettings,
  saveImageGenSettings,
} from "./image-gen-settings.ts";

// Re-export Entity-Core LLM settings
export type { EntityCoreLLMSettings } from "./entity-core-settings.ts";
export {
  getDefaultEntityCoreLLMSettings,
  loadEntityCoreLLMSettings,
  saveEntityCoreLLMSettings,
} from "./entity-core-settings.ts";

// Re-export Lovense settings
export type { LovenseSettings } from "./lovense-settings.ts";
export {
  getDefaultLovenseSettings,
  loadLovenseSettings,
  saveLovenseSettings,
} from "./lovense-settings.ts";

// Re-export Buttplug settings
export type { ButtplugSettings } from "./buttplug-settings.ts";
export {
  getDefaultButtplugSettings,
  loadButtplugSettings,
  saveButtplugSettings,
} from "./buttplug-settings.ts";

// Re-export BLE device bridge settings
export type {
  BLEDevice,
  BLESettings,
  BLEStreamConfig,
} from "./ble-settings.ts";
export {
  ensureStream,
  getDefaultBLESettings,
  getDefaultStreamConfig,
  loadBLESettings,
  saveBLESettings,
} from "./ble-settings.ts";

// Re-export Voice chat settings
export type {
  AudioEffect,
  AudioEffectType,
  BrowserSTTSettings,
  CustomSTTSettings,
  CustomTTSSettings,
  DeepgramSTTSettings,
  ElevenLabsTTSSettings,
  MinimaxTTSSettings,
  OpenAISTTSettings,
  OpenAITTSSettings,
  PronunciationEntry,
  STTCorrectionEntry,
  VoiceProfile,
  VoiceProviderSettings,
  VoiceSettings,
  VoiceSTTProvider,
  VoiceTTSProvider,
} from "./voice-settings.ts";
export {
  getDefaultVoiceSettings,
  loadVoiceSettings,
  maskVoiceSettings,
  normalizeVoiceProfile,
  saveVoiceSettings,
} from "./voice-settings.ts";
