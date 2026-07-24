/**
 * OAuth scope strategy for the google-suite plugin.
 *
 * Scopes are requested dynamically based on which services are enabled, so an
 * operator who only enables Calendar doesn't grant Gmail/Drive/Contacts/
 * Tasks/Fit access. Enabling a new service later triggers a re-OAuth with
 * the expanded scope union (Google's `access_type=offline&prompt=consent`
 * ensures a fresh refresh token covering the full set).
 *
 * Some services need MULTIPLE scopes (Fit needs 4 read scopes). The
 * SERVICE_SCOPES map handles that — each service maps to an array.
 */

/** Scopes for each service. Most services have one; Fit has four (read-only). */
export const SERVICE_SCOPES: Record<string, readonly string[]> = {
  calendar: ["https://www.googleapis.com/auth/calendar"],
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  drive: ["https://www.googleapis.com/auth/drive.file"],
  contacts: ["https://www.googleapis.com/auth/contacts"],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  fit: [
    "https://www.googleapis.com/auth/fitness.activity.read",
    "https://www.googleapis.com/auth/fitness.heart_rate.read",
    "https://www.googleapis.com/auth/fitness.sleep.read",
    "https://www.googleapis.com/auth/fitness.body.read",
  ],
};

/** Always-included scopes (openid + email for account display). */
const ALWAYS_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/userinfo.email",
];

export type ServiceId =
  | "calendar"
  | "gmail"
  | "drive"
  | "contacts"
  | "tasks"
  | "fit";

export const ALL_SERVICE_IDS: readonly ServiceId[] = [
  "calendar",
  "gmail",
  "drive",
  "contacts",
  "tasks",
  "fit",
] as const;

/**
 * Build the space-joined scope string for an OAuth request based on which
 * services the operator has enabled. Always includes userinfo.email.
 */
export function buildScopeString(enabled: readonly ServiceId[]): string {
  const set = new Set<string>(ALWAYS_SCOPES);
  for (const svc of enabled) {
    for (const scope of SERVICE_SCOPES[svc] ?? []) {
      set.add(scope);
    }
  }
  return [...set].join(" ");
}

/**
 * Compute which enabled services' scopes are missing from a granted set.
 * A service is "missing" if ANY of its required scopes aren't granted.
 */
export function missingScopes(
  enabled: readonly ServiceId[],
  grantedScopes: readonly string[],
): string[] {
  const granted = new Set(grantedScopes);
  const needed: string[] = [];
  for (const svc of enabled) {
    for (const scope of SERVICE_SCOPES[svc] ?? []) {
      if (!granted.has(scope)) needed.push(scope);
    }
  }
  return needed;
}

/**
 * Inverse of missingScopes — which services have ALL their scopes granted?
 * Used for status displays ("3 of 6 services granted").
 */
export function grantedServices(
  grantedScopes: readonly string[],
): ServiceId[] {
  const granted = new Set(grantedScopes);
  return ALL_SERVICE_IDS.filter((svc) => {
    const scopes = SERVICE_SCOPES[svc] ?? [];
    return scopes.every((s) => granted.has(s));
  });
}

/**
 * Human-readable scope label for a service — used in the settings UI's
 * service toggle descriptions. Returns the first scope URL (most services
 * have only one) or a summary for multi-scope services like Fit.
 */
export function serviceScopeLabel(serviceId: ServiceId): string {
  const scopes = SERVICE_SCOPES[serviceId] ?? [];
  if (scopes.length === 0) return "(none)";
  if (scopes.length === 1) return scopes[0];
  return `${scopes.length} scopes (activity, heart rate, sleep, body)`;
}
