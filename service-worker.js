const CACHE = "wiwy-shell-v23";
const CORE = ["./", "./index.html", "./css/app.css", "./js/app.js", "./js/cloud.js", "./js/auth.js", "./wiwy-release.json"];
const OPTIONAL = ["./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/wiwy-emblem.png", "./icons/away-suitcase.svg"];

self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(CORE);
  await Promise.allSettled(OPTIONAL.map(path => cache.add(path)));
  // Deliberately do NOT call skipWaiting here. The user must approve activation.
})()));

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = (await caches.keys()).filter(key => key.startsWith("wiwy-shell-v")).sort((a,b)=>{
    const av=Number(a.split("-v").pop()),bv=Number(b.split("-v").pop());return av-bv;
  });
  // Retain the previous two shell caches as recovery material.
  const obsolete = keys.slice(0, Math.max(0, keys.length - 3));
  await Promise.all(obsolete.map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  if (event.request.url.includes("wiwy-release.json")) {
    event.respondWith(fetch(event.request, {cache:"no-store"}).catch(()=>caches.match(event.request)));
    return;
  }
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
  const options = {body:data.body||"You have a new household update.",tag:data.tag||data.event_key||"wiwy-update",data:{url:data.url||"./"},renotify:true};
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    for(const client of list)if(client.url.startsWith(self.location.origin)&&"focus"in client)return client.focus();
    return self.clients.openWindow(target);
  }));
});
