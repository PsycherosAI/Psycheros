/**
 * Psycheros Service Worker
 *
 * Caching strategy:
 * - All routes use network-first — always serve fresh content, cache for offline fallback
 * - /api/*, /fragments/*, /c/* — dynamic routes (no caching on success)
 * - Static assets (CSS, JS, libs) — cached on successful fetch for offline use
 */

const CACHE_NAME = "psycheros-offline-v2";
const STATIC_ASSETS = [
  "/",
  "/css/main.css",
  "/js/psycheros.js",
  "/js/theme.js",
  "/lib/htmx.min.js",
  "/lib/htmx-sse.js",
  "/lib/marked.min.js",
  "/lib/dompurify.min.js",
];

// Install - cache static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }),
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
    }),
  );
  // Take control immediately
  self.clients.claim();
});

// Fetch handler
self.addEventListener("fetch", (event) => {
  // Don't intercept non-GET requests — POST/PUT/DELETE with FormData
  // can fail in standalone PWA mode when routed through the service worker.
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const path = url.pathname;

  // Network-first for dynamic routes
  if (
    path.startsWith("/api/") ||
    path.startsWith("/fragments/") ||
    path.startsWith("/c/")
  ) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Network-first for static assets (always get fresh content, cache for offline)
  event.respondWith(networkFirstStatic(event.request));
});

/**
 * Network-first strategy: try network, fall back to cache.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    // Network failed, try cache
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    // Nothing in cache, return offline error
    return new Response(
      JSON.stringify({ error: "Offline" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Network-first strategy for static assets: try network, cache result, fall back to cache.
 */
async function networkFirstStatic(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed, try cache
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    return new Response("Not Found", { status: 404 });
  }
}

// =============================================================================
// Push Notification Handlers
// =============================================================================

// Handle incoming push messages
self.addEventListener("push", (event) => {
  let payload = { title: "Psycheros", body: "You have a new message" };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: "Psycheros", body: event.data.text() };
    }
  }

  const notificationOptions = {
    body: payload.body || "",
    icon: "/icons/icon-192.svg",
    badge: "/icons/icon-192.svg",
    data: {
      conversationId: payload.conversationId || null,
      url: payload.url || null,
    },
  };

  event.waitUntil(
    self.registration.showNotification(
      payload.title || "Psycheros",
      notificationOptions,
    ),
  );
});

// Handle notification clicks — open or focus the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const conversationId = event.notification.data?.conversationId;
  const targetUrl = conversationId ? `/c/${conversationId}` : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(
      (clientList) => {
        // If the app is already open, focus it and navigate
        for (const client of clientList) {
          if (client.url.includes(targetUrl) && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise open a new window
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      },
    ),
  );
});
