/* Service worker for the buyer web (ADR-004: low bandwidth). Registered in production only by
 * src/features/pwa/sw-register.tsx. The request rules below are a plain-JS copy of src/features/pwa/sw-rules.ts, and
 * test/pwa-sw.test.ts checks that both give the same answer, so change them together.
 *
 *   - Only same-origin GETs are handled. POSTs, server actions, cross-origin and Range requests go to the network.
 *   - /api, auth and signed-in areas are never intercepted, so they can never be cached.
 *   - /_next/static (fingerprinted) and images: cache first.
 *   - Page navigations: network first; offline, the last good copy (help pages only) or the /offline page.
 */
"use strict";

var VERSION = "v1";
var STATIC_CACHE = "cnote-static-" + VERSION;
var IMAGE_CACHE = "cnote-img-" + VERSION;
var PAGE_CACHE = "cnote-pages-" + VERSION;
var CURRENT = [STATIC_CACHE, IMAGE_CACHE, PAGE_CACHE];
var MAX_IMAGES = 80;

var PRIVATE_PREFIXES = ["/api", "/account", "/buyer", "/rfq", "/conversations", "/wishlist", "/compare", "/onboarding", "/signin", "/signup", "/forgot-password", "/reset-password", "/grievance", "/preview", "/r/", "/ad/"];
var CACHEABLE_NAVIGATION_PREFIXES = ["/help", "/hi/help", "/offline", "/hi/offline"];
var OFFLINE_PATHS = { en: "/offline", hi: "/hi/offline" };

function startsWithPath(path, prefix) {
  return prefix.charAt(prefix.length - 1) === "/" ? path.indexOf(prefix) === 0 : path === prefix || path.indexOf(prefix + "/") === 0;
}
function isPrivatePath(path) {
  return PRIVATE_PREFIXES.some(function (p) { return startsWithPath(path, p); });
}
function isCacheableNavigation(path) {
  return CACHEABLE_NAVIGATION_PREFIXES.some(function (p) { return startsWithPath(path, p); });
}
function offlineFor(path) {
  return startsWithPath(path, "/hi") ? OFFLINE_PATHS.hi : OFFLINE_PATHS.en;
}
function classify(req) {
  if (req.method !== "GET" || req.range) return "bypass";
  var url;
  try {
    url = new URL(req.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== req.origin) return "bypass";
  var path = url.pathname;
  if (isPrivatePath(path)) return "bypass";
  if (path === "/sw.js" || path === "/manifest.webmanifest") return "bypass";
  if (path.indexOf("/_next/static/") === 0) return "static";
  if (req.destination === "image" || path.indexOf("/_next/image") === 0) return "image";
  if (req.mode === "navigate") return "navigate";
  return "bypass";
}

// Exposed for the unit test (it runs this file in a sandbox); harmless in a real worker.
self.__swRules = { classify: classify, offlineFor: offlineFor, isPrivatePath: isPrivatePath, isCacheableNavigation: isCacheableNavigation, PRIVATE_PREFIXES: PRIVATE_PREFIXES, CACHEABLE_NAVIGATION_PREFIXES: CACHEABLE_NAVIGATION_PREFIXES, OFFLINE_PATHS: OFFLINE_PATHS };

/** Only successful, same-origin responses that did not ask to stay out of shared or private caches are stored. */
function storable(res) {
  if (!res || !res.ok || res.type !== "basic") return false;
  return !/no-store|private/i.test(res.headers.get("cache-control") || "");
}

function trim(cacheName, max) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      return keys.length > max ? Promise.all(keys.slice(0, keys.length - max).map(function (k) { return cache.delete(k); })) : null;
    });
  });
}

function cacheFirst(request, cacheName, max) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (res) {
        if (storable(res)) {
          cache.put(request, res.clone());
          if (max) trim(cacheName, max);
        }
        return res;
      });
    });
  });
}

function networkFirstNavigation(request) {
  var path = new URL(request.url).pathname;
  return fetch(request)
    .then(function (res) {
      if (isCacheableNavigation(path) && storable(res)) {
        var copy = res.clone();
        caches.open(PAGE_CACHE).then(function (cache) { return cache.put(request, copy); });
      }
      return res;
    })
    .catch(function () {
      return caches.match(request).then(function (hit) {
        return hit || caches.match(offlineFor(path)).then(function (page) {
          return page || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        });
      });
    });
}

// Offline pages (and the static assets they reference) are fetched at install so the fallback works on the first outage.
function precache() {
  return Promise.all(
    [OFFLINE_PATHS.en, OFFLINE_PATHS.hi].map(function (p) {
      return fetch(p, { cache: "reload" }).then(function (res) {
        if (!storable(res)) return null;
        var copy = res.clone();
        return Promise.all([
          caches.open(PAGE_CACHE).then(function (c) { return c.put(p, copy); }),
          res.text().then(function (html) {
            var assets = (html.match(/\/_next\/static\/[^"'\s\\)]+/g) || []).filter(function (a, i, all) { return all.indexOf(a) === i; });
            return caches.open(STATIC_CACHE).then(function (c) { return Promise.all(assets.map(function (a) { return c.add(a).catch(function () { return null; }); })); });
          }),
        ]);
      });
    }),
  ).catch(function () { return null; });
}

self.addEventListener("install", function (event) {
  event.waitUntil(precache().then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k.indexOf("cnote-") === 0 && CURRENT.indexOf(k) === -1; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); }),
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  var strategy = classify({ method: req.method, url: req.url, mode: req.mode, destination: req.destination, origin: self.location.origin, range: req.headers.has("range") });
  if (strategy === "bypass") return;
  if (strategy === "static") event.respondWith(cacheFirst(req, STATIC_CACHE));
  else if (strategy === "image") event.respondWith(cacheFirst(req, IMAGE_CACHE, MAX_IMAGES));
  else event.respondWith(networkFirstNavigation(req));
});
