# Wearable Data Pipeline

`src/wearable/` handles sensor data from entity-plexus (an Android app connected
to Bangle.js watches via BLE). It is separate from the DeviceBridge (which
serves web BLE gateway clients with a different protocol). Two singleton
services:

- **WearableConnectionManager** (`connection-manager.ts`) — WebSocket
  connections from entity-plexus, fire-and-forget command push, implicit device
  registration from first inbound message. Discovers data streams from incoming
  readings and an optional capabilities message, persists them to BLE device
  profiles in `.psycheros/ble-settings.json`.
- **WearableDataCache** (`cache.ts`) — latest sensor reading per type per
  device, synchronous `getSnapshot()` for zero-latency SA reads.

The `ble_device` tool and `/api/device/command` endpoint try DeviceBridge first,
then fall back to WearableConnectionManager. The wearable cache is included in
`DeviceCacheSnapshot.wearableDevices` for SA reads.

## Stream discovery and SA injection

Data streams (sleep, hr, accel, etc.) are discovered dynamically when readings
arrive — either from an explicit capabilities message or auto-detected from
incoming data. Each stream gets a `BLEStreamConfig` entry (label, xmlTag,
enabled) on the device's BLE profile. The user configures XML tag names and
per-stream on/off toggles in two UIs: BLE settings (per-device stream config)
and SA settings (global toggle view). The entity loop's `formatWearableData()`
renders a `<wearable_data>` block in the SA XML using each stream's configured
xmlTag, only including enabled streams with fresh readings (< 5 min). Known
stream types (sleep, hr, accel, battery, gps, screen) get human-readable
renderers; unknown types serialize as JSON.

**Connection status** is tracked by
`WearableConnectionManager.connectedDeviceIds` and surfaced in both BLE and SA
settings UIs with Connected/Disconnected badges.

## Event rules (webhooks)

The SA settings page has a Webhooks tab that lets the user define rules that
trigger Pulses when sensor readings match conditions. Each rule has a single
condition (stream ID + operator: `changes_to`, `goes_above`, `goes_below` +
value) and a single action (`Run Pulse`). The `EventRulesEngine`
(`event-rules-engine.ts`) evaluates incoming readings from
`WearableConnectionManager.handleMessage()` (after `cache.ingest()`), calling
`PulseEngine.triggerPulse(rule.action.pulseId, "data_event")` on match.
Sustained tracking (`condition.sustainedMinutes`) requires the condition to hold
continuously before firing; cooldown prevents re-triggering within
`cooldownMinutes`. Types and persistence live in `event-rules.ts`. Config
persists across device disconnects — all registered devices are always visible
and editable regardless of connection state.

## Production vs localhost routes

The wearable endpoints are registered under two path sets: `/api/device/stream`
and `/api/device/data` are for localhost/dev (no Authelia); `/api/ingest/stream`
and `/api/ingest` are for production behind Authelia's `client_credentials`
bearer auth — the access-control rule only allows authenticated requests on
`/api/ingest`. Both path sets delegate to the same handlers. Route registration
is in `server.ts` `handleAPIRoute()`. The endpoint protocol is documented in
[`api-reference.md`](api-reference.md) ("Wearable Data Streaming").
