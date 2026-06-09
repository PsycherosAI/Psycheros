/**
 * Wearable Sensor Data Types
 *
 * Sensor readings from entity-plexus (Android app connected to Bangle.js
 * watches via BLE). Each reading carries a device ID, a type discriminator,
 * and an epoch-millisecond timestamp for staleness tracking.
 *
 * Phase 2 will read these types from the cache for SA injection.
 */

// =============================================================================
// Reading Types
// =============================================================================

/** Sleep state reading from my watch's sleep tracking algorithm. */
export interface SleepReading {
  type: "sleep";
  /** "deep" | "light" | "awake" */
  state: string;
  timestamp: number;
}

/** Heart rate reading with optional movement coefficient. */
export interface HeartRateReading {
  type: "hr";
  /** Beats per minute */
  bpm: number;
  /** Movement coefficient (0-1 scale, from accelerometer magnitude) */
  movement?: number;
  timestamp: number;
}

/** Raw accelerometer vector. */
export interface AccelReading {
  type: "accel";
  /** X-axis in m/s^2 */
  x: number;
  /** Y-axis in m/s^2 */
  y: number;
  /** Z-axis in m/s^2 */
  z: number;
  timestamp: number;
}

/** Battery percentage. */
export interface BatteryReading {
  type: "battery";
  /** 0-100 */
  percent: number;
  timestamp: number;
}

/** GPS coordinates. */
export interface GPSReading {
  type: "gps";
  lat: number;
  lng: number;
  timestamp: number;
}

/** Screen on/off state. */
export interface ScreenReading {
  type: "screen";
  on: boolean;
  timestamp: number;
}

/** Union of all sensor reading types from entity-plexus. */
export type SensorReading =
  | SleepReading
  | HeartRateReading
  | AccelReading
  | BatteryReading
  | GPSReading
  | ScreenReading;

/** The discriminating type field. */
export type SensorReadingType = SensorReading["type"];

// =============================================================================
// Wire Protocol Types
// =============================================================================

/** Inbound message from entity-plexus over WebSocket or HTTP POST. */
export interface WearableMessage {
  /** Device identifier, e.g. "banglejs-1" */
  device_id: string;
  /** One or more sensor readings in this batch */
  readings: SensorReading[];
}

/** Outbound command from server to entity-plexus over WebSocket. */
export interface WearableCommand {
  type: "command";
  /** Target device ID */
  device_id: string;
  /** Command string (e.g. "V(200)" for haptic buzz on Bangle.js) */
  command: string;
}

/** Capabilities declaration from entity-plexus (optional, sent on connect). */
export interface WearableCapabilities {
  type: "capabilities";
  /** Device identifier */
  device_id: string;
  /** Streams this device will produce */
  streams: Array<{
    /** Stream type ID (e.g. "sleep", "hr", "accel") */
    id: string;
    /** Human-readable label (e.g. "Sleep State") */
    label?: string;
    /** Unit of measurement (e.g. "bpm", "m/s^2") */
    unit?: string;
  }>;
}

// =============================================================================
// Cache Snapshot Types
// =============================================================================

/** The latest reading of each type for a single device. */
export interface DeviceSensorState {
  /** The device ID */
  deviceId: string;
  /** Latest sleep reading, if any */
  sleep?: SleepReading;
  /** Latest heart rate reading, if any */
  hr?: HeartRateReading;
  /** Latest accelerometer reading, if any */
  accel?: AccelReading;
  /** Latest battery reading, if any */
  battery?: BatteryReading;
  /** Latest GPS reading, if any */
  gps?: GPSReading;
  /** Latest screen reading, if any */
  screen?: ScreenReading;
  /** When this device was last seen (epoch ms) */
  lastSeen: number;
}

/** Full snapshot of all tracked wearable devices. */
export interface WearableCacheSnapshot {
  /** All tracked devices, keyed by device ID */
  devices: Map<string, DeviceSensorState>;
  /** When the snapshot was taken (epoch ms) */
  asOf: number;
}
