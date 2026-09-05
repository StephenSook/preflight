// The service worker for the phone page: shows a held-queue notification when the host pushes one,
// and opens the row it names when tapped. Nothing is cached; the page is small and always fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = { title: "Preflight", body: "A call is waiting for a person.", url: "/app/#held", tag: "preflight" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A payload that is not JSON is shown as the default text.
  }
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, tag: payload.tag, icon: "/favicon.svg", badge: "/favicon.svg", data: { url: payload.url }, renotify: true }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/app/#held";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
