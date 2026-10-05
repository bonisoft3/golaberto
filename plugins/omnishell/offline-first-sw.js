// Precached immutable shell assets required for cold offline boot.
const LIVE_UPDATES = false;
const STATIC_CACHE = "pronto-static-v4";
const RUNTIME_CACHE = "pronto-runtime-v4";

const PRECACHE_ASSETS = [
  "/shell/index.html",
  "/shell/shell.css",
  "/shell/design.css",
  "/shell/boot.js",
];

// Protocol boundaries: sync streams, mutations, and auth sessions must never
// be cached by an HTTP service worker.
const BYPASS_PREFIXES = ["/electric/", "/crud/", "/auth/", "/events/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      )
    ).then(async () => {
      await self.clients.claim();
      if (LIVE_UPDATES) for (const client of await self.clients.matchAll({type:"window"})) client.postMessage({type:"PRONTO_ASSETS_UPDATED"});
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  if (!LIVE_UPDATES) {
  // Stale-While-Revalidate for shell, screen templates, styles, and interpreter assets.
  // Serves from cache immediately for 0ms offline boot, while revalidating against
  // the server in the background. If a template or stylesheet has updated, the SW
  // caches the new response and posts a message to active client windows to morph
  // the DOM or hot-reload styles in-place without page reload.
  if (url.pathname.startsWith("/shell/") || url.pathname.startsWith("/omnishell/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        // respondWith consumes the original body before revalidation finishes.
        const previous = cached?.clone();

        const revalidatePromise = fetch(req)
          .then(async (res) => {
            if (!res.ok) return res;
            const newText = await res.clone().text();

            let changed = false;
            if (!cached) {
              changed = true;
            } else {
              const oldText = await previous.text();
              if (oldText !== newText) {
                changed = true;
              }
            }

            if (changed) {
              await cache.put(req, res.clone());
              const clients = await self.clients.matchAll({ type: "window" });
              for (const client of clients) {
                if (url.pathname.endsWith(".html")) {
                  client.postMessage({
                    type: "PRONTO_SKELETON_UPDATED",
                    url: req.url,
                    pathname: url.pathname,
                    html: newText,
                  });
                } else if (url.pathname.endsWith(".css")) {
                  client.postMessage({
                    type: "PRONTO_STYLE_UPDATED",
                    url: req.url,
                    pathname: url.pathname,
                    css: newText,
                  });
                }
              }
            }
            return res;
          })
          .catch(() => {
            // Network failure / offline: cached response already served
          });

        // Returning a cached response finishes respondWith; keep the worker
        // alive until the replacement asset has actually reached the cache.
        event.waitUntil(revalidatePromise);

        if (cached) {
          return cached;
        }
        return revalidatePromise;
      }),
    );
    return;
  }

  // SWR for navigation: serve cached entry document immediately if known,
  // revalidating in background. Unvisited routes offline fail loudly.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req).then((res) => {
          const cc = res.headers.get("Cache-Control") || "";
          if (res.ok && !cc.includes("no-store") && !cc.includes("private")) {
            return cache.put(req, res.clone()).then(() => res);
          }
          return res;
        });
        event.waitUntil(fetchPromise.catch(() => {}));
        if (cached) {
          fetchPromise.catch(() => {});
          return cached;
        }
        return fetchPromise;
      }),
    );
  }
    return;
  }

  // Online boots must not combine a cached manifest with new templates/modules.
  // Cache is a fallback for an unavailable network, never the online answer.
  if (url.pathname.startsWith("/shell/") || url.pathname.startsWith("/omnishell/") || req.mode === "navigate") {
    const shellAsset = req.mode !== "navigate";
    const cachePromise = caches.open(shellAsset ? STATIC_CACHE : RUNTIME_CACHE);
    const answer = cachePromise.then(async (cache) => {
      const cached = await cache.match(req);
      try {
        const res = await fetch(req, { cache: "no-cache" });
        if (!res.ok) {
          if (res.status >= 500 && cached) return cached;
          return res;
        }
        const cc = res.headers.get("Cache-Control") || "";
        if (!cc.includes("no-store") && !cc.includes("private")) {
          const changed = shellAsset && cached && await cached.clone().text() !== await res.clone().text();
          try { await cache.put(req, res.clone()); } catch { return res; }
          if (changed) {
            const clients = await self.clients.matchAll({ type: "window" });
            for (const client of clients) client.postMessage({ type: "PRONTO_ASSETS_UPDATED" });
          }
        }
        return res;
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    });
    event.respondWith(answer);
    event.waitUntil(answer.then(() => {}, () => {}));
  }
});
