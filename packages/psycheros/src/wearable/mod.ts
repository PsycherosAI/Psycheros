/**
 * Wearable Data Pipeline Module
 *
 * Handles ingestion, caching, and command routing for wearable sensor data
 * from entity-plexus (Android app connected to Bangle.js watches).
 *
 * @module
 */

// Cache
export { getWearableDataCache, WearableDataCache } from "./cache.ts";

// Connection manager
export {
  getWearableConnectionManager,
  WearableConnectionManager,
} from "./connection-manager.ts";

// Types
export type {
  AccelReading,
  BatteryReading,
  DeviceSensorState,
  GPSReading,
  HeartRateReading,
  ScreenReading,
  SensorReading,
  SensorReadingType,
  SleepReading,
  WearableCacheSnapshot,
  WearableCapabilities,
  WearableCommand,
  WearableMessage,
} from "./types.ts";
