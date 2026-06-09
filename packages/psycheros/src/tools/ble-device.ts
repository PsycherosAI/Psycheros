/**
 * BLE Device Tool
 *
 * Allows the entity to send commands to BLE devices connected through
 * the device bridge. Supports sending commands, querying recent data,
 * and listing connected devices. Devices must be configured in External
 * Connections > BLE settings with an active bridge client connected.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { BLESettings } from "../llm/ble-settings.ts";
import { getDeviceBridge } from "../server/device-bridge.ts";
import { getWearableConnectionManager } from "../wearable/mod.ts";

// =============================================================================
// Tool Definition
// =============================================================================

/**
 * The ble_device tool lets the entity communicate with BLE devices
 * through the device bridge.
 */
export const bleDeviceTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "ble_device",
      description:
        "I send commands to connected BLE (Bluetooth Low Energy) devices " +
        "through my device bridge. I can send commands and read recent data " +
        "from devices like smartwatches, sensors, and other BLE peripherals. " +
        "Devices must be configured in External Connections > BLE settings " +
        "and have an active bridge client connected.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["send", "query", "list"],
            description:
              '"send" to send a command to a device, "query" to read recent ' +
              'data from a device, "list" to list all connected BLE devices.',
          },
          device: {
            type: "string",
            description: "The name or ID of the configured BLE device. " +
              "Required for 'send' and 'query' actions.",
          },
          command: {
            type: "string",
            description:
              'The command to send to the device. Required for "send" action. ' +
              "Device-specific — for example, a Bangle.js might accept " +
              '"vibrate", "buzz", or custom JSON commands.',
          },
          params: {
            type: "object",
            description:
              "Optional parameters for the command. Passed through to the device.",
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
    const action = args.action as string;
    const bridge = getDeviceBridge();

    switch (action) {
      case "list":
        return handleList(bridge, ctx);
      case "send":
        return handleSend(args, bridge, ctx);
      case "query":
        return handleQuery(args, bridge, ctx);
      default:
        return {
          toolCallId: ctx.toolCallId,
          content:
            `Unknown action "${action}". Use "send", "query", or "list".`,
          isError: true,
        };
    }
  },
};

// =============================================================================
// Action Handlers
// =============================================================================

function handleList(
  bridge: ReturnType<typeof getDeviceBridge>,
  ctx: ToolContext,
): ToolResult {
  const devices = bridge.connectedDeviceList;

  if (devices.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "No BLE devices are currently connected through the bridge. " +
        "A bridge client (browser tab or app) must be open with a paired device.",
      isError: false,
    };
  }

  const lines = devices.map((d) => `- ${d.name} (${d.type}, id: ${d.id})`);
  return {
    toolCallId: ctx.toolCallId,
    content: `Connected BLE devices:\n${lines.join("\n")}`,
    isError: false,
  };
}

async function handleSend(
  args: Record<string, unknown>,
  bridge: ReturnType<typeof getDeviceBridge>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const deviceName = args.device;
  const command = args.command;

  if (typeof deviceName !== "string" || deviceName.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'device' argument is required for 'send' action.",
      isError: true,
    };
  }

  if (typeof command !== "string" || command.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'command' argument is required for 'send' action.",
      isError: true,
    };
  }

  // Look up device from settings
  const bleSettings = ctx.config.bleSettings as BLESettings | undefined;
  const device = findDevice(bleSettings, deviceName);

  if (!device) {
    const available = bleSettings?.devices.map((d) => d.name).join(", ") ??
      "(none configured)";
    return {
      toolCallId: ctx.toolCallId,
      content:
        `BLE device "${deviceName}" not found in settings. Configured devices: ${available}`,
      isError: true,
    };
  }

  if (!device.enabled) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `BLE device "${device.name}" is disabled. Enable it in External Connections > BLE settings.`,
      isError: true,
    };
  }

  if (!bridge.isDeviceConnected(device.id)) {
    // Device not on bridge — try wearable connection manager (entity-plexus)
    const wearableMgr = getWearableConnectionManager();
    if (wearableMgr.isDeviceConnected(device.id)) {
      const sent = wearableMgr.sendCommand(device.id, command);
      if (sent) {
        console.log(
          `[BLE] ${device.name}: sent "${command}" via wearable (fire-and-forget)`,
        );
        return {
          toolCallId: ctx.toolCallId,
          content:
            `Command "${command}" sent to ${device.name} via wearable connection.`,
          isError: false,
        };
      }
    }

    return {
      toolCallId: ctx.toolCallId,
      content:
        `BLE device "${device.name}" (id: ${device.id}) is not connected through ` +
        "any bridge client or wearable app. A bridge client or entity-plexus must be connected.",
      isError: true,
    };
  }

  // Send command and await response
  const params = args.params as Record<string, unknown> | undefined;
  try {
    const response = await bridge.sendCommand(device.id, command, params);

    if (response.success) {
      const dataStr = response.data
        ? ` Data: ${JSON.stringify(response.data)}`
        : "";
      console.log(
        `[BLE] ${device.name}: sent "${command}" → success${dataStr}`,
      );
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Command "${command}" sent to ${device.name} successfully.${dataStr}`,
        isError: false,
      };
    } else {
      console.error(
        `[BLE] ${device.name}: sent "${command}" → failed: ${response.error}`,
      );
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Command "${command}" to ${device.name} failed: ${response.error}`,
        isError: true,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[BLE] ${device.name}: sent "${command}" → error: ${message}`,
    );
    return {
      toolCallId: ctx.toolCallId,
      content: `Command "${command}" to ${device.name} errored: ${message}`,
      isError: true,
    };
  }
}

function handleQuery(
  args: Record<string, unknown>,
  bridge: ReturnType<typeof getDeviceBridge>,
  ctx: ToolContext,
): ToolResult {
  const deviceName = args.device;

  if (typeof deviceName !== "string" || deviceName.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'device' argument is required for 'query' action.",
      isError: true,
    };
  }

  // Look up device from settings
  const bleSettings = ctx.config.bleSettings as BLESettings | undefined;
  const device = findDevice(bleSettings, deviceName);

  if (!device) {
    return {
      toolCallId: ctx.toolCallId,
      content: `BLE device "${deviceName}" not found in settings.`,
      isError: true,
    };
  }

  const data = bridge.getRecentData(device.id, 20);

  if (data.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: `No recent data from ${device.name}.`,
      isError: false,
    };
  }

  const lines = data.map((entry) =>
    `[${new Date(entry.timestamp).toISOString()}] ${entry.type}: ${
      JSON.stringify(entry.data)
    }`
  );

  return {
    toolCallId: ctx.toolCallId,
    content: `Recent data from ${device.name} (last ${data.length} entries):\n${
      lines.join("\n")
    }`,
    isError: false,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Find a BLE device by name or ID (case-insensitive).
 */
function findDevice(
  bleSettings: BLESettings | undefined,
  nameOrId: string,
): (BLESettings["devices"])[number] | undefined {
  if (!bleSettings?.devices) return undefined;
  const lower = nameOrId.trim().toLowerCase();
  return bleSettings.devices.find(
    (d) => d.name.toLowerCase() === lower || d.id.toLowerCase() === lower,
  );
}
