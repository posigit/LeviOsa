/* LeviOsa service worker
 *
 * Goals:
 * - Cache hashed Next static assets (fast repeat loads)
 * - Stale-while-revalidate TMDB posters (snappy grids, offline-ish images)
 * - Never long-cache personalized HTML / RSC / API (always fresh when online)
 * - Offline: simple fallback page, not a stale watchlist
 *
 * Bump VERSION when changing strategies so activate() purges old caches.
 * UI changes do NOT need a bump anymore: the /library shell revalidates
 * itself while online (storeShellDocument + the revalidate-shell message).
 * offline.html is the exception — it is precached cache-first, so bump it
 * whenever that page changes or installs keep serving the old markup.
 */
const VERSION = "14";
const SHELL_CACHE = `tvtime-shell-v${VERSION}`;
const STATIC_CACHE = `tvtime-static-v${VERSION}`;
const IMAGE_CACHE = `tvtime-images-v${VERSION}`;

/**
 * Offline downloads live here (UNVERSIONED on purpose — bumping VERSION
 * must never wipe saved episodes). Playlists + segments are stored under
 * `/api/dl?playlist=<key>` / `/api/dl?u=<canonical>` keys written by the
 * downloader; served below with manual 206 slicing for seeking.
 */
const DOWNLOAD_CACHE = "tvtime-downloads";

const ALL_CACHES = [SHELL_CACHE, STATIC_CACHE, IMAGE_CACHE];

/** App shell only — not personalized tab HTML */
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.json",
  "/icons/icon-192x192.png?v=14",
  "/icons/icon-512x512.png?v=14",
  "/avatars/profile.jpg",
  // Library shell: static prerender — cold offline opens in OUR player UI,
  // never the bare fallback, once any online visit has run this worker.
  "/library",
];

const IMAGE_CACHE_MAX = 250;

self.addEventListener("install", (event) => {
  // Per-URL settle (not addAll): one flaky file must never nuke the whole
  // precache — offline.html is the survival launcher, it must always land.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_URLS.filter((u) => u !== "/library").map((u) =>
            cache.add(u)
          )
        ).then(async () => {
          // /library lands WITH the bundle it references: activate() purges
          // STATIC_CACHE on a VERSION bump, and HTML alone renders a blank
          // page offline instead of the flat-but-working list it used to.
          await storeShellDocument(cache, "/library", fetch("/library"));
        })
      )
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              !ALL_CACHES.includes(key) && !key.startsWith(DOWNLOAD_CACHE)
          )
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

/* ---------- Shell freshness ---------- */

let lastShellRefresh = 0;

/**
 * The shell only refreshes on a full /library navigation, so an app entered
 * through any other route never updates it (RSC navigations bypass the worker
 * entirely — see shouldBypass). The page pings us when it comes to the
 * foreground while online; we revalidate then — throttled — so the offline
 * copy tracks the newest build without sw.js ever changing.
 */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "revalidate-shell") return;
  const now = Date.now();
  if (now - lastShellRefresh < 60000) return;
  lastShellRefresh = now;
  const work = caches
    .open(SHELL_CACHE)
    .then((cache) =>
      storeShellDocument(
        cache,
        "/library",
        fetch("/library", { cache: "no-store" })
      )
    );
  if (typeof event.waitUntil === "function") event.waitUntil(work);
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Dev mode (?dev=1, see providers.tsx): serve /api/dl ONLY. Everything
  // else (HMR, navigations, build chunks) goes straight to the network so
  // the worker can never interfere with development.
  if (
    new URL(self.location.href).searchParams.get("dev") === "1" &&
    !(url.origin === self.location.origin && url.pathname === "/api/dl")
  ) {
    return;
  }

  // --- Cross-origin: only TMDB images ---
  if (url.origin !== self.location.origin) {
    if (isTmdbImage(url)) {
      event.respondWith(staleWhileRevalidateImage(request));
    }
    return;
  }

  // --- Offline downloads: same-origin /api/dl serve path ---
  // Playlist + segment URLs are pre-canonicalized by the downloader, so an
  // exact cache lookup is correct even after signed source URLs rotate.
  if (
    url.origin === self.location.origin &&
    url.pathname === "/api/dl"
  ) {
    event.respondWith(serveDownload(request));
    return;
  }

  // --- IntroDB segments: static per episode — cache for offline/flaky nets.
  // Served stale-while-revalidate so skip/outro survive airplane mode even
  // for titles downloaded before segments were captured on the record.
  if (
    url.origin === self.location.origin &&
    url.pathname === "/api/introdb/segments"
  ) {
    event.respondWith(staleWhileRevalidateJson(request));
    return;
  }

  // --- Never intercept / cache these (auth, mutations, live data) ---
  if (shouldBypass(url, request)) {
    return;
  }

  // --- Document navigations: network-first, offline shell fallback ---
  // Exception: /library is fully local (IndexedDB library) — serve its
  // shell stale-while-revalidate so the library opens with zero connection.
  if (request.mode === "navigate") {
    if (url.pathname === "/library") {
      event.respondWith(staleWhileRevalidateDocument(request));
      return;
    }
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // --- Next.js hashed build assets: cache-first ---
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // --- Icons / avatar / manifest / offline page / vendor: cache-first ---
  if (
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/avatars/") ||
    url.pathname.startsWith("/vendor/") ||
    url.pathname === "/manifest.json" ||
    url.pathname === "/offline.html" ||
    url.pathname === "/favicon.ico"
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Everything else same-origin (RSC, data, etc.): network only — do not cache
});

function isTmdbImage(url) {
  return (
    url.hostname === "image.tmdb.org" &&
    (url.pathname.startsWith("/t/p/") || url.pathname.includes("/t/p/"))
  );
}

function shouldBypass(url, request) {
  if (url.pathname.startsWith("/api/")) return true;
  // Next App Router flight / RSC payloads — personalized & version-sensitive
  if (url.searchParams.has("_rsc")) return true;
  if (request.headers.get("RSC") === "1") return true;
  if (request.headers.get("Next-Router-Prefetch") === "1") return true;
  if (request.headers.get("Next-Router-State-Tree")) return true;
  return false;
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    // Do NOT cache HTML — watchlist/profile change constantly
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match("/offline.html")) ||
      new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }
}

/**
 * Store an HTML document together with the hashed /_next/static bundle it
 * references — or not at all. The pair has to land and expire as one unit:
 * a VERSION bump purges STATIC_CACHE while SHELL_CACHE keeps the document,
 * and HTML without its scripts renders a blank page offline.
 *
 * Takes ownership of `responseLike` (it may be a Promise). Returns true when
 * the shell cache now holds this document.
 */
async function storeShellDocument(cache, key, responseLike) {
  try {
    const response = await responseLike;
    if (!response || !response.ok) return false;
    const stored = response.clone();
    const html = await response.text();
    const assets = [
      ...new Set(
        (html.match(/(?:src|href)="\/_next\/static\/[^"]+"/g) || []).map((m) =>
          m.slice(m.indexOf('="/') + 2, -1)
        )
      ),
    ];
    if (assets.length) {
      const staticCache = await caches.open(STATIC_CACHE);
      const landed = await Promise.allSettled(
        assets.map(async (asset) => {
          const res = await fetch(asset);
          if (!res.ok) throw new Error(`${res.status} ${asset}`);
          await staticCache.put(asset, res);
        })
      );
      // One missing script is a broken document offline — keep the old pair.
      if (landed.some((r) => r.status === "rejected")) return false;
    }
    await cache.put(key, stored);
    return true;
  } catch {
    return false;
  }
}

/**
 * The /library shell: 100% local data (IndexedDB + Cache
 * Storage), so stale-while-revalidate is safe — offline cold starts render
 * instantly, online visits refresh the shell (and its bundle) in the
 * background, so the offline copy tracks the newest build seen while online
 * instead of the one from whenever sw.js last changed.
 */
async function staleWhileRevalidateDocument(request) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(request.url);
  const key = url.pathname;
  const cached = (await cache.match(request)) || (await cache.match(key));
  if (cached) {
    void storeShellDocument(cache, key, fetch(request).catch(() => null));
    return cached;
  }
  try {
    const response = await fetch(request);
    // Cache after answering — asset caching must never delay first paint.
    void storeShellDocument(cache, key, response.clone());
    return response;
  } catch {
    // await the whole chain: `cached || promise` short-circuits on the
    // Promise itself, which made this offline.html fallback dead code and
    // resolved an empty-cache offline navigation to undefined.
    return (
      (await cache.match("/offline.html")) ||
      new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }
}

/**
 * Tiny static JSON (IntroDB segments): cache-first with background refresh.
 * Keyed by full URL (query included — one entry per episode).
 */
async function staleWhileRevalidateJson(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  if (cached) {
    void networkPromise.catch(() => {});
    return cached;
  }
  return (
    networkPromise ||
    new Response("null", {
      status: 504,
      headers: { "Content-Type": "application/json" },
    })
  );
}

async function cacheFirst(request, cacheName) {  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (
      cached ||
      new Response("", { status: 504, statusText: "Offline" })
    );
  }
}

async function staleWhileRevalidateImage(request) {
  // Posters saved next to a download live in DOWNLOAD_CACHE (unversioned).
  // Serve them cache-first: they must outlive VERSION bumps, which purge
  // IMAGE_CACHE, or the Library opens with empty tiles after an update.
  const downloads = await caches.open(DOWNLOAD_CACHE);
  const kept = await downloads.match(request);
  if (kept) return kept;

  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (response) => {
      // ok or opaque (no-cors image loads)
      if (response && (response.ok || response.type === "opaque")) {
        await cache.put(request, response.clone());
        trimCache(IMAGE_CACHE, IMAGE_CACHE_MAX);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    void networkPromise;
    return cached;
  }
  // Same trap as the document path: `cached || networkPromise` yields the
  // Promise object (always truthy), so an offline miss resolved to undefined.
  return (
    (await networkPromise) ||
    new Response("", { status: 504, statusText: "Offline" })
  );
}

/** Drop oldest entries when over max (FIFO by keys() order) */
function trimCache(cacheName, maxItems) {
  // Fire-and-forget; don't block the image response
  caches.open(cacheName).then(async (cache) => {
    const keys = await cache.keys();
    if (keys.length <= maxItems) return;
    const extra = keys.length - maxItems;
    await Promise.all(keys.slice(0, extra).map((key) => cache.delete(key)));
  });
}

/* ---------- Offline downloads ---------- */

async function serveDownload(request) {
  try {
    const cache = await caches.open(DOWNLOAD_CACHE);
    const cached = await cache.match(request);
    if (!cached) {
      return new Response("Download not found — it may have been removed.", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return serveRange(cached, request);
  } catch {
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/** A plain 200 must advertise range support. Clients that probe for
 * `Accept-Ranges` — Safari's native HLS pipeline among them — read a 200
 * without it as "not seekable", accept the scrub and then never finish it
 * (the element sticks on `seeking` with a frozen frame behind the spinner). */
function withAcceptRanges(cached) {
  // `bodyUsed` guards the catch path in serveRange(): reaching it means
  // `arrayBuffer()` already locked the stream, and wrapping a disturbed body
  // throws a TypeError (which would escape respondWith as a network error).
  if (
    cached.status !== 200 ||
    cached.bodyUsed ||
    cached.headers.has("Accept-Ranges")
  ) {
    return cached;
  }
  const headers = new Headers(cached.headers);
  headers.set("Accept-Ranges", "bytes");
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

/**
 * The Cache API stores whole bodies only — slice 206 responses manually so
 * hls.js fMP4 seeking and Safari native playback can scrub offline
 * downloads. Segments are a few MB, so buffering is cheap.
 */
async function serveRange(cached, request) {
  const range = request.headers.get("range");
  if (!range) return withAcceptRanges(cached);
  // Multi-range (`bytes=0-99,200-299`) needs a multipart/byteranges body the
  // regex below cannot build: answering 206 with only the first span hands
  // the client bytes it believes are complete. RFC 9110 lets us ignore Range
  // entirely and return the whole entity instead.
  if (range.includes(",")) return withAcceptRanges(cached);
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return withAcceptRanges(cached);
  try {
    const buf = await cached.arrayBuffer();
    const total = buf.byteLength;
    let start;
    let end;
    if (m[1] === "") {
      // Suffix form `bytes=-N`: m[2] is a LENGTH from the end, not an end
      // offset — using it as one made every suffix request return 416
      // (start=total-N > end=N for any file > 2N).
      start = Math.max(0, total - Number(m[2] || 0));
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? total - 1 : Number(m[2]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    end = Math.min(end, total - 1);
    if (end < start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const slice = buf.slice(start, end + 1);
    const headers = new Headers(cached.headers);
    headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
    headers.set("Content-Length", String(end - start + 1));
    headers.set("Accept-Ranges", "bytes");
    return new Response(slice, { status: 206, headers });
  } catch {
    return withAcceptRanges(cached);
  }
}

/* ---------- New-episode push alerts ---------- */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "LeviOsa";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192x192.png?v=14",
      badge: "/icons/icon-192x192.png?v=14",
      tag: data.tag || "episode-alert",
      data: { url: data.url || "/calendar" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/calendar";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});
