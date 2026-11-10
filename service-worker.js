const CACHE = "wiwy-shell-v18";
// Only required application files belong in the install-critical list.
// The manifest and artwork are optional; a missing icon must never prevent
// the service worker from activating (which would leave push setup hanging).
const CORE = ["./", "./index.html", "./css/app.css", "./js/app.js", "./js/cloud.js"];
const OPTIONAL = ["./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/wiwy-emblem.png", "./icons/away-suitcase.svg"];
self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(CORE);
  await Promise.allSettled(OPTIONAL.map(path => cache.add(path)));
  await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match("./index.html"))));
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data?.text() || "You have a new WIWY update." }; }
  const title = data.title || "Wherever I'm With You";
  const options = {
    body: data.body || "You have a new household update.",
    tag: data.tag || data.event_key || "wiwy-update",
    data: { url: data.url || "./" }, renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) if (client.url.startsWith(self.location.origin) && "focus" in client) return client.focus();
    return self.clients.openWindow(target);
  }));
});
