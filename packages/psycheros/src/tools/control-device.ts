/**
 * Control Device Tool
 *
 * Allows the entity to control connected home automation devices such as
 * smart plugs. Supports turning devices on/off and checking power status.
 * Currently supports Shelly Plug devices via their local HTTP API.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { HomeDevice, HomeSettings } from "../llm/home-settings.ts";

// =============================================================================
// Shelly Plug Handler
// =============================================================================

interface ShellyRelayResponse {
  ison: boolean;
  has_timer: boolean;
  timer_started: number;
  timer_duration: number;
  timer_remaining: number;
  overpower: boolean;
  source: string;
}

/**
 * Control a Shelly smart plug via its local HTTP API.
 */
async function controlShellyPlug(
  address: string,
  action: "on" | "off" | "status",
): Promise<{ success: boolean; message: string }> {
  const baseUrl = `http://${address}/relay/0`;
  let url: string;

  switch (action) {
    case "on":
      url = `${baseUrl}?turn=on`;
      break;
    case "off":
      url = `${baseUrl}?turn=off`;
      break;
    case "status":
      url = baseUrl;
      break;
  }

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!resp.ok) {
      return {
        success: false,
        message: `Shelly API returned status ${resp.status}`,
      };
    }

    const data = await resp.json() as ShellyRelayResponse;

    if (action === "on") {
      return {
        success: true,
        message: `${address}: turned on (power state: ${
          data.ison ? "on" : "off"
        })`,
      };
    }
    if (action === "off") {
      return {
        success: true,
        message: `${address}: turned off (power state: ${
          data.ison ? "on" : "off"
        })`,
      };
    }
    // status
    return {
      success: true,
      message: `${address}: power is ${data.ison ? "on" : "off"}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to reach device at ${address}: ${errorMessage}`,
    };
  }
}

// =============================================================================
// Device Dispatch
// =============================================================================

/**
 * Dispatch a control action to the appropriate device handler based on type.
 */
function dispatchDeviceControl(
  device: HomeDevice,
  action: "on" | "off" | "status",
): Promise<{ success: boolean; message: string }> {
  switch (device.type) {
    case "shelly-plug":
      return controlShellyPlug(device.address, action);
    default:
      return Promise.resolve({
        success: false,
        message: `Unknown device type: '${device.type}'`,
      });
  }
}

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * The control_device tool lets the entity control connected home devices.
 */
export const controlDeviceTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "control_device",
      description:
        "Control a connected home device such as a smart plug. I use this to turn devices on or off and check their power status. Devices must be configured in External Connections > Home settings.",
      parameters: {
        type: "object",
        properties: {
          device: {
            type: "string",
            description:
              'The name of the configured device to control, e.g. "Coffee Maker".',
          },
          action: {
            type: "string",
            enum: ["on", "off", "status"],
            description:
              'The action to perform: "on" to power on, "off" to power off, "status" to check current power state.',
          },
        },
        required: ["device", "action"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const deviceName = args.device;
    const actionRaw = args.action;

    // Validate arguments
    if (typeof deviceName !== "string" || deviceName.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'device' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    if (
      typeof actionRaw !== "string" ||
      !["on", "off", "status"].includes(actionRaw)
    ) {
      return {
        toolCallId: ctx.toolCallId,
        content: 'Error: \'action\' must be one of "on", "off", or "status"',
        isError: true,
      };
    }

    const action = actionRaw as "on" | "off" | "status";

    // Get home settings from entity config
    const homeSettings = ctx.config.homeSettings as HomeSettings | undefined;

    if (
      !homeSettings || !homeSettings.devices ||
      homeSettings.devices.length === 0
    ) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "No home devices are configured. The user needs to add devices in External Connections > Home settings.",
        isError: false,
      };
    }

    // Find device by name (case-insensitive)
    const device = homeSettings.devices.find(
      (d) => d.name.toLowerCase() === deviceName.trim().toLowerCase(),
    );

    if (!device) {
      const available = homeSettings.devices.map((d) => d.name).join(", ");
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Device "${deviceName}" not found. Available devices: ${available}`,
        isError: true,
      };
    }

    if (!device.enabled) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Device "${deviceName}" is disabled. The user needs to enable it in Home settings.`,
        isError: true,
      };
    }

    // Dispatch to the appropriate handler
    const result = await dispatchDeviceControl(device, action);

    if (result.success) {
      console.log(
        `[Home] ${device.name} (${device.type}): ${action} → ${result.message}`,
      );
      return {
        toolCallId: ctx.toolCallId,
        content: result.message,
        isError: false,
      };
    } else {
      console.error(
        `[Home] ${device.name} (${device.type}): ${action} failed → ${result.message}`,
      );
      return {
        toolCallId: ctx.toolCallId,
        content: result.message,
        isError: true,
      };
    }
  },
};
