/* Kinetic Studio (web) service worker.
   - Keeps the app itself on the device so it opens with no connection (updates arrive on the next
     reload when online: app files are fetched from the network first, the saved copy is the fallback).
   - Serves stored receipts and documents at <app>/ksfile/<id> from Supabase Storage with the signed-in
     session, keeping a copy so they open instantly and offline. */
const VERSION = "0.4.0-mwl18a0b";
const SHELL = ["./","fonts/barlow-condensed-latin-600-normal.woff2","fonts/barlow-condensed-latin-700-normal.woff2","fonts/barlow-condensed-latin-800-normal.woff2","fonts/barlow-condensed-latin-ext-600-normal.woff2","fonts/barlow-condensed-latin-ext-700-normal.woff2","fonts/barlow-condensed-latin-ext-800-normal.woff2","fonts/fonts.css","fonts/ibm-plex-mono-latin-400-normal.woff2","fonts/ibm-plex-mono-latin-500-normal.woff2","fonts/ibm-plex-mono-latin-600-normal.woff2","fonts/ibm-plex-mono-latin-ext-400-normal.woff2","fonts/ibm-plex-mono-latin-ext-500-normal.woff2","fonts/ibm-plex-mono-latin-ext-600-normal.woff2","fonts/instrument-sans-latin-400-normal.woff2","fonts/instrument-sans-latin-500-normal.woff2","fonts/instrument-sans-latin-600-normal.woff2","fonts/instrument-sans-latin-700-normal.woff2","fonts/instrument-sans-latin-ext-400-normal.woff2","fonts/instrument-sans-latin-ext-500-normal.woff2","fonts/instrument-sans-latin-ext-600-normal.woff2","fonts/instrument-sans-latin-ext-700-normal.woff2","icons/apple-touch-icon.png","icons/favicon.png","icons/icon-192.png","icons/icon-512.png","index.html","manifest.webmanifest","native.js","vendor/html2canvas.min.js","vendor/jspdf.umd.min.js","vendor/mammoth.browser.min.js","vendor/pdf.min.js","vendor/pdf.worker.min.js","vendor/supabase.js"];
const APP_CACHE = "ks-app-" + VERSION, FILE_CACHE = "ks-files-v1";
let auth = null;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(SHELL.map(p => new Request(p, {cache: "reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("ks-app-") && k !== APP_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data && e.data.type === "session") auth = e.data; });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    const m = /\/ksfile\/([A-Za-z0-9_-]{1,64})$/.exec(u.pathname);
    if (m) { e.respondWith(serveFile(m[1])); return; }
    e.respondWith(appFile(req));
  }
});

async function appFile(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(req, {signal: ctl.signal}); clearTimeout(t);
    if (r.ok) cache.put(req.mode === "navigate" ? new Request(self.registration.scope) : req, r.clone());
    return r;
  } catch (e) {
    const hit = await cache.match(req.mode === "navigate" ? new Request(self.registration.scope) : req, {ignoreSearch: true});
    return hit || new Response("Kinetic Studio is offline and this file isn’t saved on the device yet.", {status: 503, headers: {"Content-Type": "text/plain"}});
  }
}

function askPage() {
  return self.clients.matchAll({type: "window"}).then(async list => {
    for (const c of list) {
      const r = await new Promise(res => {
        const ch = new MessageChannel();
        ch.port1.onmessage = ev => res(ev.data);
        c.postMessage({type: "need-session"}, [ch.port2]);
        setTimeout(() => res(null), 3000);
      });
      if (r && r.token) return r;
    }
    return null;
  });
}

async function serveFile(id) {
  const cache = await caches.open(FILE_CACHE);
  const key = new Request(self.registration.scope + "ksfile-cache/" + id);
  const hit = await cache.match(key);
  if (hit) return hit;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!auth || !auth.token || attempt === 1) auth = await askPage();
    if (!auth || !auth.token) return new Response("Sign in to see this file", {status: 401});
    let r;
    try {
      r = await fetch(`${auth.url}/storage/v1/object/authenticated/files/${id}`, {headers: {apikey: auth.key, Authorization: "Bearer " + auth.token}});
    } catch (e) { return new Response("Offline: this file isn’t saved on this device yet", {status: 503}); }
    if (r.ok) {
      const blob = await r.blob();
      const resp = new Response(blob, {headers: {"Content-Type": r.headers.get("content-type") || "application/octet-stream"}});
      await cache.put(key, resp.clone());
      return resp;
    }
    if (r.status !== 400 && r.status !== 401 && r.status !== 403) return new Response("File not found", {status: r.status === 404 ? 404 : 502});
  }
  return new Response("File not found", {status: 404});
}
