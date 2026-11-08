const CACHE = "wiwy-shell-v13";
const CORE = ["./","./index.html","./css/app.css","./js/app.js","./js/store.js","./js/config.js","./js/auth.js","./js/cloud.js","./manifest.webmanifest","./icons/icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
    const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;
  }).catch(()=>caches.match("./index.html"))));
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || "You have a new WIWY update." }; }
  const title = data.title || "Wherever I'm With You";
  const options = { body: data.body || "You have a new household update.", icon: "./icons/icon.svg", badge: "./icons/icon.svg", tag: data.tag || data.event_key || "wiwy-update", data: { url: data.url || "./" }, renotify: true };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) if (client.url.startsWith(self.location.origin) && "focus" in client) return client.focus();
    return clients.openWindow(target);
  }));
});
