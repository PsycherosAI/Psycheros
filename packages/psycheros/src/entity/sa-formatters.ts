function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format the wearable data section for the SA block.
 * Uses device-specific stream config (xmlTag, enabled) from BLE settings.
 * Only includes data from connected devices with non-stale readings.
 * Returns undefined if there is no wearable data to report.
 */
export function formatWearableData(
  snapshot: import("../server/device-cache.ts").DeviceCacheSnapshot,
  bleSettings?: import("../llm/ble-settings.ts").BLESettings,
  cache?: import("../wearable/cache.ts").WearableDataCache,
): string | undefined {
  const entries: string[] = [];

  for (
    const [deviceId, sensorState] of Object.entries(snapshot.wearableDevices)
  ) {
    const device = bleSettings?.devices.find((d) => d.id === deviceId);
    const streams = device?.streams;
    if (!streams || !device?.enabled) continue;

    for (const [_streamId, config] of Object.entries(streams)) {
      if (!config.enabled) continue;

      const value = renderStreamValue(_streamId, sensorState, cache);
      if (value === undefined) continue;

      entries.push(
        `    <${escapeXml(config.xmlTag)}>${escapeXml(value)}</${
          escapeXml(config.xmlTag)
        }>`,
      );
    }
  }

  if (entries.length === 0) return undefined;
  return `  <wearable_data>\n${entries.join("\n")}\n  </wearable_data>`;
}

/**
 * Render a human-readable value for a sensor stream.
 * Known types get nice formatting; unknown types get raw JSON.
 * Returns undefined if the reading is missing or stale.
 */
export function renderStreamValue(
  streamId: string,
  state: import("../wearable/types.ts").DeviceSensorState,
  cache?: import("../wearable/cache.ts").WearableDataCache,
): string | undefined {
  switch (streamId) {
    case "sleep": {
      const r = state.sleep;
      if (!r || (cache && cache.isStale(r.timestamp))) return undefined;
      return r.state;
    }
    case "hr": {
      const r = state.hr;
      if (!r || (cache && cache.isStale(r.timestamp))) return undefined;
      return String(r.bpm);
    }
    case "accel": {
      const r = state.accel;
      if (!r || (cache && cache.isStale(r.timestamp))) return undefined;
      const mag = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
      const movement = Math.abs(mag - 9.81);
      if (movement < 0.1) return "resting";
      if (movement < 0.5) return "light";
      if (movement < 1.0) return "moderate";
      return "active";
    }
    case "battery": {
      const r = state.battery;
      if (!r || (cache && cache.isStale(r.timestamp))) return undefined;
      return String(r.percent);
    }
    case "gps": {
      const r = state.gps;
      if (!r || (cache && cache.isStale(r.timestamp))) return undefined;
      return `${r.lat},${r.lng}`;
    }
    case "screen": {
      const r = state.screen;
      if (!r || (cache && cache.isStale(r.timestamp))) return undefined;
      return r.on ? "on" : "off";
    }
    default: {
      const reading = (state as unknown as Record<string, unknown>)[streamId] as
        | { timestamp?: number }
        | undefined;
      if (!reading?.timestamp) return undefined;
      if (cache && cache.isStale(reading.timestamp)) return undefined;
      return JSON.stringify(reading);
    }
  }
}
