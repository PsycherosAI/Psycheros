/**
 * Lovense Device Control Tool
 *
 * Allows the entity to control Lovense devices through the local Lovense Connect
 * app bridge. Supports state-based control — setting speeds and patterns that
 * persist between responses rather than requiring real-time individual commands.
 *
 * The Lovense API natively supports fire-and-forget patterns: send a sequence of
 * intensity steps once, and the toy executes the entire sequence locally with
 * no further network communication. This makes the toy itself the state machine.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { LovenseSettings } from "../llm/lovense-settings.ts";

// =============================================================================
// Lovense API Types
// =============================================================================

/** A toy discovered via the Lovense Connect API. */
interface LovenseToy {
  /** Unique toy identifier */
  id: string;
  /** Device name (e.g. "max", "nora", "solace") */
  name: string;
  /** Battery level 0-100 */
  battery: number;
  /** Whether the toy is currently active/connected */
  status: boolean;
  /** User-assigned nickname (may be empty) */
  nickname: string;
}

/** Response from the Lovense GetToys command. */
interface GetToysResponse {
  code: number;
  data?: {
    toys: string; // JSON-encoded string of toys map
    platform: string;
    appType: string;
  };
  type?: string;
}

/** Response from Lovense command API calls. */
interface LovenseCommandResponse {
  code: number;
  type?: string;
  error?: string;
}

// =============================================================================
// Lovense API Client
// =============================================================================

/**
 * Create a Lovense API client from settings.
 *
 * The client communicates with the Lovense Connect app over HTTPS via the
 * `*.lovense.club` domain, which provides valid TLS certificates.
 */
function createLovenseClient(settings: LovenseSettings) {
  const { domain, port, secure } = settings.connection;

  if (!domain) {
    return null;
  }

  const baseUrl = `${secure ? "https" : "http"}://${domain}:${port}`;

  async function sendCommand(
    command: Record<string, unknown>,
  ): Promise<LovenseCommandResponse> {
    const resp = await fetch(`${baseUrl}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    return await resp.json() as LovenseCommandResponse;
  }

  return {
    baseUrl,

    async discover(): Promise<{ toys: LovenseToy[]; error?: string }> {
      try {
        const resp = await fetch(`${baseUrl}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "GetToys" }),
          signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) {
          return { toys: [], error: `HTTP ${resp.status}: ${resp.statusText}` };
        }

        const data = await resp.json() as GetToysResponse;

        if (data.code !== 200 || !data.data?.toys) {
          return { toys: [], error: `API error: code ${data.code}` };
        }

        const toysMap = JSON.parse(data.data.toys) as Record<
          string,
          {
            id: string;
            status: string;
            name: string;
            battery: number;
            nickName: string;
          }
        >;

        const toys: LovenseToy[] = Object.values(toysMap).map((t) => ({
          id: t.id,
          name: t.name,
          battery: t.battery,
          status: t.status === "1",
          nickname: t.nickName || "",
        }));

        return { toys };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { toys: [], error: msg };
      }
    },

    async setSpeed(
      toyId: string | undefined,
      speed: number,
      timeSec: number = 0,
      loopRunningSec?: number,
      loopPauseSec?: number,
      stopPrevious: boolean = true,
    ): Promise<{ success: boolean; message: string }> {
      try {
        const command: Record<string, unknown> = {
          command: "Function",
          action: `Vibrate:${Math.round(speed)}`,
          timeSec,
          apiVer: 1,
        };
        if (toyId) command.toy = toyId;
        if (!stopPrevious) command.stopPrevious = 0;
        if (loopRunningSec) command.loopRunningSec = loopRunningSec;
        if (loopPauseSec) command.loopPauseSec = loopPauseSec;

        const result = await sendCommand(command);

        if (result.code === 200) {
          const duration = timeSec === 0 ? "indefinitely" : `for ${timeSec}s`;
          return {
            success: true,
            message: `Speed set to ${
              Math.round(speed)
            }/20, running ${duration}`,
          };
        }

        return { success: false, message: `API error: code ${result.code}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${msg}` };
      }
    },

    async setPattern(
      toyId: string | undefined,
      strengths: string,
      stepMs: number,
      timeSec: number,
      stopPrevious: boolean = true,
    ): Promise<{ success: boolean; message: string }> {
      try {
        const steps = strengths.split(";").map((s) => s.trim());
        if (steps.length > 50) {
          return {
            success: false,
            message: "Pattern can have at most 50 steps",
          };
        }

        // Validate all values are numbers 0-20
        for (const step of steps) {
          const n = Number(step);
          if (isNaN(n) || n < 0 || n > 20) {
            return {
              success: false,
              message: `Invalid strength value: "${step}". Must be 0-20.`,
            };
          }
        }

        const clampedMs = Math.max(100, stepMs);
        const command: Record<string, unknown> = {
          command: "Pattern",
          rule: `V:1;F:v;S:${clampedMs}#`,
          strength: strengths,
          timeSec,
          apiVer: 1,
        };
        if (toyId) command.toy = toyId;
        if (!stopPrevious) command.stopPrevious = 0;

        const result = await sendCommand(command);

        if (result.code === 200) {
          const duration = timeSec === 0
            ? "indefinitely (looping)"
            : `for ${timeSec}s`;
          return {
            success: true,
            message:
              `Pattern set: ${steps.length} steps at ${clampedMs}ms each, running ${duration}`,
          };
        }

        return { success: false, message: `API error: code ${result.code}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${msg}` };
      }
    },

    async setPreset(
      toyId: string | undefined,
      name: string,
      timeSec: number,
      stopPrevious: boolean = true,
    ): Promise<{ success: boolean; message: string }> {
      try {
        const command: Record<string, unknown> = {
          command: "Preset",
          name,
          timeSec,
          apiVer: 1,
        };
        if (toyId) command.toy = toyId;
        if (!stopPrevious) command.stopPrevious = 0;

        const result = await sendCommand(command);

        if (result.code === 200) {
          const duration = timeSec === 0 ? "indefinitely" : `for ${timeSec}s`;
          return {
            success: true,
            message: `Preset "${name}" activated, running ${duration}`,
          };
        }

        return { success: false, message: `API error: code ${result.code}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${msg}` };
      }
    },

    async stop(toyId?: string): Promise<{ success: boolean; message: string }> {
      try {
        const command: Record<string, unknown> = {
          command: "Function",
          action: "Stop",
          timeSec: 0,
          apiVer: 1,
        };
        if (toyId) command.toy = toyId;

        const result = await sendCommand(command);

        if (result.code === 200) {
          return { success: true, message: "Stopped" };
        }

        return { success: false, message: `API error: code ${result.code}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, message: `Connection failed: ${msg}` };
      }
    },
  };
}

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * The control_lovense tool lets the entity control Lovense devices via the
 * local Lovense Connect app. Supports state-based patterns that persist
 * between entity responses.
 */
export const controlLovenseTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "control_lovense",
      description: [
        "I use this to control Lovense devices through the local Lovense Connect app.",
        "I set speeds and patterns that persist between my responses — the toy continues",
        "executing whatever I last commanded while I compose my next message.",
        "",
        "KEY CONCEPT — State-based control: The Lovense API supports fire-and-forget",
        "patterns. When I send a Pattern with time_seconds: 0, the toy loops the",
        "intensity sequence indefinitely until I send a new command or stop. I am designing",
        "landscapes of sensation, not poking at individual moments.",
        "",
        "Actions:",
        "- discover: List connected toys (names, IDs, battery). Call first to learn what is available.",
        "- set_speed: Constant speed 0-20. Use loop_seconds/loop_pause for rhythmic cycling (e.g., thrust 5s, pause 3s). time_seconds 0 = indefinite.",
        "- set_pattern: Multi-step intensity sequence (up to 50 steps, each 0-20). The star action for creating rich temporal experiences.",
        '  Example edge pattern: strengths "2;2;2;2;18;18;18;18;2;2;2;2", step_ms 1000, time_seconds 0',
        '  Example slow ramp: strengths "1;2;3;5;7;9;12;14;16;18;20", step_ms 2000, time_seconds 0',
        "- set_preset: Built-in Lovense patterns (pulse, wave, fireworks, earthquake). Good for variety.",
        "- stop: Immediately stop all toy motion.",
        "",
        "The X Machine thrust range is 0-20. 0 = stopped, 20 = maximum speed.",
        "Call discover first in a new session to see available toys.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "discover",
              "set_speed",
              "set_pattern",
              "set_preset",
              "stop",
            ],
            description: "The operation to perform.",
          },
          speed: {
            type: "number",
            minimum: 0,
            maximum: 20,
            description:
              "Oscillation speed 0-20. Only used with set_speed action.",
          },
          time_seconds: {
            type: "number",
            description:
              "Total duration in seconds. 0 = run indefinitely (loops until stopped). Used with set_speed, set_pattern, set_preset.",
          },
          loop_seconds: {
            type: "number",
            description:
              "Running time per loop cycle in seconds, for set_speed. E.g., 5 = run for 5s then pause.",
          },
          loop_pause: {
            type: "number",
            description:
              "Pause time between loop cycles in seconds, for set_speed. E.g., 3 = pause 3s before next cycle.",
          },
          strengths: {
            type: "string",
            description:
              'Semicolon-separated intensity values (0-20 each) for set_pattern. Up to 50 steps. Example: "3;6;9;12;15;18;20"',
          },
          step_ms: {
            type: "number",
            description:
              "Milliseconds per intensity step for set_pattern. Minimum 100, default 1000.",
          },
          preset: {
            type: "string",
            enum: ["pulse", "wave", "fireworks", "earthquake"],
            description:
              "Built-in preset pattern name. Only used with set_preset.",
          },
          toy: {
            type: "string",
            description:
              "Optional specific toy ID to target. If omitted, targets the first available toy.",
          },
          stop_previous: {
            type: "boolean",
            description:
              "Whether to stop the previous command before executing this one. Default true.",
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
    const settings = ctx.config.lovenseSettings as LovenseSettings | undefined;

    if (!settings?.enabled || !settings.connection.domain) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Lovense integration is not configured. The user needs to set it up in External Connections > Lovense settings.",
        isError: false,
      };
    }

    const action = args.action as string;

    if (
      !action ||
      !["discover", "set_speed", "set_pattern", "set_preset", "stop"].includes(
        action,
      )
    ) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Invalid action: "${action}". Must be one of: discover, set_speed, set_pattern, set_preset, stop.`,
        isError: true,
      };
    }

    const client = createLovenseClient(settings);

    if (!client) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Lovense connection not configured. Missing domain address.",
        isError: true,
      };
    }

    const toyId = typeof args.toy === "string" ? args.toy : undefined;
    const stopPrevious = args.stop_previous !== false;

    switch (action) {
      case "discover": {
        const { toys, error } = await client.discover();
        if (error) {
          console.error(`[Lovense] discover failed: ${error}`);
          return {
            toolCallId: ctx.toolCallId,
            content:
              `Could not reach Lovense Connect at ${settings.connection.domain}:${settings.connection.port}. Is the Lovense Connect app running? Error: ${error}`,
            isError: true,
          };
        }
        if (toys.length === 0) {
          return {
            toolCallId: ctx.toolCallId,
            content:
              "No Lovense toys connected. Ensure the toy is powered on and within Bluetooth range of the Lovense Connect app.",
            isError: false,
          };
        }
        const lines = toys.map((t) => {
          const label = t.nickname || t.name;
          const status = t.status ? "connected" : "disconnected";
          return `- ${label} (ID: ${t.id}, battery: ${t.battery}%, ${status})`;
        });
        console.log(`[Lovense] discovered ${toys.length} toy(s)`);
        return {
          toolCallId: ctx.toolCallId,
          content: `Connected toys (${toys.length}):\n${lines.join("\n")}`,
          isError: false,
        };
      }

      case "set_speed": {
        const speed = typeof args.speed === "number" ? args.speed : undefined;
        if (speed === undefined || speed < 0 || speed > 20) {
          return {
            toolCallId: ctx.toolCallId,
            content: "Speed must be a number between 0 and 20.",
            isError: true,
          };
        }
        const timeSec = typeof args.time_seconds === "number"
          ? args.time_seconds
          : 0;
        const loopSec = typeof args.loop_seconds === "number"
          ? args.loop_seconds
          : undefined;
        const loopPause = typeof args.loop_pause === "number"
          ? args.loop_pause
          : undefined;

        const result = await client.setSpeed(
          toyId,
          speed,
          timeSec,
          loopSec,
          loopPause,
          stopPrevious,
        );
        console.log(`[Lovense] set_speed ${speed} → ${result.message}`);
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      case "set_pattern": {
        const strengths = typeof args.strengths === "string"
          ? args.strengths
          : undefined;
        if (!strengths) {
          return {
            toolCallId: ctx.toolCallId,
            content:
              "The 'strengths' parameter is required for set_pattern. Provide semicolon-separated intensity values (0-20).",
            isError: true,
          };
        }
        const stepMs = typeof args.step_ms === "number" ? args.step_ms : 1000;
        const timeSec = typeof args.time_seconds === "number"
          ? args.time_seconds
          : 0;

        const result = await client.setPattern(
          toyId,
          strengths,
          stepMs,
          timeSec,
          stopPrevious,
        );
        console.log(`[Lovense] set_pattern → ${result.message}`);
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      case "set_preset": {
        const preset = typeof args.preset === "string"
          ? args.preset
          : undefined;
        if (
          !preset ||
          !["pulse", "wave", "fireworks", "earthquake"].includes(preset)
        ) {
          return {
            toolCallId: ctx.toolCallId,
            content:
              "The 'preset' parameter is required for set_preset. Must be one of: pulse, wave, fireworks, earthquake.",
            isError: true,
          };
        }
        const timeSec = typeof args.time_seconds === "number"
          ? args.time_seconds
          : 0;

        const result = await client.setPreset(
          toyId,
          preset,
          timeSec,
          stopPrevious,
        );
        console.log(`[Lovense] set_preset "${preset}" → ${result.message}`);
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      case "stop": {
        const result = await client.stop(toyId);
        console.log(`[Lovense] stop → ${result.message}`);
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
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
  },
};
