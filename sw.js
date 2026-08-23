const CACHE = "div-it-v2";
const FILES = ["./", "./index.html", "./style.css", "./app.js", "./ledger.js", "./manifest.webmanifest"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES))));
self.addEventListener("fetch", (event) => event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request))));
