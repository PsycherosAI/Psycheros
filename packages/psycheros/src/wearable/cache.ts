/**
 * Wearable Data Cache
 *
 * Stores the latest sensor readings per device from entity-plexus.
 * Synchronous reads for zero-latency SA access. Updated on each
 * incoming message (WebSocket or HTTP POST).
 *
 * Follows the same design as DeviceStatusCache: synchronous snapshot
 * getter, no async in the hot path.
 */

import type {
  DeviceSensorState,
  SensorReading,
  WearableCacheSnapshot,
} from "./types.ts";

/** Staleness threshold -- readings older than this are considered stale. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export class WearableDataCache {
  private static instance: WearableDataCache | null = null;
  private devices: Map<string, DeviceSensorState> = new Map();

  private constructor() {}

  static getInstance(): WearableDataCache {
    if (!WearableDataCache.instance) {
      WearableDataCache.instance = new WearableDataCache();
    }
    return WearableDataCache.instance;
  }

  /**
   * Ingest a batch of readings from one device.
   * Overwrites the per-type slot with the latest reading.
   */
  ingest(deviceId: string, readings: SensorReading[]): void {
    let state = this.devices.get(deviceId);
    if (!state) {
      state = { deviceId, lastSeen: 0 };
      this.devices.set(deviceId, state);
    }

    for (const reading of readings) {
      // Overwrite the per-type slot if the new reading is newer
      switch (reading.type) {
        case "sleep":
          if (!state.sleep || reading.timestamp >= state.sleep.timestamp) {
            state.sleep = reading;
          }
          break;
        case "hr":
          if (!state.hr || reading.timestamp >= state.hr.timestamp) {
            state.hr = reading;
          }
          break;
        case "accel":
          if (!state.accel || reading.timestamp >= state.accel.timestamp) {
            state.accel = reading;
          }
          break;
        case "battery":
          if (!state.battery || reading.timestamp >= state.battery.timestamp) {
            state.battery = reading;
          }
          break;
        case "gps":
          if (!state.gps || reading.timestamp >= state.gps.timestamp) {
            state.gps = reading;
          }
          break;
        case "screen":
          if (!state.screen || reading.timestamp >= state.screen.timestamp) {
            state.screen = reading;
          }
          break;
      }
    }

    state.lastSeen = Date.now();
  }

  /**
   * Get the full cache snapshot (synchronous, zero latency).
   * Callers should use this for SA block construction.
   */
  getSnapshot(): WearableCacheSnapshot {
    return {
      devices: new Map(this.devices),
      asOf: Date.now(),
    };
  }

  /**
   * Get sensor state for a single device.
   */
  getDevice(deviceId: string): DeviceSensorState | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Get all tracked device IDs.
   */
  getDeviceIds(): string[] {
    return [...this.devices.keys()];
  }

  /**
   * Check whether a reading is stale relative to the snapshot time.
   */
  isStale(readingTimestamp: number, now?: number): boolean {
    return (now ?? Date.now()) - readingTimestamp > STALE_THRESHOLD_MS;
  }

  /**
   * Remove a device from the cache.
   */
  removeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    this.devices.clear();
  }
}

/**
 * Get the global WearableDataCache instance.
 */
export function getWearableDataCache(): WearableDataCache {
  return WearableDataCache.getInstance();
}
