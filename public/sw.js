// omp-web service worker: shows notifications and opens their session on click.
// It does not cache anything; the app stays online-only.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Unreadable payload: still show something (iOS revokes silent pushes).
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "omp web", {
      body: data.body || "",
      icon: "/favicon-192x192.png",
      badge: "/badge-96.png",
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: data.url || "/", sessionId: data.sessionId || "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url = "/", sessionId = "" } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((candidate) => candidate.focused) || windows.find((candidate) => candidate.visibilityState === "visible") || windows[0];
      if (client) {
        try {
          await client.focus();
          // The app selects the session in place, keeping its live state. Any
          // other page (the sign-in screen after the cookie expired) loads the
          // session URL, which the sign-in screen carries through as `next`.
          if (new URL(client.url).pathname === "/") {
            if (sessionId) client.postMessage({ type: "omp-open-session", sessionId });
          } else {
            await client.navigate(url);
          }
          return;
        } catch {
          // focus() or navigate() can be refused; open a window instead.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
