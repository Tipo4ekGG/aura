// Сервис-воркер: уведомления и работа без сети.
// Страница берётся из сети, а если сети нет — из кэша.
// Шрифты, иконки и библиотека Supabase отдаются из кэша и обновляются в фоне.
// Запросы к базе (supabase.co) не кэшируются: данные без сети страница берёт из своей памяти.
const CACHE = "aura-v5";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js?sri=1",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== "aura-meta").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;
  if (url.pathname.endsWith("/version.txt")) return;   // номер версии всегда из сети

  // Страница: сначала сеть (чтобы обновления приходили сразу), без сети — кэш
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("index.html", copy));
          return res;
        })
        .catch(() => caches.match("index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Остальное (шрифты, иконки, библиотеки): из кэша, обновляем в фоне
  const cacheable = url.origin === self.location.origin ||
    url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com" ||
    url.hostname === "cdn.jsdelivr.net";
  if (!cacheable) return;
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(Promise.all([
    bumpBadge(),
    self.registration.showNotification(d.title || "Счётчик ауры", {
      body: d.body || "",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: "aura-" + (d.id || Date.now()),
      data: { url: new URL(d.url || "./", self.registration.scope).href },
    }),
  ]));
});

// Цифра на иконке приложения: +1 к последнему числу, которое записало приложение
async function bumpBadge() {
  try {
    if (!("setAppBadge" in self.navigator)) return;
    const c = await caches.open("aura-meta");
    const r = await c.match("badge");
    const n = (r ? parseInt(await r.text(), 10) || 0 : 0) + 1;
    await c.put("badge", new Response(String(n)));
    await self.navigator.setAppBadge(n);
  } catch (_) {}
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { if ("navigate" in c && url.includes("party=")) c.navigate(url).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
