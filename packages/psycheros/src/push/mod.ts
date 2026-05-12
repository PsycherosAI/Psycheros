/**
 * Push Notification Manager
 *
 * Handles Web Push notifications using VAPID keys.
 * Manages push subscriptions in SQLite and sends encrypted payloads
 * to push services so the entity can reach the user even when
 * the app is closed.
 */

import { join } from "@std/path";
import webPush from "web-push";
import type { Database } from "@db/sqlite";

// =============================================================================
// Types
// =============================================================================

/** A stored push subscription from a client device. */
export interface PushSubscriptionRecord {
  endpoint: string;
  /** JSON string of { p256dh, auth } keys */
  keysJson: string;
  createdAt: string;
}

/** Payload sent to the push service. */
export interface PushPayload {
  title: string;
  body: string;
  conversationId?: string;
}

/** VAPID key pair stored on disk. */
interface VAPIDKeys {
  publicKey: string;
  privateKey: string;
}

// =============================================================================
// VAPID Key Management
// =============================================================================

const VAPID_KEYS_PATH = "push-vapid-keys.json";

/**
 * Load or generate VAPID keys.
 *
 * Keys are stored in `.psycheros/push-vapid-keys.json` (gitignored).
 * Auto-generated on first run using web-push's generateVAPIDKeys().
 */
export async function loadOrGenerateKeys(
  projectRoot: string,
): Promise<VAPIDKeys> {
  const keysPath = join(projectRoot, ".psycheros", VAPID_KEYS_PATH);

  try {
    const text = await Deno.readTextFile(keysPath);
    const keys = JSON.parse(text) as VAPIDKeys;
    if (keys.publicKey && keys.privateKey) {
      return keys;
    }
  } catch {
    // File doesn't exist or is invalid — generate new keys
  }

  console.log("[Push] Generating VAPID keys...");
  const keys = webPush.generateVAPIDKeys();

  // Save to disk
  const dir = join(projectRoot, ".psycheros");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(keysPath, JSON.stringify(keys, null, 2) + "\n");

  console.log("[Push] VAPID keys generated and saved");
  return keys;
}

/**
 * Get the VAPID public key (URL-safe base64 as a Uint8Array).
 * Used by the client for pushManager.subscribe().
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// =============================================================================
// Subscription Management (SQLite)
// =============================================================================

/**
 * Initialize push tables in the database.
 */
export function initializePushTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      keys_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

/**
 * Save or update a push subscription.
 */
export function saveSubscription(
  db: Database,
  endpoint: string,
  keysJson: string,
): void {
  const createdAt = new Date().toISOString();
  db.exec(
    `INSERT INTO push_subscriptions (endpoint, keys_json, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json`,
    [endpoint, keysJson, createdAt],
  );
}

/**
 * Get all active push subscriptions.
 */
export function getSubscriptions(db: Database): PushSubscriptionRecord[] {
  const rows = db
    .prepare("SELECT endpoint, keys_json, created_at FROM push_subscriptions")
    .all<{ endpoint: string; keys_json: string; created_at: string }>();
  return rows.map((row) => ({
    endpoint: row.endpoint,
    keysJson: row.keys_json,
    createdAt: row.created_at,
  }));
}

/**
 * Delete a push subscription by endpoint.
 */
export function deleteSubscription(db: Database, endpoint: string): void {
  db.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

// =============================================================================
// Sending Push Notifications
// =============================================================================

/**
 * Send a push notification to a single subscription.
 *
 * @returns true if sent successfully, false if the subscription is expired/unsubscribed
 */
export async function sendPushNotification(
  subscription: webPush.PushSubscription,
  payload: PushPayload,
  vapidKeys: VAPIDKeys,
): Promise<boolean> {
  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: {
        subject: "https://psycheros.app",
        privateKey: vapidKeys.privateKey,
        publicKey: vapidKeys.publicKey,
      },
      TTL: 2419200, // 28 days — keep alive for up to 4 weeks
    });
    console.log(`[Push] Sent to ${subscription.endpoint.substring(0, 60)}...`);
    return true;
  } catch (error: unknown) {
    const status = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : String(error);
    // 404 or 410 means the subscription is expired or revoked
    if (status === 404 || status === 410) {
      console.log(
        `[Push] Subscription expired: ${
          subscription.endpoint.substring(0, 60)
        }...`,
      );
      return false;
    }
    // Log other errors — don't delete subscription for transient errors
    console.error(
      `[Push] Failed to send to ${subscription.endpoint.substring(0, 60)}...:`,
      `HTTP ${status ?? "unknown"} — ${message}`,
    );
    return true;
  }
}

/**
 * Parse a stored subscription record into a webPush.PushSubscription object.
 */
export function parseSubscription(
  record: PushSubscriptionRecord,
): webPush.PushSubscription {
  const keys = JSON.parse(record.keysJson) as { p256dh: string; auth: string };
  return {
    endpoint: record.endpoint,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  };
}
