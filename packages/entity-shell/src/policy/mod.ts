/**
 * Discord active-mode pattern, carried over: events accumulate, debounce,
 * then the entity decides whether and to whom to respond. Pages are DM-like
 * — always respond, force trigger. Presence events (arrivals, departures)
 * are ordinary triggers.
 */
export interface ResponsivenessSettings {
  debounceMs: number;
  maxBufferSize: number;
}

export type InitiativeLevel = "off" | "low" | "high";

/** Idle-triggered initiative: act / watch / rest — declining is a real choice. */
export interface InitiativeSettings {
  level: InitiativeLevel;
  /** Quiet time before an initiative turn fires. */
  quietMs: number;
  /** Cost guard: initiative turns per hour. */
  maxPerHour: number;
}
