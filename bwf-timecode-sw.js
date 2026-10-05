const CACHE_NAME = "ltc-slate-helper-v1.4.0";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./src/app-version.js",
  "./src/sync-workflow.js",
  "./src/poly-export-profiles.js",
  "./src/ltc-signal.js",
  "./src/calculator.js",
  "./src/confirm-flows.js",
  "./src/custom-select.js",
  "./src/dialogs.js",
  "./src/file-import.js",
  "./src/fps-metadata.js",
  "./src/fps-write-controller.js",
  "./src/grouping.js",
  "./src/ltc-decoder.js",
  "./src/ltc-controller.js",
  "./src/ltc-diagnostics.js",
  "./src/diagnostics-panel.js",
  "./src/ltc-worker.js",
  "./src/metadata-export-controller.js",
  "./src/metadata-export.js",
  "./src/metadata-import.js",
  "./src/offset-input.js",
  "./src/poly-combine-controller.js",
  "./src/preview-table.js",
  "./src/pwa.js",
  "./src/style.css",
  "./src/timecode.js",
  "./src/timecode-input.js",
  "./src/time-reference-write-controller.js",
  "./src/ui-state.js",
  "./src/video.js",
  "./src/video-metadata.js",
  "./src/wave-audio.js",
  "./src/wave-combine.js",
  "./src/wave-fps-metadata.js",
  "./src/wave.js",
  "./src/wave-time-reference.js",
  "./bwf-timecode.webmanifest",
  "./bwf-timecode-icon.svg",
  "./bwf-timecode-icon-192.png",
  "./bwf-timecode-icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  const sameOrigin = requestUrl.origin === self.location.origin;
  const isPageRequest = event.request.mode === "navigate" ||
    (sameOrigin && (requestUrl.pathname.endsWith("/") || requestUrl.pathname.endsWith("/index.html")));

  if (isPageRequest) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && sameOrigin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
