/**
 * Universal Toy Control Tool
 *
 * Allows the entity to control intimate hardware through a universal protocol
 * (Intiface Central). Supports a wide range of devices across many
 * manufacturers — not limited to a single brand.
 *
 * Connects over WebSocket to the Intiface server (default ws://127.0.0.1:12345).
 * All output values are normalized 0–1. Supports vibration, rotation, position,
 * oscillation, constriction, and preset patterns via the PatternEngine.
 *
 * The client is created per-action with a short-lived connection to avoid
 * stale state — each tool invocation connects, acts, and disconnects.
 */

import { ButtplugClient, PatternEngine } from "@zendrex/buttplug.js";
import type { Device } from "@zendrex/buttplug.js";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { ButtplugSettings } from "../llm/buttplug-settings.ts";

// =============================================================================
// Tool Definition
// =============================================================================

/** Available pattern preset names. */
const PRESET_NAMES = [
  "pulse",
  "wave",
  "ramp_up",
  "ramp_down",
  "heartbeat",
  "surge",
  "stroke",
] as const;

/**
 * The control_toy tool lets the entity control devices through a universal
 * protocol via Intiface Central. Supports vibration, rotation, position,
 * oscillation, constriction, and preset patterns.
 */
export const controlButtplugTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "control_toy",
      description: [
        "I use this to control intimate hardware through a universal protocol.",
        "I connect to Intiface Central over WebSocket and can discover and",
        "control a wide range of devices from many manufacturers.",
        "",
        "All output values are normalized 0–1 (0 = off, 1 = maximum).",
        "",
        "Actions:",
        "- discover: List connected devices (name, index, capabilities). Call first to learn what is available.",
        "- vibrate: Set vibration intensity 0–1. Optionally target a specific device index.",
        "- rotate: Set rotation speed 0–1 with optional clockwise/counterclockwise direction.",
        "- position: Set linear position 0–1. Optional duration in ms for movement time.",
        "- oscillate: Set oscillation speed 0–1 (thrusting/linear movement).",
        "- constrict: Set constriction/inflation 0–1 (suction-type devices).",
        "- pattern: Play a built-in pattern preset (pulse, wave, heartbeat, etc.).",
        "  Parameters: preset name, intensity 0–1, speed multiplier, and whether to loop.",
        "- stop: Immediately stop all devices.",
        "",
        "The 'device_index' parameter targets a specific device (from discover).",
        "If omitted, the first available device is used.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "discover",
              "vibrate",
              "rotate",
              "position",
              "oscillate",
              "constrict",
              "pattern",
              "stop",
            ],
            description: "The operation to perform.",
          },
          intensity: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "Output intensity 0–1. Used with vibrate, rotate, oscillate, constrict, and pattern actions.",
          },
          clockwise: {
            type: "boolean",
            description:
              "Rotation direction. Only used with rotate. Default true.",
          },
          duration_ms: {
            type: "number",
            description:
              "Movement duration in milliseconds. Only used with position for timed movement.",
          },
          preset: {
            type: "string",
            enum: [
              "pulse",
              "wave",
              "ramp_up",
              "ramp_down",
              "heartbeat",
              "surge",
              "stroke",
            ],
            description: "Pattern preset name. Only used with pattern action.",
          },
          speed: {
            type: "number",
            description:
              "Pattern speed multiplier (0.5 = half speed, 2 = double). Only used with pattern action. Default 1.",
          },
          loop: {
            type: "boolean",
            description:
              "Whether the pattern loops. Only used with pattern action. Default true.",
          },
          device_index: {
            type: "number",
            description:
              "Target a specific device by index (from discover). If omitted, targets the first device.",
          },
        },
        required: ["action"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const settings = ctx.config.buttplugSettings as
      | ButtplugSettings
      | undefined;

    if (!settings?.enabled) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Toy control integration is not enabled. The user needs to enable it in External Connections > Intimacy settings.",
        isError: false,
      };
    }

    const action = args.action as string;

    const validActions = [
      "discover",
      "vibrate",
      "rotate",
      "position",
      "oscillate",
      "constrict",
      "pattern",
      "stop",
    ];
    if (!action || !validActions.includes(action)) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Invalid action: "${action}". Must be one of: ${
          validActions.join(", ")
        }.`,
        isError: true,
      };
    }

    const deviceIndex = typeof args.device_index === "number"
      ? args.device_index
      : undefined;
    const url = settings.websocketUrl || "ws://127.0.0.1:12345";

    // Create a per-action client — connect, act, disconnect
    const client = new ButtplugClient(url);

    try {
      await client.connect();
      if (action !== "discover" && action !== "stop") {
        await client.startScanning();
        // Give scanning a moment to find already-connected devices
        await new Promise((r) => setTimeout(r, 500));
      }

      // For discover, we need to start scanning first
      if (action === "discover") {
        await client.startScanning();
        // Wait for scanning to find devices
        await new Promise((r) => setTimeout(r, 2000));
      }

      const devices = client.devices;

      switch (action) {
        case "discover": {
          if (devices.length === 0) {
            console.log("[Buttplug] discover: no devices found");
            return {
              toolCallId: ctx.toolCallId,
              content:
                "No devices found. Ensure Intiface Central is running and devices are connected/paired. You may need to click 'Start Scanning' in Intiface Central first.",
              isError: false,
            };
          }

          const lines = devices.map((d) => {
            const label = d.displayName || d.name;
            const caps: string[] = [];
            for (
              const type of [
                "Vibrate",
                "Rotate",
                "Position",
                "Oscillate",
                "Constrict",
              ] as const
            ) {
              if (d.canOutput(type)) caps.push(type);
            }
            return `- ${label} (index: ${d.index}, capabilities: ${
              caps.join(", ") || "none"
            })`;
          });

          console.log(`[Buttplug] discovered ${devices.length} device(s)`);
          return {
            toolCallId: ctx.toolCallId,
            content: `Connected devices (${devices.length}):\n${
              lines.join("\n")
            }`,
            isError: false,
          };
        }

        case "vibrate": {
          const intensity = clampIntensity(args.intensity);
          const device = resolveDevice(devices, deviceIndex);
          if (!device) return noDeviceResult(ctx.toolCallId, devices);
          if (!device.canOutput("Vibrate")) {
            return noCapabilityResult(ctx.toolCallId, device, "Vibrate");
          }

          await device.vibrate(intensity);
          console.log(
            `[Buttplug] vibrate ${device.displayName} → ${intensity}`,
          );
          return {
            toolCallId: ctx.toolCallId,
            content: `Vibration set to ${intensity} on ${
              device.displayName || `device ${device.index}`
            }.`,
            isError: false,
          };
        }

        case "rotate": {
          const intensity = clampIntensity(args.intensity);
          const device = resolveDevice(devices, deviceIndex);
          if (!device) return noDeviceResult(ctx.toolCallId, devices);
          if (!device.canOutput("Rotate")) {
            return noCapabilityResult(ctx.toolCallId, device, "Rotate");
          }

          const clockwise = args.clockwise !== false;
          await device.rotate(intensity, { clockwise });
          console.log(
            `[Buttplug] rotate ${device.displayName} → ${intensity} (${
              clockwise ? "CW" : "CCW"
            })`,
          );
          return {
            toolCallId: ctx.toolCallId,
            content: `Rotation set to ${intensity} (${
              clockwise ? "clockwise" : "counter-clockwise"
            }) on ${device.displayName || `device ${device.index}`}.`,
            isError: false,
          };
        }

        case "position": {
          const intensity = clampIntensity(args.intensity);
          const device = resolveDevice(devices, deviceIndex);
          if (!device) return noDeviceResult(ctx.toolCallId, devices);
          if (!device.canOutput("Position")) {
            return noCapabilityResult(ctx.toolCallId, device, "Position");
          }

          const durationMs = typeof args.duration_ms === "number"
            ? args.duration_ms
            : 500;
          await device.position([{
            index: 0,
            position: intensity,
            duration: durationMs,
          }]);
          console.log(
            `[Buttplug] position ${device.displayName} → ${intensity} (${durationMs}ms)`,
          );
          return {
            toolCallId: ctx.toolCallId,
            content: `Position set to ${intensity} on ${
              device.displayName || `device ${device.index}`
            } (over ${durationMs}ms).`,
            isError: false,
          };
        }

        case "oscillate": {
          const intensity = clampIntensity(args.intensity);
          const device = resolveDevice(devices, deviceIndex);
          if (!device) return noDeviceResult(ctx.toolCallId, devices);
          if (!device.canOutput("Oscillate")) {
            return noCapabilityResult(ctx.toolCallId, device, "Oscillate");
          }

          await device.oscillate(intensity);
          console.log(
            `[Buttplug] oscillate ${device.displayName} → ${intensity}`,
          );
          return {
            toolCallId: ctx.toolCallId,
            content: `Oscillation speed set to ${intensity} on ${
              device.displayName || `device ${device.index}`
            }.`,
            isError: false,
          };
        }

        case "constrict": {
          const intensity = clampIntensity(args.intensity);
          const device = resolveDevice(devices, deviceIndex);
          if (!device) return noDeviceResult(ctx.toolCallId, devices);
          if (!device.canOutput("Constrict")) {
            return noCapabilityResult(ctx.toolCallId, device, "Constrict");
          }

          await device.constrict(intensity);
          console.log(
            `[Buttplug] constrict ${device.displayName} → ${intensity}`,
          );
          return {
            toolCallId: ctx.toolCallId,
            content: `Constriction set to ${intensity} on ${
              device.displayName || `device ${device.index}`
            }.`,
            isError: false,
          };
        }

        case "pattern": {
          const preset = typeof args.preset === "string"
            ? args.preset
            : undefined;
          if (
            !preset ||
            !PRESET_NAMES.includes(preset as typeof PRESET_NAMES[number])
          ) {
            return {
              toolCallId: ctx.toolCallId,
              content: `Invalid preset: "${preset}". Must be one of: ${
                PRESET_NAMES.join(", ")
              }.`,
              isError: true,
            };
          }

          const idx = deviceIndex ?? 0;
          if (!devices[idx]) return noDeviceResult(ctx.toolCallId, devices);

          const intensity = clampIntensity(args.intensity, 0.8);
          const speed = typeof args.speed === "number" ? args.speed : 1.0;
          const loop = args.loop !== false;

          // deno-lint-ignore no-explicit-any
          const engine = new PatternEngine(client as any);
          try {
            await engine.play(idx, preset as typeof PRESET_NAMES[number], {
              intensity,
              speed,
              loop,
            });
            const device = devices[idx];
            console.log(
              `[Buttplug] pattern "${preset}" on ${device?.displayName} → intensity ${intensity}, speed ${speed}, loop ${loop}`,
            );
            return {
              toolCallId: ctx.toolCallId,
              content: `Pattern "${preset}" started on ${
                device?.displayName || `device ${idx}`
              } (intensity ${intensity}, speed ${speed}x, ${
                loop ? "looping" : "one-shot"
              }).`,
              isError: false,
            };
          } finally {
            engine.dispose();
          }
        }

        case "stop": {
          await client.stopAll();
          console.log("[Buttplug] stop all");
          return {
            toolCallId: ctx.toolCallId,
            content: "All devices stopped.",
            isError: false,
          };
        }

        default: {
          return {
            toolCallId: ctx.toolCallId,
            content: `Unknown action: ${action}`,
            isError: true,
          };
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Buttplug] ${action} failed: ${msg}`);
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Device error (${action}): ${msg}. Is Intiface Central running at ${url}?`,
        isError: true,
      };
    } finally {
      try {
        await client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      client.dispose();
    }
  },
};

// =============================================================================
// Helpers
// =============================================================================

/** Clamp an intensity value to 0–1, returning a default if not provided. */
function clampIntensity(value: unknown, defaultValue: number = 0.5): number {
  if (typeof value !== "number" || isNaN(value)) return defaultValue;
  return Math.min(1, Math.max(0, value));
}

/** Resolve a device from the list by index, or return the first device. */
function resolveDevice(
  devices: readonly Device[],
  index: number | undefined,
): Device | null {
  if (devices.length === 0) return null;
  if (index !== undefined) return devices[index] ?? null;
  return devices[0] ?? null;
}

/** Build an error result when no devices are available. */
function noDeviceResult(
  toolCallId: string,
  devices: readonly Device[],
): ToolResult {
  return {
    toolCallId,
    content: devices.length === 0
      ? "No devices connected. Call discover first to find devices, or ensure devices are paired in Intiface Central."
      : "Invalid device index. Use the index from discover to target a specific device.",
    isError: true,
  };
}

/** Build an error result when a device lacks the required capability. */
function noCapabilityResult(
  toolCallId: string,
  device: Device,
  capability: string,
): ToolResult {
  return {
    toolCallId,
    content: `Device ${
      device.displayName || device.index
    } does not support ${capability}.`,
    isError: true,
  };
}
