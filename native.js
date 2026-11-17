/* Kinetic Studio — device layer for the Mac app and the web version.
   Implements the window.claude.use(...) capabilities the Claude artifact gets from Claude, on top of:
   - Supabase: data, file storage, sign-in, and Claude document reading (Edge Function "claude")
   - Mac app: a "Kinetic Studio" folder in your home folder mirrored into Google Drive, Finder, auto-updates
   - Web: a service worker that serves stored files, browser downloads, the share sheet on phones
   Files saved or uploaded on the web go to an "outbox"; the Mac app copies them into the
   Kinetic Studio folder and Google Drive the next time it's open. */
(() => {
"use strict";
const T = window.__TAURI__ || null;
const WEB = !T;
if (WEB && !window.KS_WEB) return;   // the Claude artifact doesn't use this layer

const BUILD = window.KS_BUILD || {};
const LS = {
  get(k, d) { try { const v = localStorage.getItem("ks." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("ks." + k, JSON.stringify(v)); } catch (e) {} }
};
const cfg = () => ({
  supabaseUrl: LS.get("supabaseUrl", BUILD.supabaseUrl || ""),
  supabaseKey: LS.get("supabaseKey", BUILD.supabaseKey || ""),
  webUrl: BUILD.webUrl || "",
  localRoot: LS.get("localRoot", "Kinetic Studio"),
  driveRoot: LS.get("driveRoot", ""),
  driveFolder: LS.get("driveFolder", "Kinetic Studio"),
  driveOff: LS.get("driveOff", false)
});
const TOUCH = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const hex32 = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const cleanName = s => String(s || "file").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 180) || "file";
async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(String(data));
}
const toBlob = async (data, type) => data instanceof Blob ? data : new Blob([await toBytes(data)], {type: type || "application/octet-stream"});
const FOLDER_OF_KIND = {receipt: "Receipts", crewinv: "Freelancer invoices", clientsow: "Client SOWs"};
function folderForExport(filename) {
  if (/ - Invoice - /i.test(filename)) return "Invoices";
  if (/ - Estimate - /i.test(filename)) return "Estimates";
  if (/ - Expense Report - /i.test(filename)) return "Expense reports";
  if (/ - Statement of Work - /i.test(filename)) return "Crew SOWs";
  if (/\.csv$/i.test(filename)) return "Exports";
  return "Downloads";
}

/* Read before Supabase consumes it: an invite or password-reset link lands here with #...type=invite|recovery */
const LINK_TYPE = (/[#&?]type=(invite|recovery|signup|magiclink)\b/.exec(location.hash + location.search) || [])[1] || "";

/* ---------------- small UI ---------------- */
const css = document.createElement("style");
css.textContent = `
.ksn-toast{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:90;background:#14171C;color:#fff;padding:10px 14px;border-radius:10px;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;max-width:min(420px,calc(100vw - 32px));box-shadow:0 8px 24px rgba(0,0,0,.25)}
.ksn-gate{position:fixed;inset:0;z-index:95;background:#E8EBF0;display:flex;align-items:center;justify-content:center;font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;color:#14171C;padding:16px}
.ksn-card{background:#fff;border:1px solid #D2D7DF;border-radius:14px;padding:28px;width:min(420px,100%);display:flex;flex-direction:column;gap:12px;box-shadow:0 20px 60px rgba(10,14,22,.12)}
.ksn-card h1{margin:0;font:800 30px/1 "Barlow Condensed","Arial Narrow",Arial,sans-serif;text-transform:uppercase;letter-spacing:.02em}
.ksn-card p{margin:0;color:#7A8392;font-size:13px}
.ksn-card label{font-size:11px;font-weight:600;color:#4B5361;display:flex;flex-direction:column;gap:4px}
.ksn-card input{border:1px solid #D2D7DF;border-radius:6px;padding:10px;font:inherit;font-size:16px}
.ksn-card button{border:0;border-radius:8px;padding:12px 14px;font:600 15px/1 inherit;background:#2347D6;color:#fff;cursor:pointer}
.ksn-card button.ghost{background:transparent;color:#2347D6;padding:4px 0;text-align:left;font-size:13px}
.ksn-card .err{color:#B42318;font-size:13px;min-height:1em}
.ksn-card .ok{color:#17713A;font-size:13px}
.ksn-banner{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 70px);transform:translateX(-50%);z-index:85;background:#2347D6;color:#fff;border-radius:999px;padding:8px 8px 8px 16px;display:flex;gap:10px;align-items:center;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2)}
.ksn-banner button{border:0;border-radius:999px;padding:6px 12px;font:600 12px inherit;cursor:pointer;background:#fff;color:#2347D6}
.ksn-sheet{position:fixed;left:0;right:0;bottom:0;z-index:92;background:#fff;color:#14171C;border-radius:16px 16px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.25);padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:10px;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif}
.ksn-sheet b{font-size:15px}
.ksn-sheet p{margin:0;color:#4B5361;font-size:13px}
.ksn-sheet .r{display:flex;gap:8px;flex-wrap:wrap}
.ksn-sheet button,.ksn-sheet a{flex:1 1 140px;border:0;border-radius:10px;padding:13px 14px;font:600 15px/1 inherit;background:#E3E9FF;color:#2347D6;text-align:center;text-decoration:none;cursor:pointer}
.ksn-sheet .pri{background:#2347D6;color:#fff}
@media (prefers-color-scheme: dark){.ksn-gate{background:#0D1015;color:#E7EAF0}.ksn-card,.ksn-sheet{background:#161A21!important;border-color:#2B323D!important;color:#E7EAF0}.ksn-card input{background:#0D1015!important;color:#E7EAF0!important;border-color:#2B323D!important}.ksn-sheet p{color:#AAB2BF}.ksn-sheet button:not(.pri),.ksn-sheet a:not(.pri){background:#1E2533;color:#9DB2FF}}
.ksn-sync{position:fixed;left:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:88;background:#14171C;color:#fff;border-radius:999px;padding:7px 13px 7px 28px;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.2)}
.ksn-sync::before{content:"";position:absolute;left:12px;top:50%;width:8px;height:8px;margin-top:-4px;border-radius:50%;background:#4C7DFF}
.ksn-sync.off::before{background:#E5A50A}
.ksn-set{display:flex;flex-direction:column;gap:10px}
.ksn-set .ksn-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ksn-set code{font-size:11.5px;word-break:break-all}
`;
document.head.appendChild(css);
let toastT = 0;
function toast(msg) {
  let el = document.querySelector(".ksn-toast");
  if (!el) { el = document.createElement("div"); el.className = "ksn-toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 4200);
}
function sheet(html, onMount) {
  document.querySelectorAll(".ksn-sheet").forEach(x => x.remove());
  const el = document.createElement("div"); el.className = "ksn-sheet"; el.setAttribute("role", "dialog");
  el.innerHTML = html + `<div class="r"><button type="button" data-close>Close</button></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", e => { if (e.target.closest("[data-close]")) el.remove(); });
  if (onMount) onMount(el);
  return el;
}

/* ---------------- Supabase + sign-in ---------------- */
let sb = null, session = null, authReady = null;
function client() {
  const c = cfg();
  if (!c.supabaseUrl || !c.supabaseKey || !window.supabase) return null;
  if (!sb) sb = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: WEB, storageKey: "ks.auth"}});
  return sb;
}
async function sessionChanged() {
  const c = cfg(), token = session ? session.access_token : "";
  if (T) { try { await T.core.invoke("set_session", {url: c.supabaseUrl, key: c.supabaseKey, token}); } catch (e) { console.error(e); } }
  else postSessionToWorker();
}
function gate(html, onMount) {
  let g = document.querySelector(".ksn-gate");
  if (!g) { g = document.createElement("div"); g.className = "ksn-gate"; document.body.appendChild(g); }
  g.innerHTML = `<form class="ksn-card" autocomplete="on">${html}</form>`;
  onMount(g.querySelector("form"));
}
const closeGate = () => { const g = document.querySelector(".ksn-gate"); if (g) g.remove(); };
const resetTarget = () => cfg().webUrl || (WEB ? location.origin + location.pathname : undefined);
function ensureAuth() {
  if (authReady) return authReady;
  authReady = new Promise(resolve => {
    const done = async (s, sess) => { session = sess; await sessionChanged(); closeGate(); resolve(s); };
    const setPassword = (s, sess) => gate(`<h1>Kinetic Studio</h1><p>${LINK_TYPE === "invite" ? "Welcome. Choose a password for your Studio login" : "Choose a new password"} (${esc(sess.user.email)}).</p>
        <label>New password<input name="p" type="password" autocomplete="new-password" required minlength="10"></label>
        <label>Repeat it<input name="p2" type="password" autocomplete="new-password" required minlength="10"></label>
        <div class="err"></div><button type="submit">Save password</button>`, f => {
      f.addEventListener("submit", async e => {
        e.preventDefault(); const err = f.querySelector(".err"); err.textContent = "";
        if (f.p.value !== f.p2.value) { err.textContent = "The two passwords don’t match."; return; }
        const r = await s.auth.updateUser({password: f.p.value});
        if (r.error) { err.textContent = r.error.message; return; }
        history.replaceState(null, "", location.pathname);
        done(s, (await s.auth.getSession()).data.session);
      });
    });
    const start = async () => {
      const s = client();
      if (!s) {
        gate(`<h1>Kinetic Studio</h1><p>Connect to your Supabase project (Project Settings → API).</p>
          <label>Project URL<input name="u" placeholder="https://xxxx.supabase.co" required value="${esc(cfg().supabaseUrl)}"></label>
          <label>Publishable key<input name="k" required value="${esc(cfg().supabaseKey)}"></label>
          <div class="err"></div><button type="submit">Continue</button>`, f => {
          f.addEventListener("submit", e => { e.preventDefault(); LS.set("supabaseUrl", f.u.value.trim().replace(/\/$/, "")); LS.set("supabaseKey", f.k.value.trim()); sb = null; start(); });
        });
        return;
      }
      let {data, error} = await s.auth.getSession().catch(e => ({data: null, error: e}));
      if (!(data && data.session) && (navigator.onLine === false || isNetErr(error))) {
        // Offline with an expired sign-in: keep working from the saved one; it refreshes when the connection is back.
        try { const saved = JSON.parse(localStorage.getItem("ks.auth") || "null"); if (saved && saved.user && saved.refresh_token) { data = {session: saved}; lastSyncErr = "offline"; } } catch (e) {}
      }
      if (data && data.session) {
        session = data.session;
        if (LINK_TYPE === "invite" || LINK_TYPE === "recovery") { setPassword(s, data.session); return; }
        return done(s, data.session);
      }
      gate(`<h1>Kinetic Studio</h1><p>Sign in to Kinetic Creative Labs’ studio.</p>
        <label>Email<input name="e" type="email" autocomplete="username" required value="${esc(LS.get("lastEmail", ""))}"></label>
        <label>Password<input name="p" type="password" autocomplete="current-password" required></label>
        <div class="err" aria-live="polite"></div><button type="submit">Sign in</button>
        <button type="button" class="ghost" data-forgot>Forgot your password?</button>`, f => {
        f.querySelector("[data-forgot]").addEventListener("click", async () => {
          const err = f.querySelector(".err"), email = f.e.value.trim();
          if (!email) { err.textContent = "Type your email first."; return; }
          const r = await s.auth.resetPasswordForEmail(email, {redirectTo: resetTarget()});
          err.className = r.error ? "err" : "ok";
          err.textContent = r.error ? r.error.message : "Check your email for a link to set a new password.";
        });
        f.addEventListener("submit", async e => {
          e.preventDefault();
          const err = f.querySelector(".err"); err.className = "err"; err.textContent = "";
          const email = f.e.value.trim(); LS.set("lastEmail", email);
          const r = await s.auth.signInWithPassword({email, password: f.p.value});
          if (r.error) { err.textContent = r.error.message; return; }
          done(s, r.data.session);
        });
      });
    };
    start();
  });
  return authReady;
}
function watchAuth(s) {
  s.auth.onAuthStateChange((ev, sess) => {
    if (!sess && ev !== "SIGNED_OUT") return;   // a failed refresh while offline: keep the saved sign-in
    session = sess; sessionChanged();
    if (ev === "SIGNED_OUT") { authReady = null; idb.clearAll().catch(() => {}).then(() => location.reload()); }
    if (ev === "TOKEN_REFRESHED" && pendingN) flushSoon(200);
  });
}
async function signOut() {
  if (pendingN && !confirm(`${pendingN} change${pendingN === 1 ? " hasn’t" : "s haven’t"} synced yet. Signing out now will lose ${pendingN === 1 ? "it" : "them"}. Sign out anyway?`)) return;
  await client().auth.signOut();
}

/* ---------------- offline: device copy of every record, plus a queue of changes not yet synced ---------------- */
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("kinetic-studio", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("docs"); d.createObjectStore("queue", {keyPath: "seq", autoIncrement: true}); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), st = t.objectStore(store); let out;
      const r = fn(st); if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  const range = c => IDBKeyRange.bound(c + "\u0000", c + "\u0001");
  return {
    getCollection: c => run("docs", "readonly", st => st.getAll(range(c))),
    putCollection: (c, rows) => run("docs", "readwrite", st => { st.delete(range(c)); rows.forEach(r => st.put({id: r.id, data: r.data}, c + "\u0000" + r.id)); }),
    putDoc: (c, id, data) => run("docs", "readwrite", st => st.put({id, data}, c + "\u0000" + id)),
    delDoc: (c, id) => run("docs", "readwrite", st => st.delete(c + "\u0000" + id)),
    queueAll: () => run("queue", "readonly", st => st.getAll()),
    enqueue: item => run("queue", "readwrite", st => st.add(item)),
    dequeue: seq => run("queue", "readwrite", st => st.delete(seq)),
    clearAll: () => Promise.all([run("docs", "readwrite", st => st.clear()), run("queue", "readwrite", st => st.clear())])
  };
})();
const isNetErr = e => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const m = String((e && (e.message || e.error_description || e.code)) || e || "");
  return /failed to fetch|networkerror|network request|load failed|fetch failed|timed? ?out|err_internet|offline|connection|socket|status.?0\b/i.test(m) || (e && e.status === 0);
};
let pendingN = 0, syncing = false, lastSyncErr = "";
const pendingKeys = new Map();   // "collection/id" -> count of queued changes
const kOf = (c, id) => c + "/" + id;
async function loadQueueState() {
  const items = await idb.queueAll().catch(() => []);
  pendingKeys.clear(); pendingN = items.length;
  items.forEach(it => { if (it.kind === "doc") pendingKeys.set(kOf(it.c, it.id), (pendingKeys.get(kOf(it.c, it.id)) || 0) + 1); });
  indicator();
  return items;
}
async function enqueue(item) {
  await idb.enqueue({...item, at: Date.now()});
  pendingN++; if (item.kind === "doc") pendingKeys.set(kOf(item.c, item.id), (pendingKeys.get(kOf(item.c, item.id)) || 0) + 1);
  indicator(); flushSoon();
}
async function applyRemote(it) {
  const s = client();
  if (it.kind === "file") return storagePut(it.id, it.blob, it.type);
  if (it.op === "set") { const {error} = await s.from("docs").upsert({collection: it.c, id: it.id, data: it.data, updated_at: new Date(it.at).toISOString()}); if (error) throw error; }
  else if (it.op === "merge") { const {error} = await s.rpc("doc_merge", {p_collection: it.c, p_id: it.id, p_patch: it.data}); if (error) throw error; }
  else if (it.op === "delete") { const {error} = await s.from("docs").delete().eq("collection", it.c).eq("id", it.id); if (error) throw error; }
}
let flushT = 0;
const flushSoon = (ms = 400) => { clearTimeout(flushT); flushT = setTimeout(flush, ms); };
async function flush() {
  if (syncing || !session) return;
  syncing = true; indicator();
  let synced = 0, failed = 0;
  try {
    const {data: cur} = await client().auth.getSession().catch(() => ({data: {}}));
    if (cur && cur.session) session = cur.session;
    const items = await idb.queueAll();
    for (const it of items) {
      try { await applyRemote(it); synced++; }
      catch (e) {
        if (isNetErr(e)) { lastSyncErr = "offline"; break; }
        console.error("Couldn’t sync a change", it, e); failed++;   // a change the server refuses won't succeed on retry
      }
      await idb.dequeue(it.seq);
      pendingN = Math.max(0, pendingN - 1);
      if (it.kind === "doc") { const k = kOf(it.c, it.id), n = (pendingKeys.get(k) || 1) - 1; n ? pendingKeys.set(k, n) : pendingKeys.delete(k); }
      lastSyncErr = "";
    }
  } catch (e) { console.error(e); }
  syncing = false; indicator();
  if (failed) toast(`${failed} change${failed === 1 ? "" : "s"} couldn’t be saved to Studio and ${failed === 1 ? "was" : "were"} skipped. Check the latest edits.`);
  if (synced && !pendingN) { toast(`Back online. ${synced} change${synced === 1 ? "" : "s"} synced.`); window.dispatchEvent(new Event("ks-synced")); }
  if (pendingN && navigator.onLine !== false && lastSyncErr !== "offline") flushSoon(15000);
}
/* "Offline · 3 changes waiting" pill */
function indicator() {
  const off = navigator.onLine === false || lastSyncErr === "offline";
  let el = document.querySelector(".ksn-sync");
  const text = off ? (pendingN ? `Offline · ${pendingN} change${pendingN === 1 ? "" : "s"} waiting` : "Offline · changes save on this device")
    : syncing && pendingN ? `Syncing ${pendingN} change${pendingN === 1 ? "" : "s"}…` : pendingN ? `${pendingN} change${pendingN === 1 ? "" : "s"} waiting to sync` : "";
  if (!text) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement("div"); el.className = "ksn-sync"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.classList.toggle("off", off); el.textContent = text;
}
window.addEventListener("online", () => { lastSyncErr = ""; indicator(); flushSoon(200); if (dbInst) dbInst._refreshAll(); });
window.addEventListener("offline", indicator);
setInterval(() => { if (pendingN && !syncing) flushSoon(0); }, 60000);   // also covers Wi-Fi that's connected but not online
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && dbInst) { flushSoon(200); dbInst._refreshAll(); } });

/* ---------------- db: same API as the artifact's db capability ---------------- */
function dbErr(e) {
  const m = String((e && (e.message || e.code)) || "");
  if (/row-level security|permission|not allowed|JWT/i.test(m)) return {code: "permission_denied", message: m};
  return {code: "unavailable", message: m};
}
function makeDb(s) {
  const store = new Map(), loaded = new Map(), listeners = new Map(), docListeners = new Map(), timers = new Map();
  const col = name => { if (!store.has(name)) store.set(name, new Map()); return store.get(name); };
  const clone = d => JSON.parse(JSON.stringify(d));
  const snapOf = name => ({docs: [...col(name).entries()].map(([id, d]) => ({id, data: () => clone(d)})), size: col(name).size});
  const docSnap = (c, id) => { const d = col(c).get(id); return {id, exists: !!d, data: () => d ? clone(d) : undefined}; };
  function emit(c, id) {
    clearTimeout(timers.get(c));
    timers.set(c, setTimeout(() => { (listeners.get(c) || []).forEach(fn => { try { fn(snapOf(c)); } catch (e) { console.error(e); } }); }, 40));
    if (id !== undefined) (docListeners.get(c + "/" + id) || []).forEach(fn => { try { fn(docSnap(c, id)); } catch (e) { console.error(e); } });
    else for (const [k, set] of docListeners) if (k.startsWith(c + "/")) set.forEach(fn => { try { fn(docSnap(c, k.slice(c.length + 1))); } catch (e) { console.error(e); } });
  }
  /* Apply queued (unsynced) changes on top of what the server sent, so nothing typed offline flickers away. */
  async function overlay(c, m) {
    const items = await idb.queueAll().catch(() => []);
    for (const it of items) {
      if (it.kind !== "doc" || it.c !== c) continue;
      if (it.op === "set") m.set(it.id, clone(it.data));
      else if (it.op === "merge") m.set(it.id, {...(m.get(it.id) || {}), ...clone(it.data)});
      else if (it.op === "delete") m.delete(it.id);
    }
  }
  async function fetchRemote(c) {
    const rows = []; let from = 0;
    for (;;) {
      const {data, error} = await s.from("docs").select("id,data").eq("collection", c).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break; from += 1000;
    }
    return rows;
  }
  async function refresh(c, mustLoad) {
    try {
      const rows = await fetchRemote(c);
      idb.putCollection(c, rows).catch(e => console.warn("device copy", e));
      const m = new Map(rows.map(r => [r.id, r.data]));
      await overlay(c, m);
      store.set(c, m); emit(c);
    } catch (e) {
      if (!isNetErr(e) && mustLoad) throw dbErr(e);
      if (isNetErr(e)) { lastSyncErr = "offline"; indicator(); }
      if (mustLoad) emit(c);
    }
  }
  async function load(c) {
    if (loaded.has(c)) return loaded.get(c);
    const p = (async () => {
      const cached = await idb.getCollection(c).catch(() => null);
      if (cached && cached.length) {
        const m = new Map(cached.map(r => [r.id, r.data]));
        await overlay(c, m); store.set(c, m); emit(c);
        refresh(c, false);            // update from the server in the background
      } else await refresh(c, true);
    })();
    p.catch(() => loaded.delete(c));
    loaded.set(c, p);
    return p;
  }
  let refreshing = false;
  const refreshAll = async () => { if (refreshing) return; refreshing = true; try { for (const c of loaded.keys()) await refresh(c, false); } finally { refreshing = false; } };
  let wasDown = false;
  s.channel("docs-" + hex32().slice(0, 8)).on("postgres_changes", {event: "*", schema: "public", table: "docs"}, ev => {
    const rec = ev.eventType === "DELETE" ? ev.old : ev.new;
    if (!rec || !rec.collection) return;
    if (rec.collection === "outbox" && ev.eventType === "INSERT") onOutbox();
    if (pendingKeys.has(kOf(rec.collection, rec.id))) return;   // our own unsynced change wins until it syncs
    if (ev.eventType === "DELETE") idb.delDoc(rec.collection, rec.id).catch(() => {}); else idb.putDoc(rec.collection, rec.id, rec.data).catch(() => {});
    if (!loaded.has(rec.collection)) return;
    if (ev.eventType === "DELETE") col(rec.collection).delete(rec.id); else col(rec.collection).set(rec.id, rec.data);
    emit(rec.collection, rec.id);
  }).subscribe(status => {
    if (status === "SUBSCRIBED") { if (wasDown) { wasDown = false; refreshAll(); flushSoon(200); } }
    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") wasDown = true;
  });
  /* Online with nothing queued: write straight to the server, as before. Otherwise (or if the network drops): queue it. */
  async function write(c, id, op, data, local) {
    local();
    if (op === "delete") idb.delDoc(c, id).catch(() => {}); else idb.putDoc(c, id, col(c).get(id)).catch(() => {});
    emit(c, id);
    if (!pendingN && navigator.onLine !== false) {
      try { await applyRemote({kind: "doc", op, c, id, data, at: Date.now()}); lastSyncErr = ""; indicator(); return; }
      catch (e) { if (!isNetErr(e)) throw dbErr(e); lastSyncErr = "offline"; }
    }
    await enqueue({kind: "doc", op, c, id, data});
  }
  function docRef(c, id) {
    return {
      id,
      async get() { await load(c); return docSnap(c, id); },
      onSnapshot(cb, onErr) {
        const k = c + "/" + id; if (!docListeners.has(k)) docListeners.set(k, new Set()); docListeners.get(k).add(cb);
        load(c).then(() => cb(docSnap(c, id))).catch(e => onErr && onErr(e));
        return () => docListeners.get(k).delete(cb);
      },
      async set(data) { const clean = clone(data); await write(c, id, "set", clean, () => col(c).set(id, clean)); },
      async update(patch) { const clean = clone(patch); await write(c, id, "merge", clean, () => col(c).set(id, {...(col(c).get(id) || {}), ...clean})); },
      async delete() { await write(c, id, "delete", null, () => col(c).delete(id)); }
    };
  }
  return {
    collection(c) {
      return {
        doc: id => docRef(c, id || hex32()),
        onSnapshot(cb, onErr) {
          if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb);
          load(c).then(() => cb(snapOf(c))).catch(e => onErr && onErr(e));
          return () => listeners.get(c).delete(cb);
        },
        async get() { await load(c); return snapOf(c); }
      };
    },
    doc(p) { const parts = String(p).split("/"); return docRef(parts.slice(0, -1).join("/"), parts[parts.length - 1]); },
    _refreshAll: refreshAll,
    _bulkSet: async (c, rows) => {
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map(r => ({collection: c, id: r.id, data: r.data, updated_at: new Date().toISOString()}));
        const {error} = await s.from("docs").upsert(chunk); if (error) throw dbErr(error);
      }
    }
  };
}

/* ---------------- files (shared) ---------------- */
const bucket = () => client().storage.from("files");
async function storagePut(id, blob, type) {
  const {error} = await bucket().upload(id, blob, {contentType: type, upsert: true});
  if (error) throw isNetErr(error) ? error : {code: /exceed|too large|size/i.test(error.message) ? "too_large" : "upstream_error", message: error.message};
}
/* Keep the file on this device first (so it shows right away, even offline), then upload or queue it. */
async function putFile(id, blob, type) {
  await localCachePut(id, blob, type).catch(e => console.warn(e));
  if (!pendingN && navigator.onLine !== false) {
    try { await storagePut(id, blob, type); return; }
    catch (e) { if (!isNetErr(e)) throw e; lastSyncErr = "offline"; }
  }
  await enqueue({kind: "file", id, blob, type});
}
function makeAssets() {
  return {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type || "application/octet-stream", id = hex32();
      await putFile(id, blob, type);
      return {id, url: fileUrl(id), sizeBytes: blob.size, contentType: type};
    },
    async delete(id) {
      await localCacheDelete(id).catch(() => {});
      try { await bucket().remove([id]); } catch (e) { if (!isNetErr(e)) throw e; }
      return {deleted: true};
    },
    async list() { return {assets: [], usage: {}}; }
  };
}
/* Web → Mac: queue a file for the Kinetic Studio folder + Google Drive */
async function queueForMac(folder, name, blob) {
  const id = "ob-" + hex32();
  await putFile(id, blob, blob.type || "application/octet-stream");
  await dbInst.doc("outbox/" + id).set({folder, name: cleanName(name), fileId: id, type: blob.type || "", createdAt: Date.now(), by: session && session.user ? session.user.email : ""});
}

/* ================= Mac app ================= */
let fileUrl, localCachePut, localCacheDelete, keepOriginal, downloads, mcp, mountSettings, afterSignIn, onOutbox = () => {};
if (T) {
  const {fs, path, opener} = T;
  const BD = (path && path.BaseDirectory) || fs.BaseDirectory, BASE_HOME = BD.Home, BASE_CACHE = BD.AppCache;
  fileUrl = id => `ksfile://localhost/${id}`;
  localCachePut = async (id, blob, type) => {
    await fs.mkdir("files", {baseDir: BASE_CACHE, recursive: true}).catch(() => {});
    await fs.writeFile(`files/${id}`, await toBytes(blob), {baseDir: BASE_CACHE});
    await fs.writeTextFile(`files/${id}.type`, type || "application/octet-stream", {baseDir: BASE_CACHE});
  };
  localCacheDelete = async id => { await fs.remove(`files/${id}`, {baseDir: BASE_CACHE}).catch(() => {}); await fs.remove(`files/${id}.type`, {baseDir: BASE_CACHE}).catch(() => {}); };
  async function detectDrive() {
    if (cfg().driveRoot) return cfg().driveRoot;
    try {
      const entries = await fs.readDir("Library/CloudStorage", {baseDir: BASE_HOME});
      const g = entries.find(e => e.isDirectory && /^GoogleDrive-/i.test(e.name));
      if (!g) return "";
      const root = await path.join(await path.homeDir(), "Library/CloudStorage", g.name, "My Drive");
      if (await fs.exists(root)) { LS.set("driveRoot", root); return root; }
    } catch (e) { console.warn("Google Drive folder not found", e); }
    return "";
  }
  /* ~/Kinetic Studio/<folder>/<name>, plus the same under Google Drive */
  async function keepFile(folder, name, bytes) {
    const c = cfg(), rel = `${c.localRoot}/${folder}`, fname = cleanName(name);
    await fs.mkdir(rel, {baseDir: BASE_HOME, recursive: true});
    await fs.writeFile(`${rel}/${fname}`, bytes, {baseDir: BASE_HOME});
    const localPath = await path.join(await path.homeDir(), rel, fname);
    let drivePath = "";
    if (!c.driveOff) {
      const root = await detectDrive();
      if (root) {
        try {
          const dir = await path.join(root, c.driveFolder, folder);
          await fs.mkdir(dir, {recursive: true});
          drivePath = await path.join(dir, fname);
          await fs.writeFile(drivePath, bytes);
        } catch (e) { console.error("Drive copy failed", e); drivePath = ""; toast("Saved on this Mac. The Google Drive copy failed; check that Google Drive for desktop is running."); }
      }
    }
    return {localPath, drivePath};
  }
  keepOriginal = async (file, kind) => keepFile(FOLDER_OF_KIND[kind] || "Documents", `${todayISO()} ${file.name || "file"}`, await toBytes(file));
  downloads = {
    async save({filename, data}) {
      const folder = folderForExport(filename), r = await keepFile(folder, filename, await toBytes(data));
      toast(`Saved to ${cfg().localRoot} › ${folder}${r.drivePath ? " and Google Drive" : ""}`);
      if (LS.get("revealSaves", true)) opener.revealItemInDir(r.localPath).catch(() => {});
      return {saved: true, path: r.localPath};
    }
  };
  mcp = {
    async callTool(server, tool, input) {
      if (server !== "Gmail" || tool !== "create_draft") throw {code: "server_not_connected", message: `${server} isn't available in the app`};
      let revealPath = "";
      for (const a of input.attachments || []) {
        const bytes = Uint8Array.from(atob(a.content), ch => ch.charCodeAt(0));
        revealPath = (await keepFile(folderForExport(a.filename || "attachment.pdf"), a.filename || "attachment.pdf", bytes)).localPath;
      }
      await opener.openUrl(gmailComposeUrl(input));
      if (revealPath) await opener.revealItemInDir(revealPath).catch(() => {});
      return {payload: {note: revealPath ? "Gmail opened in your browser with the message filled in. The PDF is selected in Finder; drag it into the email, then send." : "Gmail opened in your browser with the message filled in."}};
    },
    async listTools() { return {servers: [{server: "Gmail", authStatus: "connected", tools: [{name: "create_draft"}]}]}; }
  };
  /* Files added on the web (phone, Lauren's browser) → Kinetic Studio folder + Google Drive */
  let outboxBusy = false, outboxAgain = false;
  onOutbox = async () => {
    if (outboxBusy) { outboxAgain = true; return; }
    outboxBusy = true;
    try {
      do {
        outboxAgain = false;
        const s = client();
        const {data, error} = await s.from("docs").select("id,data").eq("collection", "outbox").limit(100);
        if (error) throw error;
        for (const row of data) {
          const d = row.data || {};
          const dl = await bucket().download(d.fileId);
          if (dl.error) { if (/not.?found/i.test(dl.error.message || "")) await s.from("docs").delete().eq("collection", "outbox").eq("id", row.id); continue; }
          await keepFile(d.folder || "Downloads", d.name || d.fileId, await toBytes(dl.data));
          await bucket().remove([d.fileId]);
          await s.from("docs").delete().eq("collection", "outbox").eq("id", row.id);
        }
        if (data.length) toast(`Copied ${data.length} file${data.length === 1 ? "" : "s"} from your phone or the web into ${cfg().localRoot}${cfg().driveOff ? "" : " and Google Drive"}.`);
      } while (outboxAgain);
    } catch (e) { console.error("Outbox", e); }
    outboxBusy = false;
  };
  async function checkUpdates(manual) {
    try {
      const u = await T.updater.check();
      if (!u) { if (manual) toast("Kinetic Studio is up to date."); return; }
      const b = document.createElement("div"); b.className = "ksn-banner";
      b.innerHTML = `<span>Kinetic Studio ${esc(u.version)} is ready</span><button type="button">Install and restart</button>`;
      document.body.appendChild(b);
      b.querySelector("button").addEventListener("click", async e => {
        e.target.disabled = true; e.target.textContent = "Installing…";
        try { await u.downloadAndInstall(); await T.process.relaunch(); } catch (er) { toast("The update didn’t install. Try again later."); e.target.disabled = false; e.target.textContent = "Install and restart"; }
      });
    } catch (e) { if (manual) toast("Couldn’t check for updates."); console.warn(e); }
  }
  async function importFromFolder(statusEl) {
    const dir = await T.dialog.open({directory: true, title: "Choose the Kinetic Studio export folder"});
    if (!dir) return;
    const s = await ensureAuth(), db = dbInst || (dbInst = makeDb(s));
    const say = m => { statusEl.textContent = m; };
    const manifest = JSON.parse(await fs.readTextFile(await path.join(dir, "export.json")));
    let n = 0;
    for (const [c, rows] of Object.entries(manifest.collections || {})) { say(`Importing ${c}…`); await db._bulkSet(c, rows); n += rows.length; }
    const files = manifest.assets || [];
    let done = 0, missing = 0;
    for (const a of files) {
      say(`Uploading files ${++done} of ${files.length}…`);
      try {
        const bytes = await fs.readFile(await path.join(dir, "files", a.file));
        const blob = new Blob([bytes], {type: a.type});
        await storagePut(a.id, blob, a.type);
        await localCachePut(a.id, blob, a.type);
      } catch (e) { console.error(e); missing++; }
    }
    say(`Imported ${n} records and ${files.length - missing} files${missing ? ` (${missing} files failed)` : ""}. Reloading…`);
    setTimeout(() => location.reload(), 1500);
  }
  mountSettings = async box => {
    const c = cfg(), drive = await detectDrive(), ver = await T.app.getVersion().catch(() => "");
    box.innerHTML = `<div class="ksn-set">
      <div class="f"><label>Files on this Mac</label><span class="hint">~/${esc(c.localRoot)} — every receipt, document and PDF, including ones added from your phone or the web (copied over whenever this app is open).</span></div>
      <div class="f"><label>Google Drive copy</label><span class="hint">${drive ? `<code>${esc(drive)}/${esc(c.driveFolder)}</code>` : "Google Drive for desktop wasn’t found. Install it and sign in, then reopen Studio."}</span>
        <label class="chk"><input type="checkbox" id="ksn-drive" ${c.driveOff ? "" : "checked"}><span>Copy every file to Google Drive</span></label>
        <label class="chk"><input type="checkbox" id="ksn-reveal" ${LS.get("revealSaves", true) ? "checked" : ""}><span>Show saved PDFs in Finder</span></label></div>
      ${c.webUrl ? `<div class="f"><label>On your phone</label><span class="hint">Open <code>${esc(c.webUrl)}</code> in Safari, then Share → Add to Home Screen.</span></div>` : ""}
      <div class="ksn-row"><button class="btn sm primary" type="button" id="ksn-save">Save app settings</button><button class="btn sm" type="button" id="ksn-folder">Open Kinetic Studio folder</button><button class="btn sm" type="button" id="ksn-upd">Check for updates</button></div>
      <div class="ksn-row"><button class="btn sm" type="button" id="ksn-import">Import from Claude export…</button><button class="btn sm ghost danger" type="button" id="ksn-out">Sign out</button></div>
      <span class="hint" id="ksn-status">Version ${esc(ver)} · signed in as ${esc(session && session.user ? session.user.email : "")}</span></div>`;
    box.addEventListener("click", async e => {
      const t = e.target;
      if (t.id === "ksn-save") { LS.set("driveOff", !box.querySelector("#ksn-drive").checked); LS.set("revealSaves", box.querySelector("#ksn-reveal").checked); toast("App settings saved"); }
      if (t.id === "ksn-folder") { await fs.mkdir(cfg().localRoot, {baseDir: BASE_HOME, recursive: true}).catch(() => {}); opener.openPath(await path.join(await path.homeDir(), cfg().localRoot)).catch(() => {}); }
      if (t.id === "ksn-upd") checkUpdates(true);
      if (t.id === "ksn-import") importFromFolder(box.querySelector("#ksn-status")).catch(er => { console.error(er); box.querySelector("#ksn-status").textContent = "Import failed: " + (er.message || er.code || er); });
      if (t.id === "ksn-out") await signOut();
    });
  };
  afterSignIn = () => { setTimeout(() => checkUpdates(false), 4000); onOutbox(); setInterval(onOutbox, 10 * 60 * 1000); };
}

/* ================= Web (phone, browser) ================= */
if (WEB) {
  const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
  let scope = new URL(".", location.href).href;
  const FILE_CACHE = "ks-files-v1";
  fileUrl = id => scope + "ksfile/" + id;
  const sessionPayload = () => ({type: "session", url: cfg().supabaseUrl, key: cfg().supabaseKey, token: session ? session.access_token : ""});
  window.postSessionToWorker = () => { if (sw && sw.controller) sw.controller.postMessage(sessionPayload()); };
  if (sw) {
    sw.register("sw.js").then(reg => { scope = reg.scope; }).catch(e => console.error("Service worker", e));
    sw.addEventListener("message", e => { if (e.data && e.data.type === "need-session" && e.ports[0]) e.ports[0].postMessage(sessionPayload()); });
    sw.addEventListener("controllerchange", () => window.postSessionToWorker());
    // The very first visit isn't controlled by the worker yet; reload once so stored files can load.
    if (!sw.controller) sw.ready.then(() => { try { if (!sessionStorage.getItem("ks.swr")) { sessionStorage.setItem("ks.swr", "1"); if (!LINK_TYPE) location.reload(); } } catch (e) {} });
  }
  localCachePut = async (id, blob, type) => { if (!window.caches) return; const c = await caches.open(FILE_CACHE); await c.put(new Request(scope + "ksfile-cache/" + id), new Response(blob, {headers: {"Content-Type": type}})); };
  localCacheDelete = async id => { if (window.caches) (await caches.open(FILE_CACHE)).delete(new Request(scope + "ksfile-cache/" + id)); };
  keepOriginal = async (file, kind) => queueForMac(FOLDER_OF_KIND[kind] || "Documents", `${todayISO()} ${file.name || "file"}`, file);
  const saveLocally = (blob, filename) => {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const canShareFile = f => !!(navigator.canShare && navigator.canShare({files: [f]}));
  downloads = {
    async save({filename, data}) {
      const blob = await toBlob(data, /\.pdf$/i.test(filename) ? "application/pdf" : /\.csv$/i.test(filename) ? "text/csv" : "");
      queueForMac(folderForExport(filename), filename, blob).catch(e => console.warn("Drive copy queue", e));
      if (!TOUCH) { saveLocally(blob, filename); return {saved: true}; }
      // Phones need a fresh tap to save or share a file.
      const file = new File([blob], filename, {type: blob.type});
      sheet(`<b>${esc(filename)}</b><p>Ready. A copy also goes to your Kinetic Studio folder and Google Drive next time the Mac app is open.</p>
        <div class="r">${canShareFile(file) ? `<button type="button" class="pri" data-share>Share…</button>` : ""}<button type="button" data-save ${canShareFile(file) ? "" : `class="pri"`}>Save to Files</button></div>`, el => {
        el.addEventListener("click", async e => {
          if (e.target.closest("[data-share]")) { try { await navigator.share({files: [file], title: filename}); el.remove(); } catch (er) {} }
          if (e.target.closest("[data-save]")) { saveLocally(blob, filename); el.remove(); }
        });
      });
      return {saved: true};
    }
  };
  mcp = {
    async callTool(server, tool, input) {
      if (server !== "Gmail" || tool !== "create_draft") throw {code: "server_not_connected", message: `${server} isn't available here`};
      const a = (input.attachments || [])[0];
      const file = a ? new File([Uint8Array.from(atob(a.content), ch => ch.charCodeAt(0))], a.filename || "attachment.pdf", {type: a.mimeType || "application/pdf"}) : null;
      if (file) queueForMac(folderForExport(file.name), file.name, file).catch(e => console.warn(e));
      if (!TOUCH) {
        if (file) saveLocally(file, file.name);
        return {payload: {note: file ? "The PDF downloaded. Open Gmail, then attach it from your Downloads folder." : "Open Gmail to finish the email.", linkUrl: gmailComposeUrl(input), linkText: "Open Gmail"}};
      }
      const to = (input.to || []).join(", ");
      sheet(`<b>Email ${esc(file ? file.name : "")}</b><p>Tap Share, choose Gmail, and the PDF is attached. Then add ${esc(to)} as the recipient.</p>
        <div class="r">${file && canShareFile(file) ? `<button type="button" class="pri" data-share>Share PDF to Gmail…</button>` : ""}<a href="${esc(gmailAppUrl(input))}">Open Gmail without the PDF</a></div>`, el => {
        el.addEventListener("click", async e => {
          if (e.target.closest("[data-share]")) { try { await navigator.share({files: [file], title: input.subject || "", text: input.body || ""}); el.remove(); } catch (er) {} }
        });
      });
      return {payload: {note: `Finish in Gmail: share the PDF, then add ${to}.`}};
    },
    async listTools() { return {servers: [{server: "Gmail", authStatus: "connected", tools: [{name: "create_draft"}]}]}; }
  };
  mountSettings = async box => {
    box.innerHTML = `<div class="ksn-set">
      <div class="f"><label>Files</label><span class="hint">Receipts and PDFs you add here are stored in Studio and copied to the Kinetic Studio folder and Google Drive the next time the Mac app is open.</span></div>
      ${TOUCH ? `<div class="f"><label>Use it like an app</label><span class="hint">In Safari, tap Share → Add to Home Screen.</span></div>` : ""}
      <div class="ksn-row"><button class="btn sm ghost danger" type="button" id="ksn-out">Sign out</button></div>
      <span class="hint">Version ${esc(BUILD.version || "")} · signed in as ${esc(session && session.user ? session.user.email : "")}</span></div>`;
    box.querySelector("#ksn-out").addEventListener("click", signOut);
  };
  afterSignIn = () => {};
}
function postSessionToWorker() { if (window.postSessionToWorker) window.postSessionToWorker(); }
function gmailComposeUrl(input) {
  const q = new URLSearchParams({view: "cm", fs: "1", to: (input.to || []).join(","), su: input.subject || "", body: input.body || ""});
  if (input.cc && input.cc.length) q.set("cc", input.cc.join(","));
  return "https://mail.google.com/mail/?" + q.toString();
}
function gmailAppUrl(input) {
  const q = new URLSearchParams({to: (input.to || []).join(","), subject: input.subject || "", body: input.body || ""});
  if (input.cc && input.cc.length) q.set("cc", input.cc.join(","));
  return "googlegmail:///co?" + q.toString();
}

/* ---------------- Claude, through the Supabase Edge Function "claude" ---------------- */
const MODEL = {quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5"};
async function blobToB64(b) { const bytes = await toBytes(b); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function makeSample() {
  async function call(input, opts = {}) {
    await ensureAuth();
    if (navigator.onLine === false) throw {code: "offline", message: "No connection"};
    const msgs = typeof input === "string" ? [{role: "user", content: input}] : input.map(m => ({role: m.role, content: m.content}));
    const imgs = opts.images ? (opts.images instanceof Blob ? [opts.images] : [...opts.images]) : [];
    if (imgs.length) {
      const last = msgs[msgs.length - 1], blocks = [];
      for (const b of imgs) blocks.push({type: "image", source: {type: "base64", media_type: b.type || "image/jpeg", data: await blobToB64(b)}});
      blocks.push({type: "text", text: last.content});
      last.content = blocks;
    }
    const {data} = await client().auth.getSession();
    let res;
    try {
      res = await fetch(cfg().supabaseUrl + "/functions/v1/claude", {method: "POST", signal: opts.signal,
        headers: {"content-type": "application/json", apikey: cfg().supabaseKey, authorization: "Bearer " + (data.session ? data.session.access_token : "")},
        body: JSON.stringify({model: opts.model || MODEL[opts.modelTier || "default"] || MODEL.default, max_tokens: 4096, messages: msgs})});
    } catch (e) { throw {code: opts.signal && opts.signal.aborted ? "cancelled" : isNetErr(e) ? "offline" : "upstream_error", message: String(e)}; }
    const j = await res.json().catch(() => ({}));
    const msg = (j.error && j.error.message) || res.statusText;
    if (res.status === 401 || res.status === 403) throw {code: "not_granted", message: msg};
    if (res.status === 503) throw {code: "not_granted", message: msg || "Claude reading isn’t set up yet."};
    if (res.status === 429) throw {code: "rate_limited", message: msg};
    if (!res.ok) throw {code: "upstream_error", message: msg};
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (!text) throw {code: "empty_completion", message: "No text"};
    if (opts.onText) opts.onText({text, delta: text});
    return {text, truncated: j.stop_reason === "max_tokens", modelTierApplied: opts.modelTier || "default"};
  }
  const sample = (input, opts) => call(input, opts);
  sample.json = async (input, opts) => {
    const r = await call(input, opts);
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(r.text);
    let t = fence ? fence[1] : r.text;
    const a = t.search(/[[{]/); if (a > 0) t = t.slice(a);
    const z = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]")); if (z >= 0) t = t.slice(0, z + 1);
    try { return JSON.parse(t); } catch (e) { throw {code: "invalid_json", message: "Reply wasn't JSON", text: r.text}; }
  };
  sample.limits = async () => ({maxPromptBytes: 262144, images: {maxCount: 4, maxInputBytes: 5 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"]}});
  return sample;
}

/* ---------------- the window.claude shim ---------------- */
let dbInst = null, assetsInst = null;
window.KS_NATIVE = {
  label: T ? "Mac app" : "This device",
  emailButton: T ? "Open in Gmail" : TOUCH ? "Email it" : "Open in Gmail",
  emailHint: T ? "Opens a filled-in Gmail message in your browser and shows the PDF in Finder to attach. Nothing is sent until you press Send."
    : TOUCH ? "Builds the PDF, then shares it to the Gmail app. Nothing is sent until you press Send."
    : "Downloads the PDF and opens a filled-in Gmail message. Nothing is sent until you press Send.",
  fileUrl: id => fileUrl(id),
  mountSettings: box => mountSettings(box),
  keepOriginal: (file, kind) => keepOriginal(file, kind)
};
window.claude = {
  async use(name) {
    if (name === "downloads") return downloads;
    if (name === "permissions") return {state: async () => "granted", request: async () => ({}), manage: async () => {}};
    if (name === "sample") return makeSample();
    if (name === "mcp") return mcp;
    const s = await ensureAuth();
    if (!dbInst) { watchAuth(s); await loadQueueState(); dbInst = makeDb(s); assetsInst = makeAssets(); afterSignIn(); flushSoon(1500); }
    if (name === "db") return dbInst;
    if (name === "assets") return assetsInst;
    if (name === "user") return {isOwner: () => true, canEdit: () => true, can: () => true, id: async () => session.user.id, me: async () => ({id: session.user.id, name: session.user.email})};
    return null;
  }
};
})();
