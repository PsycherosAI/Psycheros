/**
 * Device Status Cache
 *
 * Maintains a periodically-refreshed snapshot of connected devices across
 * all integrations (Lovense, Intiface, Home). The entity's situational
 * awareness block reads from this cache synchronously — zero turn latency.
 *
 * Lovense and Intiface are probed in the background every ~30 seconds.
 * Home devices are read from settings on demand (static config, no probing).
 */

import type { HomeSettings } from "../llm/home-settings.ts";
import type { LovenseSettings } from "../llm/lovense-settings.ts";
import type { ButtplugSettings } from "../llm/buttplug-settings.ts";
import { getDeviceBridge } from "./device-bridge.ts";

// =============================================================================
// Types
// =============================================================================

/** A connected Lovense toy. */
export interface LovenseToyInfo {
  name: string;
  battery: number;
  nickname: string;
}

/** Snapshot of connected Lovense toys. */
export interface LovenseDeviceStatus {
  connected: boolean;
  toys: LovenseToyInfo[];
}

/** A connected Intiface device. */
export interface IntifaceDeviceInfo {
  name: string;
}

/** Snapshot of connected Intiface devices. */
export interface IntifaceDeviceStatus {
  connected: boolean;
  devices: IntifaceDeviceInfo[];
}

/** A configured home device (from settings, not probed). */
export interface HomeDeviceInfo {
  name: string;
  type: string;
}

/** A connected BLE device (from the device bridge). */
export interface BLEDeviceInfo {
  id: string;
  name: string;
  type: string;
}

/** Combined snapshot for SA consumption. */
export interface DeviceCacheSnapshot {
  lovense: LovenseDeviceStatus;
  intiface: IntifaceDeviceStatus;
  homeDevices: HomeDeviceInfo[];
  bleDevices: BLEDeviceInfo[];
}

// =============================================================================
// Device Status Cache
// =============================================================================

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

export class DeviceStatusCache {
  private lovenseStatus: LovenseDeviceStatus = { connected: false, toys: [] };
  private intifaceStatus: IntifaceDeviceStatus = {
    connected: false,
    devices: [],
  };
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private readonly homeSettings: () => HomeSettings | undefined;
  private readonly lovenseSettings: () => LovenseSettings | undefined;
  private readonly buttplugSettings: () => ButtplugSettings | undefined;

  constructor(opts: {
    homeSettings: () => HomeSettings | undefined;
    lovenseSettings: () => LovenseSettings | undefined;
    buttplugSettings: () => ButtplugSettings | undefined;
  }) {
    this.homeSettings = opts.homeSettings;
    this.lovenseSettings = opts.lovenseSettings;
    this.buttplugSettings = opts.buttplugSettings;
  }

  /**
   * Get the current device snapshot (synchronous, zero latency).
   * Home devices are read fresh from settings; Lovense and Intiface
   * come from the last background refresh.
   */
  getSnapshot(): DeviceCacheSnapshot {
    // Home devices: read from settings, filter to enabled only
    const home = this.homeSettings();
    const homeDevices: HomeDeviceInfo[] = home?.devices
      ?.filter((d) => d.enabled)
      .map((d) => ({ name: d.name, type: d.type })) ?? [];

    // BLE devices: read from device bridge (live connections)
    const bridge = getDeviceBridge();
    const bleDevices: BLEDeviceInfo[] = bridge.connectedDeviceList;

    return {
      lovense: this.lovenseStatus,
      intiface: this.intifaceStatus,
      homeDevices,
      bleDevices,
    };
  }

  /** Start the periodic refresh interval. */
  start(intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS): void {
    if (this.intervalId !== null) return;
    // Seed immediately (non-blocking)
    this.refreshAll();
    this.intervalId = setInterval(() => this.refreshAll(), intervalMs);
  }

  /** Stop the periodic refresh interval. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // ===========================================================================
  // Refresh
  // ===========================================================================

  /** Probe both Lovense and Intiface in parallel. Failures keep last known state. */
  refreshAll(): void {
    Promise.allSettled([
      this.refreshLovense(),
      this.refreshIntiface(),
    ]);
  }

  /**
   * Probe Lovense Connect for all connected toys.
   * Adapted from handleLovenseStatus in routes.ts.
   * Returns ALL connected toys (not just the first).
   */
  private async refreshLovense(): Promise<void> {
    const settings = this.lovenseSettings();
    if (!settings?.enabled || !settings.connection.domain) {
      this.lovenseStatus = { connected: false, toys: [] };
      return;
    }

    try {
      const { domain, port, secure } = settings.connection;
      const baseUrl = `${secure ? "https" : "http"}://${domain}:${port}`;

      const resp = await fetch(`${baseUrl}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "GetToys" }),
        signal: AbortSignal.timeout(3000),
      });

      if (!resp.ok) return; // Keep last known state

      const data = await resp.json() as {
        code: number;
        data?: { toys: string };
      };

      // API responded but no toys data — toys are disconnected
      if (data.code !== 200 || !data.data?.toys) {
        this.lovenseStatus = { connected: false, toys: [] };
        return;
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

      // Collect ALL connected toys (not just the first)
      const connectedToys = Object.values(toysMap)
        .filter((t) => t.status === "1")
        .map((t) => ({
          name: t.name,
          battery: t.battery,
          nickname: t.nickName || "",
        }));

      this.lovenseStatus = {
        connected: connectedToys.length > 0,
        toys: connectedToys,
      };
    } catch {
      // Keep last known state on failure
    }
  }

  /**
   * Probe Intiface Central for connected devices.
   * Adapted from handleButtplugStatus in routes.ts.
   */
  private async refreshIntiface(): Promise<void> {
    const settings = this.buttplugSettings();
    if (!settings?.enabled) {
      this.intifaceStatus = { connected: false, devices: [] };
      return;
    }

    try {
      const { ButtplugClient } = await import("@zendrex/buttplug.js");
      const client = new ButtplugClient(
        settings.websocketUrl || "ws://127.0.0.1:12345",
      );

      try {
        await client.connect();
        await client.startScanning();
        // Wait for scanning to find already-connected devices
        await new Promise((r) => setTimeout(r, 2000));

        const devices = client.devices;
        this.intifaceStatus = {
          connected: devices.length > 0,
          devices: devices.map((d) => ({
            name: d.displayName || d.name,
          })),
        };
      } finally {
        try {
          await client.disconnect();
        } catch {
          // Ignore disconnect errors
        }
        client.dispose();
      }
    } catch {
      // Keep last known state on failure
    }
  }
}
