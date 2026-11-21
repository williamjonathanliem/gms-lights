(() => {
"use strict";
/* =====================================================================
   GMS Lighting Dashboard
   Controls MELK / ELK BLE LED controllers (LotusLamp X) over Web Bluetooth.
   Data: services, setlists, scenes and pattern names sync to Supabase,
   with a local cache so it keeps working offline.
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. PROTOCOL  (MELK-OA10 family, from the open-source elkbledom project)
   Service 0xFFF0, write characteristic 0xFFF3. Frames: 7E LEN CMD .. EF
   --------------------------------------------------------------------- */
const SERVICES = [{ svc: 0xfff0, chr: 0xfff3 }, { svc: 0xffe0, chr: 0xffe1 }];
const CMD = {
  login1: [0x7e, 0x07, 0x83], login2: [0x7e, 0x04, 0x04],
  on: () => [0x7e, 0x04, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef],
  off: () => [0x7e, 0x04, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef],
  color: (r, g, b) => [0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef],
  bright: (p) => [0x7e, 0x04, 0x01, p, 0x01, 0xff, 0xff, 0x00, 0xef],
  effect: (v) => [0x7e, 0x05, 0x03, v, 0x06, 0xff, 0xff, 0x00, 0xef],
  speed: (v) => [0x7e, 0x04, 0x02, v, 0xff, 0xff, 0xff, 0x00, 0xef],
  cct: (warm, cold) => [0x7e, 0x06, 0x05, 0x02, warm, cold, 0xff, 0x08, 0xef],
  micOn: () => [0x7e, 0x04, 0x07, 0x01, 0xff, 0xff, 0xff, 0x00, 0xef],
  micOff: () => [0x7e, 0x04, 0x07, 0x00, 0xff, 0xff, 0xff, 0x00, 0xef],
  micMode: (v) => [0x7e, 0x05, 0x03, v, 0x04, 0xff, 0xff, 0x00, 0xef],
  micSens: (v) => [0x7e, 0x04, 0x06, v, 0xff, 0xff, 0xff, 0x00, 0xef],
  clock: (h, m, s, dow) => [0x7e, 0x00, 0x83, h, m, s, dow, 0x00, 0xef],
  timer: (h, m, isOff, days) => [0x7e, 0x00, 0x82, h, m, 0x00, isOff ? 1 : 0, days, 0xef],
};

/* ---------------------------------------------------------------------
   2. PATTERN LIBRARY + PREVIEW STYLES
   --------------------------------------------------------------------- */
const RAINBOW = ["#FF0000", "#FF8000", "#FFFF00", "#00FF00", "#00FFFF", "#0000FF", "#FF00FF"];
const PALS = [RAINBOW, ["#FFFFFF", "#FF0000"], ["#FFFFFF", "#00FF00"], ["#FFFFFF", "#0000FF"], ["#FF0000"], ["#00FF00"], ["#0000FF"],
  ["#FFFF00"], ["#00FFFF"], ["#FF00FF"], ["#FF0000", "#00FF00"], ["#FF0000", "#0000FF"], ["#00FF00", "#0000FF"], ["#FFFFFF"], ["#FF0000", "#FFFF00"]];
const KINDS = {
  auto: "Auto (cycles)", rainbow: "Rainbow flow", wave: "Colour wave", flow: "Flow (moving blocks)", chase: "Chase (gaps)",
  tail: "Tail / comet", bounce: "Bounce", breathe: "Breathing", strobe: "Strobe", jump: "Jump", fade: "Crossfade",
  curtain: "Curtain", stack: "Stack / elevator", fire: "Fire", bars: "Bar flash", party: "Party sparkle", solid: "Solid",
};
// Confirmed for MELK-OA10
const CORE = [[0, "Auto play", "auto"], [1, "Magic back", "rainbow", -1], [2, "Effect 2", "flow"], [3, "Effect 3", "chase"], [4, "Effect 4", "tail"], [5, "Effect 5", "curtain"],
  [16, "Rainbow cycle", "rainbow"], [32, "Colour wave", "wave"], [48, "Breathing", "breathe"], [64, "Strobe", "strobe"], [128, "Jump RGB", "jump"], [144, "Fade RGB", "fade"], [207, "Blue scroll", "chase", 1, ["#0000FF", "#00FFFF"]]];
// RGBIC set used by sibling MELK-OA21 controllers (same command format; unverified on OA10)
const FAMILIES = [["Rainbow", 1, ["Rainbow up", "Rainbow down"], "rainbow"], ["Chase", 3, 8, "chase"], ["Chase pulse", 11, 12, "tail"], ["Chase flow", 23, 30, "flow"],
  ["Pulse flash", 53, 2, "strobe"], ["Curtain", 55, 6, "curtain"], ["Fire", 61, 13, "fire"], ["Fade", 74, 70, "fade"], ["Chase action", 144, 24, "bounce"],
  ["Elevator", 168, 14, "stack"], ["Bar flash", 182, 12, "bars"], ["Flash RGB", 194, 6, "jump"], ["Party", 200, ["Party flash", "Fade bottom"], "party"],
  ["Pulse", 202, 10, "breathe"], ["Fade", 212, 8, "fade", 71], ["Fade bar", 220, ["Fade bar"], "wave"]];
const FIRE = ["#FF2000", "#FF8000", "#FFC000"];

function buildPatterns() {
  const list = [];
  CORE.forEach(([code, name, kind, dir, cols]) => list.push({ code, name, group: "Core", kind, dir: dir || 1, colors: cols || (kind === "breathe" || kind === "strobe" || kind === "jump" || kind === "fade" ? RAINBOW : RAINBOW), verified: true }));
  FAMILIES.forEach(([fam, start, n, kind, numFrom]) => {
    const add = (code, name, i) => list.push({ code, name, group: fam === "Party" ? "Party" : fam, kind: name === "Fade bottom" ? "fade" : kind,
      dir: name === "Rainbow down" ? -1 : (i % 2 ? -1 : 1), colors: kind === "fire" ? FIRE : RAINBOW, verified: false });
    if (Array.isArray(n)) n.forEach((nm, i) => add(start + i, nm, i));
    else for (let i = 0; i < n; i++) { const num = (numFrom || 1) + i; add(start + i, num === 1 ? fam : `${fam} ${num}`, i); }
  });
  return list;
}
const PATTERNS = buildPatterns();
const MIC_MODES = [[0x80, "Energetic"], [0x81, "Rhythm"], [0x82, "Spectrum"], [0x83, "Rolling"], [0x84, "Mic 5"], [0x85, "Mic 6"], [0x86, "Mic 7"], [0x87, "Mic 8"]];

/* ---------------------------------------------------------------------
   3. HELPERS
   --------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex2 = (n) => n.toString(16).padStart(2, "0");
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rgbToHex = (r, g, b) => "#" + [r, g, b].map(hex2).join("").toUpperCase();
const hexToRgb = (h) => { h = String(h || "#000").replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0); };
function hsvToRgb(h, s, v) { s /= 100; v /= 100; const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); }; return [f(5), f(3), f(1)]; }
function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [Math.round(h), Math.round(mx ? (d / mx) * 100 : 0), Math.round(mx * 100)]; }
const kOf = (v) => Math.round((1800 + 5200 * v / 100) / 100) * 100;
const cctRgbOf = (v) => { const w = [255, 138, 18], c = [180, 220, 255], t = v / 100; return w.map((x, i) => Math.round(x + (c[i] - x) * t)); };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._t); t._t = setTimeout(() => (t.style.display = "none"), 3500); }
function log(msg, cls = "") { const l = $("log"); const d = document.createElement("div"); if (cls) d.className = cls;
  d.textContent = new Date().toLocaleTimeString() + "  " + msg; l.appendChild(d); if (l.children.length > 500) l.firstChild.remove(); l.scrollTop = l.scrollHeight; }

/* Modal helpers (prompt/confirm replacements that look native to the app) */
function modal(html, onMount) {
  return new Promise((resolve) => {
    $("sheet").innerHTML = html; $("modal").hidden = false;
    const close = (v) => { $("modal").hidden = true; $("sheet").innerHTML = ""; resolve(v); };
    $("modal").onclick = (e) => { if (e.target === $("modal")) close(null); };
    onMount && onMount(close);
  });
}
function ask(title, value = "", placeholder = "") {
  return modal(`<h2>${esc(title)}</h2><label><input type="text" id="mIn" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>
    <div class="acts"><button class="btn" id="mNo">Cancel</button><button class="btn inv" id="mOk">OK</button></div>`, (close) => {
    const i = $("mIn"); setTimeout(() => { i.focus(); i.select(); }, 50);
    $("mNo").onclick = () => close(null); $("mOk").onclick = () => close(i.value.trim() || null);
    i.onkeydown = (e) => { if (e.key === "Enter") $("mOk").click(); };
  });
}
function confirmBox(title, body = "", ok = "OK", danger = false) {
  return modal(`<h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ""}<div class="acts"><button class="btn" id="mNo">Cancel</button><button class="btn ${danger ? "danger" : "inv"}" id="mOk">${esc(ok)}</button></div>`,
    (close) => { $("mNo").onclick = () => close(false); $("mOk").onclick = () => close(true); });
}

/* ---------------------------------------------------------------------
   4. DATA: local cache + Supabase sync
   --------------------------------------------------------------------- */
const local = {
  get(k, d) { try { const v = localStorage.getItem("gms_" + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("gms_" + k, JSON.stringify(v)); } catch (e) {} },
};
const LOOK = (mode, o = {}) => Object.assign({ mode, color: "#FFFFFF", effect: 16, cct: 50, bright: 90, speed: 60, fade: 0, beat: "none", who: "sel" }, o);
const DEFAULT_SCENES = [
  { id: uid(), name: "Warm house", mode: "color", color: "#FFB066", bright: 75, speed: 50 },
  { id: uid(), name: "Worship blue", mode: "color", color: "#1E3CFF", bright: 65, speed: 50 },
  { id: uid(), name: "Deep purple", mode: "color", color: "#6000FF", bright: 70, speed: 50 },
  { id: uid(), name: "Neutral white", mode: "cct", cct: 50, bright: 90, speed: 50 },
  { id: uid(), name: "Rainbow drift", mode: "effect", effect: 16, bright: 85, speed: 30 },
  { id: uid(), name: "Slow breathe", mode: "effect", effect: 48, bright: 90, speed: 20 },
];
function sampleService() {
  return { id: uid(), name: "Sunday Service", service_date: new Date().toISOString().slice(0, 10), notes: "", updated_at: new Date().toISOString(), songs: [
    { id: uid(), name: "Opener (example)", note: "Fast", bpm: 128, arr: "I V PC C B C O", cues: [
      { name: "Intro", ...LOOK("color", { color: "#1E3CFF", bright: 40, fade: 2 }) },
      { name: "Verse", ...LOOK("color", { color: "#6000FF", bright: 60, fade: 1 }) },
      { name: "Pre-chorus", ...LOOK("color", { color: "#B000FF", bright: 75, beat: "bar" }) },
      { name: "Chorus", ...LOOK("color", { color: "#FF00C8", bright: 100, beat: "pulse" }) },
      { name: "Bridge", ...LOOK("effect", { effect: 144, bright: 80, speed: 40 }) },
      { name: "Final chorus", ...LOOK("effect", { effect: 128, bright: 100, speed: 85 }) },
      { name: "Outro", ...LOOK("color", { color: "#FFB066", bright: 35, fade: 4 }) }] },
    { id: uid(), name: "Worship (example)", note: "Slow", bpm: 68, arr: "I V C B E", cues: [
      { name: "Intro", ...LOOK("cct", { cct: 10, bright: 30, fade: 3 }) },
      { name: "Verse", ...LOOK("color", { color: "#FF8000", bright: 45, fade: 3 }) },
      { name: "Chorus", ...LOOK("color", { color: "#FFC800", bright: 70, fade: 2, beat: "bar" }) },
      { name: "Bridge", ...LOOK("effect", { effect: 48, bright: 70, speed: 20 }) },
      { name: "Ending", ...LOOK("color", { color: "#FFB066", bright: 20, fade: 5 }) }] }] };
}

const DB = {
  services: local.get("services", null) || [],
  lib: Object.assign({ scenes: DEFAULT_SCENES, patterns: {}, favs: [], aliases: {}, recent: [] }, local.get("lib", {})),
  dirty: new Set(local.get("dirty", [])),
  sb: null, code: "", version: "", online: false,
};
const cacheLocal = () => { local.set("services", DB.services); local.set("lib", DB.lib); local.set("dirty", [...DB.dirty]); };

function supaCfg() {
  const o = local.get("supa", {}); const c = window.GMS_CONFIG || {};
  return { url: o.url || c.supabaseUrl || "", key: o.key || c.supabaseAnonKey || "" };
}
function setSync(kind, text) { const s = $("syncState"); s.className = "sync " + kind; s.querySelector("span").textContent = text; s.title = text; }

/* Guest mode: one shared team passcode, checked by the database on every call */
const getCode = () => local.get("code", "");
const rpc = async (fn, args = {}) => {
  const { data, error } = await DB.sb.rpc(fn, { code: DB.code, ...args });
  if (error) { if (error.code === "28000" || /passcode/i.test(error.message)) { DB.code = ""; local.set("code", ""); setSync("err", "Locked"); } throw error; }
  return data;
};
const unlocked = () => !!(DB.sb && DB.code);

async function initCloud() {
  const { url, key } = supaCfg();
  if (!url || !key) { setSync("", "Local only"); return; }
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    DB.sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    DB.code = getCode();
    if (DB.code && !(await DB.sb.rpc("gms_check", { code: DB.code })).data) DB.code = "";
    if (!DB.code) { setSync("err", "Locked"); const ok = await passcodeSheet(); if (!ok) { setSync("", "Offline (this device)"); return; } }
    await cloudPull();
    startPolling(); startBridgeListener();
  } catch (e) {
    console.warn(e); setSync("err", "Offline (cached)"); log("Cloud unavailable: " + (e.message || e), "err");
  }
}

async function cloudPull() {
  setSync("busy", "Syncing…");
  await flushDirty();
  const d = await rpc("gms_pull");
  const svcs = d.services || [], lib = d.library || [];
  if (svcs.length) DB.services = svcs.map((r) => ({ ...r, songs: r.songs || [] }));
  else { for (const s of DB.services) await pushService(s); }   // first run: seed the database with this device's data
  if (lib.length) lib.forEach((r) => { DB.lib[r.key] = r.value; });
  else { for (const k of ["scenes", "patterns", "favs", "aliases"]) await pushLib(k); }
  DB.version = await rpc("gms_version").catch(() => "");
  DB.online = true; sortServices(); cacheLocal(); setSync("ok", "Saved online");
  renderAll(true);
}

async function pushService(s) {
  if (!unlocked()) { DB.dirty.add("svc:" + s.id); cacheLocal(); return; }
  try { await rpc("gms_save_service", { row_data: { id: s.id, name: s.name, service_date: s.service_date || "", notes: s.notes || "", songs: s.songs } }); }
  catch (e) { DB.dirty.add("svc:" + s.id); throw e; }
  DB.dirty.delete("svc:" + s.id);
}
async function pushLib(key) {
  if (!unlocked()) { DB.dirty.add("lib:" + key); cacheLocal(); return; }
  try { await rpc("gms_save_library", { lib_key: key, lib_value: DB.lib[key] ?? null }); }
  catch (e) { DB.dirty.add("lib:" + key); throw e; }
  DB.dirty.delete("lib:" + key);
}
async function deleteServiceRemote(id) {
  if (!unlocked()) { DB.dirty.add("svc:" + id); cacheLocal(); return; }
  try { await rpc("gms_delete_service", { service_id: id }); DB.dirty.delete("svc:" + id); } catch (e) { DB.dirty.add("svc:" + id); }
  cacheLocal();
}
async function flushDirty() {
  for (const d of [...DB.dirty]) {
    const [t, id] = d.split(/:(.+)/);
    try {
      if (t === "svc") { const s = DB.services.find((x) => x.id === id); if (s) await pushService(s); else await deleteServiceRemote(id); }
      else await pushLib(id);
    } catch (e) { console.warn("flush", e); }
  }
  cacheLocal();
}

const pending = new Set();
const flushSoon = debounce(async () => {
  const jobs = [...pending]; pending.clear();
  if (!unlocked()) { jobs.forEach((j) => DB.dirty.add(j)); cacheLocal(); return; }
  setSync("busy", "Saving…");
  try {
    for (const j of jobs) { const [t, id] = j.split(/:(.+)/); if (t === "svc") { const s = DB.services.find((x) => x.id === id); if (s) await pushService(s); } else await pushLib(id); }
    DB.version = await rpc("gms_version").catch(() => DB.version);
    cacheLocal(); setSync("ok", "Saved online");
  } catch (e) { cacheLocal(); setSync("err", "Not saved, will retry"); log("Save failed: " + (e.message || e), "err"); }
}, 700);
function saveService(s) { s.updated_at = new Date().toISOString(); cacheLocal(); pending.add("svc:" + s.id); flushSoon(); }
function saveLib(key) { cacheLocal(); pending.add("lib:" + key); flushSoon(); }

/* Pick up changes made on other devices (checks every 8 seconds) */
let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!unlocked() || document.hidden || pending.size || DB.dirty.size || editIdx >= 0 || !$("modal").hidden) return;
    try {
      const v = await rpc("gms_version");
      if (v && v !== DB.version) { await cloudPull(); toast("Updated from another device"); }
    } catch (e) { /* offline: try again next tick */ }
  }, 8000);
}
window.addEventListener("online", () => { if (unlocked()) cloudPull().catch(() => {}); });
window.addEventListener("offline", () => setSync("err", "Offline (cached)"));

function passcodeSheet() {
  return modal(`<div style="text-align:center"><img src="icons/logo.png" alt="" style="width:64px;height:64px;border-radius:14px;margin-bottom:10px"></div>
    <h2 style="text-align:center">GMS Lighting</h2><p style="text-align:center">Enter the team passcode to load and save services online.</p>
    <label>Passcode<input type="password" id="pcIn" autocomplete="current-password" autocapitalize="characters" style="text-align:center;font-size:20px;letter-spacing:4px"></label>
    <p id="pcErr" style="color:#ff8080;min-height:20px;margin:6px 0 0;text-align:center"></p>
    <div class="acts"><button class="btn" id="pcSkip">Use offline</button><button class="btn inv" id="pcGo">Unlock</button></div>`, (close) => {
    $("pcSkip").onclick = () => close(false);
    const go = async () => {
      const code = $("pcIn").value.trim().toUpperCase(); if (!code) return;
      $("pcGo").disabled = true; $("pcErr").textContent = "";
      const { data, error } = await DB.sb.rpc("gms_check", { code });
      $("pcGo").disabled = false;
      if (error) { $("pcErr").textContent = "Couldn't reach the database. Check your connection."; return; }
      if (!data) { $("pcErr").textContent = "Wrong passcode"; $("pcIn").select(); return; }
      DB.code = code; local.set("code", code); close(true);
    };
    $("pcGo").onclick = go; $("pcIn").onkeydown = (e) => { if (e.key === "Enter") go(); };
    setTimeout(() => $("pcIn").focus(), 50);
  });
}

function settingsSheet() {
  const c = supaCfg();
  modal(`<h2>Settings</h2>
    <p>${unlocked() ? `<b style="color:#fff">Unlocked</b>. Services and scenes save online for the whole team.` : DB.sb ? "Locked. Changes are only saved on this device." : "Running locally (no online database configured)."}</p>
    <div class="acts" style="justify-content:flex-start">
      ${DB.sb && !unlocked() ? `<button class="btn inv" id="stIn">Enter passcode</button>` : ""}
      ${unlocked() ? `<button class="btn" id="stSync">Sync now</button><button class="btn" id="stOut">Lock this device</button>` : ""}
      <button class="btn" id="stExport">Export backup</button>
      <label class="btn" style="margin:0;color:var(--text)">Import backup<input type="file" id="stImport" accept=".json" hidden></label>
    </div>
    ${integrationsHtml()}
    <details style="margin-top:12px"><summary class="hint" style="cursor:pointer">Database connection</summary>
      <label>Supabase URL<input type="url" id="stUrl" value="${esc(c.url)}" placeholder="https://xxxx.supabase.co"></label>
      <label>Publishable key<input type="text" id="stKey" value="${esc(c.key)}" placeholder="sb_publishable_…"></label>
      <div class="acts" style="justify-content:flex-start"><button class="btn sm" id="stSave">Save &amp; reload</button></div>
    </details>
    <div class="acts"><button class="btn inv" id="stClose">Close</button></div>`, (close) => {
    $("stClose").onclick = () => close();
    wireIntegrations();
    $("stSave").onclick = () => { local.set("supa", { url: $("stUrl").value.trim(), key: $("stKey").value.trim() }); location.reload(); };
    if ($("stIn")) $("stIn").onclick = async () => { close(); if (await passcodeSheet()) cloudPull().then(() => { startPolling(); startBridgeListener(); }).catch((e) => toast(e.message)); };
    if ($("stOut")) $("stOut").onclick = () => { DB.code = ""; local.set("code", ""); clearInterval(pollTimer); setSync("err", "Locked"); close(); toast("Locked. Changes now stay on this device."); };
    if ($("stSync")) $("stSync").onclick = () => { close(); cloudPull().catch((e) => { setSync("err", "Sync failed"); toast(e.message); }); };
    $("stExport").onclick = () => {
      const blob = new Blob([JSON.stringify({ type: "gms-lighting-backup", version: 1, services: DB.services, library: DB.lib }, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `gms-lighting-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href);
    };
    $("stImport").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const d = JSON.parse(await f.text()); if (!Array.isArray(d.services)) throw 0;
        d.services.forEach((s) => { const i = DB.services.findIndex((x) => x.id === s.id); if (i >= 0) DB.services[i] = s; else DB.services.push(s); saveService(s); });
        if (d.library) Object.keys(d.library).forEach((k) => { DB.lib[k] = d.library[k]; saveLib(k); });
        sortServices(); renderAll(); close(); toast(`Imported ${d.services.length} services`);
      } catch (err) { toast("That file isn't a GMS Lighting backup."); }
    };
  });
}
$("openSettings").onclick = settingsSheet;

/* ---------------------------------------------------------------------
   5. PREVIEW ENGINE: simulated addressable strip
   --------------------------------------------------------------------- */
const patMeta = (code) => DB.lib.patterns[code] || {};
const basePat = (code) => PATTERNS.find((p) => p.code === code);
function patInfo(code) {
  const b = basePat(code) || { code, name: `Pattern ${code}`, group: "Custom", kind: "chase", colors: RAINBOW, dir: 1, verified: false };
  const m = patMeta(code);
  return { ...b, name: m.name || b.name, kind: m.kind || b.kind, colors: m.colors?.length ? m.colors : b.colors, edited: !!(m.name || m.kind) };
}
const patLabel = (code) => patInfo(code).name;

const fract = (x) => x - Math.floor(x);
const noise = (i, t) => (Math.sin(i * 12.9898 + t * 78.233) * 43758.5453) % 1;
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/** Returns an array of [r,g,b] (0-255) for N LEDs at time t (seconds). */
function renderLeds(look, N, t) {
  const out = new Array(N);
  if (!look || look.off) { for (let i = 0; i < N; i++) out[i] = [0, 0, 0]; return out; }
  if (look.mode === "color" || look.mode === "cct") {
    const c = look.mode === "cct" ? cctRgbOf(look.cct) : hexToRgb(look.color);
    for (let i = 0; i < N; i++) out[i] = c; return out;
  }
  const info = look.info || patInfo(look.effect);
  let kind = info.kind, P = info.colors.map(hexToRgb), dir = info.dir || 1;
  const sp = 0.35 + (look.speed ?? 60) / 100 * 1.9; t *= sp;
  if (kind === "auto") { const ks = ["rainbow", "flow", "tail", "breathe", "curtain", "jump"]; kind = ks[Math.floor(t / 3) % ks.length]; P = RAINBOW.map(hexToRgb); }
  const C = (k) => P[((k % P.length) + P.length) % P.length];
  const L = P.length;
  for (let i = 0; i < N; i++) {
    const x = i / N; let c = [0, 0, 0];
    switch (kind) {
      case "rainbow": { const [r, g, b] = hsvToRgb(((x * 360 - t * 120 * dir) % 360 + 360) % 360, 100, 100); c = [r, g, b]; break; }
      case "wave": { const f = fract(x * 1.2 - t * 0.25 * dir) * L, k = Math.floor(f); c = mix(C(k), C(k + 1), f - k); break; }
      case "flow": { const seg = Math.max(3, Math.round(N / (L * 2))); c = C(Math.floor((i - t * 8 * dir) / seg)); break; }
      case "chase": { const seg = 3, k = Math.floor((i - t * 10 * dir) / seg); c = ((k % 2) + 2) % 2 === 0 ? C(Math.floor(k / 2)) : [0, 0, 0]; break; }
      case "tail": { const lap = t * 0.5, head = fract(lap) * (N + 10); const d = dir > 0 ? head - i : head - (N - 1 - i);
        c = d >= 0 && d < 10 ? C(Math.floor(lap)).map((v) => v * Math.pow(1 - d / 10, 1.6)) : [0, 0, 0]; break; }
      case "bounce": { const ph = fract(t * 0.4), pos = (ph < 0.5 ? ph * 2 : 2 - ph * 2) * (N - 1), d = Math.abs(i - pos);
        c = d < 5 ? C(Math.floor(t * 0.4)).map((v) => v * (1 - d / 5)) : [0, 0, 0]; break; }
      case "breathe": { const k = Math.floor(t * 0.35), a = Math.pow(Math.sin(fract(t * 0.35) * Math.PI), 2); c = C(k).map((v) => v * a); break; }
      case "strobe": { const on = fract(t * 4) < 0.35; c = on ? C(Math.floor(t * 4)) : [0, 0, 0]; break; }
      case "jump": c = C(Math.floor(t * 1.5)); break;
      case "fade": { const f = t * 0.4, k = Math.floor(f); c = mix(C(k), C(k + 1), (1 - Math.cos((f - k) * Math.PI)) / 2); break; }
      case "curtain": { const ph = fract(t * 0.35), k = Math.floor(t * 0.35), half = N / 2, d = Math.abs(i + 0.5 - half) / half;
        const fill = ph < 0.6 ? ph / 0.6 : 1; const lit = (1 - d) <= fill * 1.0 + 0.001 ? (ph < 0.85 ? 1 : 1 - (ph - 0.85) / 0.15) : 0;
        c = C(k).map((v) => v * lit); break; }
      case "stack": { const ph = fract(t * 0.3), k = Math.floor(t * 0.3), level = Math.floor(ph * 1.15 * N);
        const ii = dir > 0 ? i : N - 1 - i; c = ii < level ? C(k + Math.floor(ii / Math.max(2, N / L))) : [0, 0, 0]; break; }
      case "fire": { const n = Math.abs(noise(i, Math.floor(t * 12))), fl = 0.55 + 0.45 * n; c = mix(P[0], P[Math.min(2, L - 1)], n).map((v) => v * fl); break; }
      case "bars": { const k = Math.floor(t * 3), grp = Math.floor(i / 4); c = (grp + k) % 2 === 0 ? C(k) : [0, 0, 0]; break; }
      case "party": { const n = Math.abs(noise(i, Math.floor(t * 7))); c = n > 0.55 ? hsvToRgb(Math.floor(n * 997) % 360, 100, 100) : [0, 0, 0]; break; }
      default: c = C(0);
    }
    out[i] = c;
  }
  return out;
}
function drawStrip(cv, look, t) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const N = Math.max(12, Math.min(48, Math.floor(w / 11)));
  const leds = renderLeds(look, N, t);
  const br = look && look.bright != null ? clamp(look.bright, 5, 100) / 100 : 1;
  const step = w / N, r = Math.min(step * 0.32, h * 0.3), cy = h / 2;
  for (let i = 0; i < N; i++) {
    const [R, G, B] = leds[i], x = step * (i + 0.5);
    const lum = Math.max(R, G, B) / 255 * br;
    g.fillStyle = "#1a1a1a"; g.beginPath(); g.arc(x, cy, r, 0, 6.283); g.fill();
    if (lum < 0.02) continue;
    const col = `rgb(${Math.round(R * br)},${Math.round(G * br)},${Math.round(B * br)})`;
    g.globalAlpha = 0.28 * lum; g.fillStyle = col; g.beginPath(); g.arc(x, cy, r * 2.3, 0, 6.283); g.fill();
    g.globalAlpha = 1; g.beginPath(); g.arc(x, cy, r, 0, 6.283); g.fill();
  }
  g.globalAlpha = 1;
}
/* Slide-style thumbnail: stage wash + LED strip, like a ProPresenter slide preview */
function drawThumb(cv, look, t) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
  const N = 22, leds = renderLeds(look, N, t);
  const br = look && look.bright != null ? clamp(look.bright, 5, 100) / 100 : 1;
  // Three washes/beams, each lit by the LEDs under it, so multi-colour patterns read correctly
  [0.17, 0.5, 0.83].forEach((fx) => {
    const seg = leds.slice(Math.floor((fx - 0.17) * N), Math.max(Math.floor((fx - 0.17) * N) + 1, Math.floor((fx + 0.17) * N)));
    let r = 0, gg = 0, b = 0, mx = 0; seg.forEach(([R, G, B]) => { const m = Math.max(R, G, B); if (m >= mx * 0.6) { r += R; gg += G; b += B; mx = Math.max(mx, m); } });
    const n = seg.filter(([R, G, B]) => Math.max(R, G, B) >= mx * 0.6).length || 1;
    r = r / n * br; gg = gg / n * br; b = b / n * br; const lum = Math.max(r, gg, b) / 255; if (lum < 0.02) return;
    const x = w * fx;
    const grad = g.createRadialGradient(x, h, 2, x, h * 0.75, w * 0.42);
    grad.addColorStop(0, `rgba(${r | 0},${gg | 0},${b | 0},${0.8 * lum})`); grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const bg = g.createLinearGradient(0, h, 0, 0);
    bg.addColorStop(0, `rgba(${r | 0},${gg | 0},${b | 0},${0.3 * lum})`); bg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = bg; g.beginPath(); g.moveTo(x - 8, h); g.lineTo(x + 8, h); g.lineTo(x + w * 0.09, 0); g.lineTo(x - w * 0.09, 0); g.closePath(); g.fill();
  });
  // LED strip along the bottom
  const step = w / N, r = Math.min(step * 0.3, 5), cy = h - 14;
  for (let i = 0; i < N; i++) {
    const [R, G, B] = leds[i], x = step * (i + 0.5), l = Math.max(R, G, B) / 255 * br;
    g.globalAlpha = 1; g.fillStyle = "#1c1c1c"; g.beginPath(); g.arc(x, cy, r, 0, 6.283); g.fill();
    if (l < 0.02) continue;
    const col = `rgb(${Math.round(R * br)},${Math.round(G * br)},${Math.round(B * br)})`;
    g.globalAlpha = 0.35 * l; g.fillStyle = col; g.beginPath(); g.arc(x, cy, r * 2.6, 0, 6.283); g.fill();
    g.globalAlpha = 1; g.beginPath(); g.arc(x, cy, r, 0, 6.283); g.fill();
  }
  g.globalAlpha = 1;
  if (look && look.off) { g.fillStyle = "#555"; g.font = "600 12px system-ui"; g.textAlign = "center"; g.fillText("OFF", w / 2, h / 2); }
}
// One animation loop for every strip on screen
const strips = new Map(); // canvas -> () => look
const visible = new Set();
const io = new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target))));
function bindStrip(cv, getLook) { strips.set(cv, getLook); io.observe(cv); }
function sweepStrips() { for (const cv of strips.keys()) if (!cv.isConnected) { strips.delete(cv); visible.delete(cv); io.unobserve(cv); } }
let lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 33 || document.hidden) return; lastFrame = now;
  const t = now / 1000;
  for (const cv of visible) { const f = strips.get(cv); if (f) (cv.classList.contains("thumb") ? drawThumb : drawStrip)(cv, f(), t); }
}
requestAnimationFrame(frame);

/* ---------------------------------------------------------------------
   6. LIGHT (one BLE controller)
   --------------------------------------------------------------------- */
class Light {
  constructor(device) {
    this.device = device; this.id = device.id; this.name = device.name || "Unnamed";
    this.char = null; this.queue = Promise.resolve(); this.pending = {}; this.status = "idle"; this.statusText = "";
    this.state = { on: true, mode: "color", color: "#FFFFFF", bright: 100, speed: 80, effect: null, cct: 50 };
    device.addEventListener("gattserverdisconnected", () => this.onDisconnect());
  }
  get label() { return DB.lib.aliases[this.name] || this.name; }
  look() {
    const s = this.state; if (!s.on) return { off: true };
    if (this._shown) return { mode: "color", color: rgbToHex(...this._shown), bright: 100 };
    if (s.mode === "mic") return { mode: "effect", info: { kind: "party", colors: RAINBOW, dir: 1 }, bright: s.bright, speed: 70 };
    return { mode: s.mode, color: s.color, effect: s.effect, cct: s.cct, bright: s.bright, speed: s.speed };
  }
  async connect() {
    this.removed = false; this.setStatus("busy", "Connecting…");
    const server = await this.device.gatt.connect();
    let ch = null;
    for (const s of SERVICES) { try { ch = await (await server.getPrimaryService(s.svc)).getCharacteristic(s.chr); break; } catch (e) {} }
    if (!ch) throw new Error("No control characteristic (FFF3/FFE1) found");
    this.char = ch;
    if (/^(melk|modelx)/i.test(this.name)) {
      this.setStatus("busy", "Handshake…");
      await this.raw(CMD.login1); await sleep(500);
      await this.raw(CMD.login2); await sleep(500);
    }
    this.setStatus("ok", "Connected"); log(`${this.label}: connected`, "ok");
    this.restore();
  }
  async raw(bytes) {
    const data = new Uint8Array(bytes);
    if ($("logTx").checked) log(`→ ${this.label}: ${[...data].map(hex2).join(" ")}`, "tx");
    if (this.char.writeValueWithoutResponse) await this.char.writeValueWithoutResponse(data);
    else await this.char.writeValue(data);
  }
  send(bytes) {
    if (!this.char) return Promise.resolve();
    this.queue = this.queue.then(() => this.raw(bytes)).catch((e) => log(`${this.label}: write failed: ${e.message}`, "err"));
    return this.queue;
  }
  latest(key, bytes, ms = 50) {
    const first = !(key in this.pending); this.pending[key] = bytes;
    if (first) setTimeout(() => { const b = this.pending[key]; delete this.pending[key]; if (b) this.send(b); }, ms);
  }
  ensureOn() { if (!this.state.on) { this.state.on = true; this.send(CMD.on()); } }
  /** Clear anything left over from the previous mode before a new look:
      controller mic mode, brightness baked into RGB by fades/beats/audio/FX. */
  prep() {
    if (this.state.mode === "mic") { this.send(CMD.micOff()); this.state.mode = "color"; }
    if (this._baked) { this._baked = false; this.send(CMD.bright(this.state.bright)); }
    this._shown = null; delete this.pending.color;
  }
  /** Live output used by fades, beat pulses, audio and FX: brightness is baked into the RGB. */
  showRgb(rgb, throttle) {
    if (!this.state.on) { this.state.on = true; this.send(CMD.on()); }
    if (this.state.mode === "mic") { this.send(CMD.micOff()); this.state.mode = "color"; }
    if (!this._baked) { this._baked = true; this.send(CMD.bright(100)); }
    this._shown = rgb;
    if (throttle) this.latest("color", CMD.color(...rgb), 35); else this.send(CMD.color(...rgb));
  }
  power(on) { this.state.on = on; this._shown = null; this._baked = false; this.send(on ? CMD.on() : CMD.off()); if (on) this.send(CMD.bright(this.state.bright)); }
  color(hex) { this.prep(); this.state.mode = "color"; this.state.color = hex; this.state.effect = null; this.ensureOn(); this.latest("color", CMD.color(...hexToRgb(hex)), 40); }
  bright(p) {
    this.state.bright = p;
    if (this._baked) { this._baked = false; this._shown = null; if (this.state.mode === "color") this.send(CMD.color(...hexToRgb(this.state.color))); }
    this.latest("bright", CMD.bright(p));
  }
  speed(v) { this.state.speed = v; this.latest("speed", CMD.speed(v)); }
  effect(code) { this.prep(); this.state.mode = "effect"; this.state.effect = code; this.ensureOn(); this.send(CMD.effect(code)); this.send(CMD.speed(this.state.speed)); }
  cct(v, rgbMix) {
    this.prep(); this.state.mode = "cct"; this.state.cct = v; this.state.effect = null; this.ensureOn();
    if (rgbMix) this.latest("color", CMD.color(...cctRgbOf(v))); else this.latest("cct", CMD.cct(100 - v, v));
  }
  restore() {
    const s = this.state; this._baked = false; this._shown = null; delete this.pending.color;
    this.send(s.on ? CMD.on() : CMD.off()); if (!s.on) return;
    if (s.mode === "effect" && s.effect != null) { this.send(CMD.effect(s.effect)); this.send(CMD.speed(s.speed)); }
    else if (s.mode === "cct") this.send(CMD.cct(100 - s.cct, s.cct));
    else this.send(CMD.color(...hexToRgb(s.color)));
    this.send(CMD.bright(s.bright));
  }
  async onDisconnect() {
    this.char = null; if (this.removed) return;
    this.setStatus("bad", "Reconnecting…"); log(`${this.label}: disconnected`, "err");
    for (let i = 0; i < 6 && !this.removed; i++) { await sleep(1200 * (i + 1)); try { await this.connect(); return; } catch (e) {} }
    this.setStatus("bad", "Disconnected");
  }
  setStatus(k, t) { this.status = k; this.statusText = t; renderLights(); }
  disconnect() { this.removed = true; try { this.device.gatt.disconnect(); } catch (e) {} }
}

/* ---------------------------------------------------------------------
   7. LIGHTS PANE + TARGETING
   --------------------------------------------------------------------- */
const lights = []; const selected = new Set();
const targets = () => lights.filter((l) => selected.has(l.id) && l.char);
function each(fn) {
  if (!lights.length) { toast("Connect a light first."); return false; }
  const t = targets(); if (!t.length) { toast("Select at least one connected light."); return false; }
  t.forEach(fn); updateLightRows(); return true;
}
function renderLights() {
  const box = $("lightList"); [...box.querySelectorAll(".light")].forEach((e) => e.remove());
  $("emptyLights").style.display = lights.length ? "none" : "";
  lights.forEach((l) => {
    const el = document.createElement("div"); el.className = "light" + (selected.has(l.id) ? " sel" : ""); el.dataset.id = l.id;
    el.innerHTML = `<div class="l1"><span class="ck">${selected.has(l.id) ? "✓" : ""}</span><span class="nm">${esc(l.label)}</span>
        <button class="btn sm pw" data-a="pw">${l.state.on ? "On" : "Off"}</button></div>
      <canvas class="strip"></canvas>
      <input type="range" class="lbr" min="1" max="100" value="${l.state.bright}" aria-label="Brightness for ${esc(l.label)}">
      <div class="l3"><span class="dot ${l.status}"></span><span class="st">${esc(l.statusText || l.status)}</span>
        <button class="btn sm" data-a="rn" aria-label="Rename">Rename</button><button class="btn sm" data-a="id" aria-label="Identify">Flash</button><button class="btn sm" data-a="rm" aria-label="Remove">✕</button></div>`;
    if (l.state.on) el.querySelector(".pw").classList.add("on");
    bindStrip(el.querySelector("canvas"), () => l.look());
    const lbr = el.querySelector(".lbr");
    lbr.onclick = (e) => e.stopPropagation(); lbr.onpointerdown = (e) => e.stopPropagation();
    lbr.oninput = (e) => { e.stopPropagation(); l.bright(+e.target.value); };
    el.onclick = async (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "pw") { l.power(!l.state.on); renderLights(); return; }
      if (a === "rn") { const n = await ask("Name this light", l.label, "e.g. Stage left"); if (n) { DB.lib.aliases[l.name] = n; saveLib("aliases"); renderLights(); } return; }
      if (a === "id") { identify(l); return; }
      if (a === "rm") { l.disconnect(); lights.splice(lights.indexOf(l), 1); selected.delete(l.id); renderLights(); return; }
      selected.has(l.id) ? selected.delete(l.id) : selected.add(l.id); renderLights();
    };
    box.appendChild(el);
  });
  sweepStrips(); updateTargetInfo();
}
function updateLightRows() {
  lights.forEach((l) => { const el = document.querySelector(`.light[data-id="${CSS.escape(l.id)}"] .pw`); if (el) { el.textContent = l.state.on ? "On" : "Off"; el.classList.toggle("on", l.state.on); } });
}
function updateTargetInfo() { const n = lights.filter((l) => l.char).length; $("targetInfo").textContent = lights.length ? `${targets().length} of ${n} selected` : "None connected"; }
async function identify(l) { if (!l.char) return; for (let i = 0; i < 3; i++) { l.send(CMD.color(255, 255, 255)); await sleep(250); l.send(CMD.color(0, 0, 0)); await sleep(250); } l.restore(); }

function bluetoothProblem() {
  if (location.protocol === "file:") return "<b>Opened as a file.</b> Bluetooth needs the app served over https:// or localhost. Use the online link, or run <code>npx serve</code> in the folder and open the localhost address.";
  if (!window.isSecureContext) return "<b>Not a secure page.</b> Bluetooth only works over https:// (or localhost).";
  if (!navigator.bluetooth) {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return "<b>iPhone/iPad can't use Web Bluetooth.</b> Use an Android phone or a laptop with Chrome.";
    if (/Firefox/.test(ua)) return "<b>Firefox doesn't support Web Bluetooth.</b> Open this in Chrome or Edge.";
    if (/SamsungBrowser/.test(ua)) return "<b>Samsung Internet doesn't support this.</b> Open the link in Chrome.";
    return "<b>This browser has no Web Bluetooth.</b> Use Chrome (Android, Windows, Mac) or Edge.";
  }
  return null;
}
function showBtWarn(html) { const w = $("btWarn"); if (html) { w.innerHTML = html; w.hidden = false; } else w.hidden = true; }

async function addLight(showAll) {
  const problem = bluetoothProblem();
  if (problem) { showBtWarn(problem); toast(problem.replace(/<[^>]+>/g, "")); log(problem.replace(/<[^>]+>/g, ""), "err"); return; }
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
      const msg = "Bluetooth is off or this device has no Bluetooth adapter. Turn Bluetooth on and try again.";
      showBtWarn("<b>Bluetooth is off.</b> Turn it on in your device settings. On Android, also turn on Location.");
      toast(msg); log(msg, "err"); return;
    }
  } catch (e) { /* getAvailability unsupported: carry on */ }
  showBtWarn(null);
  let device;
  try {
    log(showAll ? "Opening device picker (all devices)…" : "Opening device picker…");
    device = await navigator.bluetooth.requestDevice(showAll
      ? { acceptAllDevices: true, optionalServices: [0xfff0, 0xffe0] }
      : { filters: [{ namePrefix: "MELK" }, { namePrefix: "ELK" }, { namePrefix: "MODELX" }, { namePrefix: "LEDBLE" }, { namePrefix: "BEAM" }],
          optionalServices: [0xfff0, 0xffe0] });
  } catch (e) {
    if (e.name === "NotFoundError" && /cancel/i.test(e.message)) { log("Picker closed"); return; }
    let msg = `${e.name}: ${e.message}`;
    if (e.name === "SecurityError") msg = "Chrome blocked Bluetooth here. Make sure the page is https:// and not inside an embedded frame.";
    if (e.name === "NotFoundError" && /adapter|bluetooth/i.test(e.message)) msg = "No Bluetooth adapter available. Turn Bluetooth on (and Location on Android).";
    if (e.name === "NotAllowedError") msg = "Bluetooth permission was denied. Allow it in Chrome site settings (padlock icon → Permissions).";
    toast(msg); log("Connect failed: " + msg, "err"); showBtWarn("<b>Couldn't open the picker.</b> " + esc(msg)); return;
  }
  if (lights.some((l) => l.id === device.id)) { toast(`${device.name} is already connected.`); return; }
  const l = new Light(device); lights.push(l); selected.add(l.id); renderLights();
  try { await l.connect(); }
  catch (e) {
    l.setStatus("bad", "Failed: " + e.message); log(`${l.label}: ${e.name}: ${e.message}`, "err");
    toast("Couldn't connect. Close LotusLamp X on every phone (it holds the connection), then tap Reconnect.");
  }
}
$("addBtn").onclick = () => addLight(false);
$("scanAll").onclick = (e) => { e.stopPropagation(); addLight(true); };
$("selAll").onclick = () => { lights.forEach((l) => selected.add(l.id)); renderLights(); };
$("selNone").onclick = () => { selected.clear(); renderLights(); };
$("selInvert").onclick = () => { lights.forEach((l) => (selected.has(l.id) ? selected.delete(l.id) : selected.add(l.id))); renderLights(); };
$("reconnectAll").onclick = async () => { for (const l of lights) if (!l.char) { try { await l.connect(); } catch (e) { l.setStatus("bad", "Failed: " + e.message); } } };

/* Header controls */
$("pwrOn").onclick = () => each((l) => l.power(true));
$("pwrOff").onclick = () => { takeOver(); each((l) => l.power(false)); };
$("blackout").onclick = () => { takeOver(); lights.filter((l) => l.char).forEach((l) => l.power(false)); updateLightRows(); $("liveCue").textContent = "Blackout"; };
$("gBright").oninput = (e) => { $("gBrightV").textContent = e.target.value; each((l) => l.bright(+e.target.value)); };
$("gSpeed").oninput = (e) => { $("gSpeedV").textContent = e.target.value; each((l) => l.speed(+e.target.value)); };

/* Tabs */
$("tabs").onclick = (e) => {
  const v = e.target.dataset.v; if (!v) return;
  [...$("tabs").children].forEach((b) => b.classList.toggle("on", b === e.target));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
  if (v === "patterns") renderPatterns();
  if (v === "colour") drawWheel();
};

/* ---------------------------------------------------------------------
   8. COLOUR
   --------------------------------------------------------------------- */
let cur = { h: 0, s: 0, v: 100, hex: "#FFFFFF" };
const wheel = $("wheel"), wctx = wheel.getContext("2d");
let wheelImg = null, wheelImgV = -1;
function drawWheel() {
  const W = wheel.width, R = W / 2;
  if (wheelImgV !== cur.v) {
    wheelImg = wctx.createImageData(W, W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const dx = x - R, dy = y - R, d = Math.sqrt(dx * dx + dy * dy), i = (y * W + x) * 4;
      if (d > R) continue;
      const [r, g, b] = hsvToRgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d / R * 100, cur.v);
      wheelImg.data[i] = r; wheelImg.data[i + 1] = g; wheelImg.data[i + 2] = b; wheelImg.data[i + 3] = d > R - 1.5 ? (R - d) * 170 : 255;
    }
    wheelImgV = cur.v;
  }
  wctx.putImageData(wheelImg, 0, 0);
  const a = cur.h * Math.PI / 180, rr = cur.s / 100 * R, px = R + Math.cos(a) * rr, py = R + Math.sin(a) * rr;
  wctx.lineWidth = 5; wctx.strokeStyle = "#000"; wctx.beginPath(); wctx.arc(px, py, 15, 0, 7); wctx.stroke();
  wctx.lineWidth = 3; wctx.strokeStyle = "#fff"; wctx.beginPath(); wctx.arc(px, py, 15, 0, 7); wctx.stroke();
}
function setColour(src, push = true) {
  if (src.hex) { [cur.h, cur.s, cur.v] = rgbToHsv(...hexToRgb(src.hex)); cur.hex = src.hex.toUpperCase(); }
  else { Object.assign(cur, src); cur.hex = rgbToHex(...hsvToRgb(cur.h, cur.s, cur.v)); }
  const [R, G, B] = hexToRgb(cur.hex);
  $("hue").value = cur.h; $("hueV").textContent = cur.h + "°"; $("sat").value = cur.s; $("satV").textContent = cur.s; $("val").value = cur.v; $("valV").textContent = cur.v;
  [["cr", R], ["cg", G], ["cb", B]].forEach(([k, v]) => { $(k).value = v; $(k + "n").value = v; });
  if (document.activeElement !== $("hex")) $("hex").value = cur.hex;
  $("preview").style.background = cur.hex; $("preview").querySelector("span").textContent = cur.hex;
  drawWheel();
  $("liveColor").value = cur.hex; $("liveColorBtn").style.setProperty("--c", cur.hex);
  if (!push) return;
  if (audioUsesLive()) return;            // audio is following the mic in this colour: just recolour it
  if (chase) { chase.colorChanged = true; return; }
  takeOver();
  const secs = transitionSecs();
  if (secs > 0 && !dragging) crossfade(targets(), cur.hex, secs); else each((l) => l.color(cur.hex));
}
function commitRecent() { DB.lib.recent = [cur.hex, ...(DB.lib.recent || []).filter((c) => c !== cur.hex)].slice(0, 8); cacheLocal(); swatchGrid($("recent"), DB.lib.recent); }
function wheelPick(e) {
  const r = wheel.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 2 - 1, y = (e.clientY - r.top) / r.height * 2 - 1;
  setColour({ h: Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360), s: Math.round(Math.min(1, Math.hypot(x, y)) * 100), v: cur.v });
}
let dragging = false;
wheel.onpointerdown = (e) => { dragging = true; wheel.setPointerCapture(e.pointerId); wheelPick(e); };
wheel.onpointermove = (e) => { if (dragging) wheelPick(e); };
wheel.onpointerup = wheel.onpointercancel = () => { if (dragging) commitRecent(); dragging = false; };
["hue", "sat", "val"].forEach((k) => { $(k).oninput = () => setColour({ h: +$("hue").value, s: +$("sat").value, v: +$("val").value }); $(k).onchange = commitRecent; });
["cr", "cg", "cb"].forEach((k) => {
  const upd = (v) => { $(k).value = v; $(k + "n").value = v; setColour({ hex: rgbToHex(+$("cr").value, +$("cg").value, +$("cb").value) }); };
  $(k).oninput = (e) => upd(+e.target.value); $(k).onchange = commitRecent;
  $(k + "n").onchange = (e) => { upd(clamp(+e.target.value || 0, 0, 255)); commitRecent(); };
});
$("hex").onchange = (e) => { let v = e.target.value.trim(); if (!v.startsWith("#")) v = "#" + v;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { setColour({ hex: rgbToHex(...hexToRgb(v)) }); commitRecent(); } else toast("Use a hex like #FF8800"); };
const SW = ["#FFFFFF", "#FFB066", "#FF0000", "#FF4000", "#FF8000", "#FFC800", "#FFFF00", "#80FF00", "#00FF00", "#00FF80", "#00FFFF", "#0080FF", "#0000FF", "#6000FF", "#B000FF", "#FF00C8"];
function swatchGrid(el, list) { el.innerHTML = ""; list.forEach((c) => { const d = document.createElement("button"); d.className = "swatch"; d.style.background = c; d.setAttribute("aria-label", c);
  d.onclick = () => { setColour({ hex: c }); commitRecent(); }; el.appendChild(d); }); }

/* ---------------------------------------------------------------------
   9. WHITE
   --------------------------------------------------------------------- */
let cctRgb = false;
function setCct(v) { $("cct").value = v; $("cctV").textContent = kOf(v) + "K"; takeOver(); each((l) => l.cct(v, cctRgb)); }
$("cct").oninput = (e) => setCct(+e.target.value);
document.querySelectorAll("#v-white [data-k]").forEach((b) => (b.onclick = () => setCct(+b.dataset.k)));
$("cctNative").onclick = () => { cctRgb = false; $("cctNative").classList.add("on"); $("cctRgb").classList.remove("on"); };
$("cctRgb").onclick = () => { cctRgb = true; $("cctRgb").classList.add("on"); $("cctNative").classList.remove("on"); };

/* ---------------------------------------------------------------------
   10. PATTERNS + LAB
   --------------------------------------------------------------------- */
let pGroup = "All";
const GROUPS = () => ["All", "Favourites", "My names", "Core", ...new Set(PATTERNS.filter((p) => p.group !== "Core").map((p) => p.group))];
const speedNow = () => +$("gSpeed").value;
function renderPatterns() {
  const chips = $("pChips"); chips.innerHTML = "";
  GROUPS().forEach((g) => { const b = document.createElement("button"); b.className = "btn sm" + (g === pGroup ? " on" : ""); b.textContent = g; b.onclick = () => { pGroup = g; renderPatterns(); }; chips.appendChild(b); });
  const q = $("pSearch").value.trim().toLowerCase();
  const favs = new Set(DB.lib.favs || []);
  const curCodes = new Set(targets().filter((l) => l.state.mode === "effect").map((l) => l.state.effect));
  const custom = Object.keys(DB.lib.patterns).map(Number).filter((c) => !basePat(c)).map((c) => ({ code: c, group: "Custom" }));
  const seen = new Set();
  const list = [...PATTERNS, ...custom].filter((p) => {
    const key = p.code + "|" + p.group; if (seen.has(key)) return false; seen.add(key);
    const info = patInfo(p.code), nm = (patMeta(p.code).name || p.name || info.name).toLowerCase();
    if (pGroup === "Favourites" && !favs.has(p.code)) return false;
    if (pGroup === "My names" && !patMeta(p.code).name) return false;
    if (!["All", "Favourites", "My names"].includes(pGroup) && p.group !== pGroup) return false;
    if (q && !(nm.includes(q) || String(p.code) === q || p.group.toLowerCase().includes(q))) return false;
    return true;
  });
  $("pCount").textContent = `${list.length} patterns`;
  const grid = $("pGrid"); grid.innerHTML = "";
  list.forEach((p) => {
    const info = patInfo(p.code); const name = patMeta(p.code).name || p.name || info.name;
    const look = { mode: "effect", effect: p.code, bright: 100, info: { ...info, kind: patMeta(p.code).kind || p.kind || info.kind, colors: patMeta(p.code).colors?.length ? patMeta(p.code).colors : (p.colors || info.colors), dir: p.dir || info.dir } };
    const el = document.createElement("div"); el.className = "pat" + (curCodes.has(p.code) ? " cur" : "");
    el.innerHTML = `<canvas class="strip"></canvas><button class="fav ${favs.has(p.code) ? "on" : ""}" aria-label="Favourite">${favs.has(p.code) ? "★" : "☆"}</button>
      <div class="t">${esc(name)}</div><div class="c">${esc(p.group)} · #${p.code}</div>${info.verified && p.group === "Core" ? '<span class="v" title="Confirmed for MELK-OA10">●</span>' : ""}`;
    bindStrip(el.querySelector("canvas"), () => ({ ...look, speed: speedNow() }));
    el.onclick = (e) => {
      if (e.target.closest(".fav")) { favs.has(p.code) ? favs.delete(p.code) : favs.add(p.code); DB.lib.favs = [...favs]; saveLib("favs"); renderPatterns(); return; }
      runPattern(p.code);
    };
    grid.appendChild(el);
  });
  sweepStrips();
}
function runPattern(code) { takeOver(); each((l) => l.effect(code)); labSet(code, false); if ($("v-patterns").classList.contains("on")) renderPatterns(); }
$("pSearch").oninput = renderPatterns;

let labCode = 0, labTimer = null;
const labKind = $("labKind");
Object.entries(KINDS).forEach(([k, n]) => { const o = document.createElement("option"); o.value = k; o.textContent = n; labKind.appendChild(o); });
let labColorsRainbow = false;
function labLook() {
  const cols = labColorsRainbow ? RAINBOW : [$("labC1").value, $("labC2").value, $("labC3").value];
  return { mode: "effect", effect: labCode, bright: 100, speed: speedNow(), info: { ...patInfo(labCode), kind: labKind.value, colors: cols } };
}
function labSet(c, send = true, fromAuto = false) {
  labCode = ((c % 256) + 256) % 256;
  const info = patInfo(labCode);
  $("labCode").textContent = labCode; $("labHex").textContent = "0x" + hex2(labCode).toUpperCase();
  $("labName").value = patMeta(labCode).name || ""; $("labName").placeholder = info.name;
  labKind.value = info.kind;
  const cols = info.colors; labColorsRainbow = cols.length > 3;
  if (!labColorsRainbow) { $("labC1").value = cols[0] || "#FFFFFF"; $("labC2").value = cols[1] || cols[0] || "#000000"; $("labC3").value = cols[2] || cols[1] || cols[0] || "#000000"; }
  $("labRainbow").classList.toggle("on", labColorsRainbow);
  $("labFav").textContent = (DB.lib.favs || []).includes(labCode) ? "★" : "☆";
  if (send) { takeOver(fromAuto ? "lab" : ""); each((l) => l.effect(labCode)); }
}
bindStrip($("labStrip"), labLook);
$("labPrev").onclick = () => labSet(labCode - 1);
$("labNext").onclick = () => labSet(labCode + 1);
$("labJump").onchange = (e) => labSet(clamp(+e.target.value || 0, 0, 255));
["labC1", "labC2", "labC3"].forEach((id) => ($(id).oninput = () => { labColorsRainbow = false; $("labRainbow").classList.remove("on"); }));
$("labRainbow").onclick = () => { labColorsRainbow = !labColorsRainbow; $("labRainbow").classList.toggle("on", labColorsRainbow); };
$("labSave").onclick = () => {
  const name = $("labName").value.trim();
  const cols = labColorsRainbow ? RAINBOW : [...new Set([$("labC1").value, $("labC2").value, $("labC3").value].map((c) => c.toUpperCase()))];
  DB.lib.patterns[labCode] = { name: name || undefined, kind: labKind.value, colors: cols };
  saveLib("patterns"); toast(`Saved #${labCode}${name ? ` as "${name}"` : ""}`); renderPatterns(); renderCues();
};
$("labReset").onclick = () => { delete DB.lib.patterns[labCode]; saveLib("patterns"); labSet(labCode, false); renderPatterns(); };
$("labName").onkeydown = (e) => { if (e.key === "Enter") $("labSave").click(); };
$("labFav").onclick = () => { const f = new Set(DB.lib.favs || []); f.has(labCode) ? f.delete(labCode) : f.add(labCode); DB.lib.favs = [...f]; saveLib("favs"); labSet(labCode, false); renderPatterns(); };
function stopLabAuto() { if (!labTimer) return; clearInterval(labTimer); labTimer = null; $("labAuto").textContent = "▶ Auto-step"; $("labAuto").classList.remove("on"); }
$("labAuto").onclick = () => {
  if (labTimer) { stopLabAuto(); return; }
  labTimer = setInterval(() => labSet(labCode + 1, true, true), +$("labSecs").value * 1000); $("labAuto").textContent = "■ Stop"; $("labAuto").classList.add("on");
};

/* ---------------------------------------------------------------------
   11. LIVE CONTROL: takeover, transitions, FX, audio follow
   --------------------------------------------------------------------- */
let xfTimer = null, rampTimer = null, holdFx = null, chase = null, audio = null;

/** Stop everything that could still be driving the lights, so a new look starts clean.
    `keep` names the one engine that should keep running. */
function takeOver(keep = "") {
  if (keep !== "show") stopShowFx();
  if (keep !== "audio" && audio) stopAudio(true);
  if (keep !== "lab") stopLabAuto();
  if (keep !== "chase" && chase) stopChase(true);
  if (keep !== "fx" && holdFx) endHold(true);
  [...document.querySelectorAll("#micModes .on")].forEach((b) => b.classList.remove("on"));
}

/* Transition time for colour changes, scenes and House */
const transitionSecs = () => +($("xfade")?.value || 0);
function crossfade(T, hex, secs) {
  if (!T.length) { toast(lights.length ? "Select at least one connected light." : "Connect a light first."); return; }
  clearInterval(xfTimer);
  const steps = Math.max(1, Math.round(secs * 15)); let n = 0;
  const from = T.map((l) => (l.state.on ? l._shown || (l.state.mode === "color" ? scaleHex(l.state.color, l.state.bright) : l.state.mode === "cct" ? cctRgbOf(l.state.cct).map((x) => Math.round(x * l.state.bright / 100)) : [0, 0, 0]) : [0, 0, 0]));
  const to = T.map((l) => scaleHex(hex, l.state.bright));
  xfTimer = setInterval(() => {
    n++; const t = n / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    T.forEach((l, k) => l.showRgb(from[k].map((v, j) => Math.round(v + (to[k][j] - v) * e)), true));
    if (n >= steps) { clearInterval(xfTimer); xfTimer = null; T.forEach((l) => { l.state.mode = "color"; l.state.color = hex; l.restore(); }); updateLightRows(); }
  }, 1000 / 15);
}

/* Brightness ramps: Swell (fade up) and Fade out */
function ramp(T, from, to, secs, done) {
  clearInterval(rampTimer); const steps = Math.max(1, Math.round(secs * 12)); let n = 0;
  T.forEach((l) => { l.prep(); l.ensureOn(); });
  rampTimer = setInterval(() => {
    n++; const v = Math.max(1, Math.round(from + (to - from) * (n / steps)));
    T.forEach((l) => l.latest("bright", CMD.bright(v), 30));
    if (n >= steps) { clearInterval(rampTimer); rampTimer = null; done && done(); }
  }, 1000 / 12);
}

/* Momentary (hold) FX: Flash, Colour flash, Strobe, Blinder */
function startHold(kind) {
  const T = targets(); if (!T.length) { toast(lights.length ? "Select at least one connected light." : "Connect a light first."); return; }
  endHold(true);
  holdFx = { kind, T, timer: null };
  const live = hexToRgb(liveHex());
  if (kind === "flash") T.forEach((l) => l.showRgb([255, 255, 255]));
  else if (kind === "cflash") T.forEach((l) => l.showRgb(live));
  else if (kind === "black") T.forEach((l) => l.showRgb([0, 0, 0]));
  else if (kind === "strobe" || kind === "cstrobe") {
    let on = false; const c = kind === "strobe" ? [255, 255, 255] : live;
    const hz = +($("strobeRate")?.value || 10);
    holdFx.timer = setInterval(() => { on = !on; T.forEach((l) => l.showRgb(on ? c : [0, 0, 0])); }, 500 / hz);
  }
  document.querySelectorAll(`[data-hold="${kind}"]`).forEach((b) => b.classList.add("on"));
}
function endHold(quiet) {
  if (!holdFx) return;
  clearInterval(holdFx.timer); const T = holdFx.T; holdFx = null;
  document.querySelectorAll("[data-hold].on").forEach((b) => b.classList.remove("on"));
  if (quiet) return;
  if (audio || chase || beatTimer) return;   // the running engine takes over again on its next tick
  T.forEach((l) => l.restore()); updateLightRows();
}

/* Light chase: steps the palette across the selected lights in time */
function startChase() {
  const T = targets(); if (T.length < 1) { toast("Select the lights to chase across."); return; }
  takeOver("chase");
  const bpm = song()?.bpm || audio?.bpm || 120;
  chase = { T, step: 0, timer: null };
  const tick = () => {
    const pal = AUD.palette.length ? AUD.palette : [liveHex()];
    T.forEach((l, i) => {
      const lit = T.length === 1 ? true : (i === chase.step % T.length);
      const col = pal[(chase.step + i) % pal.length];
      l.showRgb(scaleHex(T.length === 1 ? col : (lit ? col : col), lit ? 100 : 12));
    });
    chase.step++;
  };
  tick(); chase.timer = setInterval(tick, 60000 / bpm);
  document.querySelectorAll('[data-fx="chase"]').forEach((b) => b.classList.add("on"));
}
function stopChase(quiet) {
  if (!chase) return; clearInterval(chase.timer); const T = chase.T; chase = null;
  document.querySelectorAll('[data-fx="chase"]').forEach((b) => b.classList.remove("on"));
  if (!quiet) T.forEach((l) => l.restore());
}

/* FX bar wiring (there are copies in Show and Colour tabs) */
function fxAction(fx) {
  const T = targets();
  if (fx === "chase") { chase ? stopChase() : startChase(); return; }
  if (!T.length) { toast(lights.length ? "Select at least one connected light." : "Connect a light first."); return; }
  if (fx === "swell") { takeOver(); T.forEach((l) => { if (!l.state.on) l.power(true); }); ramp(T, 3, Math.max(5, +$("gBright").value), 2.5); }
  if (fx === "fadeout") { takeOver(); const b = Math.max(...T.map((l) => l.state.bright)); ramp(T, b, 1, 2.5, () => T.forEach((l) => { const keep = l.state.bright; l.power(false); l.state.bright = keep; })); }
  if (fx === "random") { takeOver(); T.forEach((l) => l.color(rgbToHex(...hsvToRgb(Math.floor(Math.random() * 360), 100, 100)))); }
  if (fx === "spread") { takeOver(); T.forEach((l, i) => l.color(rgbToHex(...hsvToRgb(Math.round(i * 360 / T.length + (Date.now() / 50 % 360)) % 360, 100, 100)))); }
  if (fx === "same") { takeOver(); const src = T[0].state; T.forEach((l) => applyLookTo([l], { mode: src.mode === "mic" ? "color" : src.mode, color: src.color, effect: src.effect, cct: src.cct, bright: src.bright, speed: src.speed })); }
  updateLightRows();
}
document.querySelectorAll("[data-fx]").forEach((b) => (b.onclick = () => fxAction(b.dataset.fx)));
document.querySelectorAll("[data-hold]").forEach((b) => {
  b.onpointerdown = (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); startHold(b.dataset.hold); };
  b.onpointerup = b.onpointercancel = () => endHold(false);
  b.oncontextmenu = (e) => e.preventDefault();
});

/* ---- Controller microphone (built into the light) ---- */
$("micOn").onclick = () => { takeOver(); each((l) => { l.prep(); l.send(CMD.micOn()); }); };
$("micOff").onclick = () => each((l) => { l.send(CMD.micOff()); if (l.state.mode === "mic") { l.state.mode = "color"; l.restore(); } });
$("micSens").oninput = (e) => { $("micSensV").textContent = e.target.value; each((l) => l.latest("mic", CMD.micSens(+e.target.value))); };
MIC_MODES.forEach(([v, n]) => { const b = document.createElement("button"); b.className = "btn sm"; b.textContent = n;
  b.onclick = () => { takeOver(); if (each((l) => { l.prep(); l.ensureOn(); l.send(CMD.micOn()); l.send(CMD.micMode(v)); l.state.mode = "mic"; })) b.classList.add("on"); };
  $("micModes").appendChild(b); });

/* ---- Follow audio (this device's mic or any audio input) ---- */
const AUD_MODES = {
  pulse: ["Pulse", "Brightness follows the volume"],
  beat: ["Beat flash", "Flashes on every detected beat"],
  palette: ["Beat colours", "Steps to the next palette colour on each beat"],
  spectrum: ["Spectrum", "Bass / mids / highs blend palette colours"],
  breathe: ["Breathe", "Slow, smooth swell with the music"],
  rainbow: ["Rainbow", "Hue drifts faster when it gets louder"],
  drop: ["Drop strobe", "Strobes only when the music gets very loud"],
  chase: ["Beat chase", "One light at a time steps across on each beat"],
};
const PAL_PRESETS = {
  Worship: ["#1E3CFF", "#6000FF", "#FF1E8C", "#FFFFFF"],
  Warm: ["#FF4000", "#FF8000", "#FFC800", "#FFB066"],
  Ocean: ["#0040FF", "#00C8FF", "#00FFB0", "#FFFFFF"],
  Christmas: ["#FF0000", "#00FF40", "#FFFFFF", "#FFC800"],
  Rainbow: ["#FF0000", "#FFC800", "#00FF00", "#00C8FF", "#0000FF", "#C000FF"],
  White: ["#FFFFFF"],
};
const AUD = Object.assign({ mode: "pulse", source: "live", spread: false, palette: PAL_PRESETS.Worship.slice(), deviceId: "", who: "sel", max: 100 }, local.get("aud", {}));
const saveAud = () => local.set("aud", { mode: AUD.mode, source: AUD.source, spread: AUD.spread, palette: AUD.palette, deviceId: AUD.deviceId });
const liveHex = () => ($("liveColor").value || "#FFFFFF").toUpperCase();
const audioUsesLive = () => !!audio && AUD.source === "live" && !["spectrum", "rainbow", "palette"].includes(AUD.mode);
const audioTargets = () => (AUD.who === "all" ? lights.filter((l) => l.char) : targets());

function syncAudioUi() {
  document.querySelectorAll("#audModes [data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === AUD.mode));
  document.querySelectorAll("#audSource [data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === AUD.source));
  $("audSpread").checked = AUD.spread; $("aMax").value = AUD.max; $("aMaxV").textContent = AUD.max;
  $("audModeHint").textContent = AUD_MODES[AUD.mode][1];
  renderPalette();
}
function renderPalette() {
  const box = $("audPalette"); box.innerHTML = "";
  AUD.palette.forEach((c, i) => {
    const w = document.createElement("span"); w.className = "pal-chip";
    w.innerHTML = `<input type="color" value="${c}" aria-label="Palette colour ${i + 1}"><button aria-label="Remove">✕</button>`;
    w.querySelector("input").oninput = (e) => { AUD.palette[i] = e.target.value.toUpperCase(); saveAud(); };
    w.querySelector("button").onclick = () => { if (AUD.palette.length > 1) { AUD.palette.splice(i, 1); saveAud(); renderPalette(); } };
    box.appendChild(w);
  });
  if (AUD.palette.length < 8) { const a = document.createElement("button"); a.className = "btn sm"; a.textContent = "+"; a.onclick = () => { AUD.palette.push(liveHex()); saveAud(); renderPalette(); }; box.appendChild(a); }
}
Object.entries(AUD_MODES).forEach(([k, [n]]) => { const b = document.createElement("button"); b.className = "btn sm"; b.dataset.m = k; b.textContent = n;
  b.onclick = () => { AUD.mode = k; saveAud(); syncAudioUi(); }; $("audModes").appendChild(b); });
Object.entries(PAL_PRESETS).forEach(([k, cols]) => { const b = document.createElement("button"); b.className = "btn sm"; b.textContent = k;
  b.onclick = () => { AUD.palette = cols.slice(); saveAud(); renderPalette(); }; $("palPresets").appendChild(b); });
document.querySelectorAll("#audSource [data-s]").forEach((b) => (b.onclick = () => { AUD.source = b.dataset.s; saveAud(); syncAudioUi(); }));
$("audSpread").onchange = (e) => { AUD.spread = e.target.checked; saveAud(); };
$("audWho").onchange = (e) => { AUD.who = e.target.value; };
[["aGain", (v) => (v / 100).toFixed(1) + "×"], ["aFloor", (v) => v], ["aSmooth", (v) => v], ["aSens", (v) => v], ["aMin", (v) => v], ["aMax", (v) => v]].forEach(([k, f]) =>
  $(k).addEventListener("input", (e) => { $(k + "V").textContent = f(+e.target.value); if (k === "aMax") AUD.max = +e.target.value; }));

async function listInputs() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    const sel = $("audInput"); const cur = AUD.deviceId; sel.innerHTML = `<option value="">Default microphone</option>`;
    devs.forEach((d, i) => { if (!d.deviceId || d.deviceId === "default") return; const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || `Input ${i + 1}`; sel.appendChild(o); });
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "";
  } catch (e) {}
}
$("audInput").onchange = async (e) => { AUD.deviceId = e.target.value; saveAud(); if (audio) { stopAudio(true); await startAudio(); } };

async function startAudio() {
  if (!navigator.mediaDevices?.getUserMedia) { toast("Microphone isn't available here (needs https and a modern browser)."); return; }
  if (!audioTargets().length) { toast(lights.length ? "Select the lights that should follow the audio." : "Connect a light first."); return; }
  takeOver("audio");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: AUD.deviceId ? { exact: AUD.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)(); await ctx.resume?.();
    const an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.15;
    ctx.createMediaStreamSource(stream).connect(an);
    const binHz = ctx.sampleRate / an.fftSize, bin = (hz) => Math.max(1, Math.round(hz / binHz));
    audio = { ctx, stream, an, buf: new Uint8Array(an.frequencyBinCount), bins: { b0: bin(35), b1: bin(160), m1: bin(2000), h1: bin(8000) },
      env: 0, slow: 0, bassAvg: 0.05, lastBeat: 0, ivs: [], bpm: 0, flash: 0, palIdx: 0, hue: 0, step: 0, tick: 0, last: 0, raf: 0, dropOn: false };
    setAudioUi(true); listInputs(); log("Follow audio started", "ok"); audioLoop();
  } catch (e) { toast(e.name === "NotAllowedError" ? "Microphone permission was blocked. Allow it in the site settings." : "Couldn't open the microphone: " + e.message); log("Audio: " + e.message, "err"); }
}
function stopAudio(quiet) {
  if (!audio) return;
  cancelAnimationFrame(audio.raf); audio.stream.getTracks().forEach((t) => t.stop()); audio.ctx.close(); audio = null;
  setAudioUi(false);
  if (!quiet) { audioTargets().forEach((l) => l.restore()); updateLightRows(); }
  log("Follow audio stopped");
}
function setAudioUi(on) {
  $("audioToggle").classList.toggle("on", on); $("audStart").textContent = on ? "■ Stop following" : "▶ Follow audio"; $("audStart").classList.toggle("inv", !on);
  if (!on) { $("aMeter").style.width = "0"; $("audioToggle").style.setProperty("--lvl", "0%"); $("audBpm").textContent = "–"; }
}
const toggleAudio = () => (audio ? stopAudio(false) : startAudio());
$("audStart").onclick = toggleAudio;
$("audioToggle").onclick = toggleAudio;
$("audUseBpm").onclick = () => { if (!audio?.bpm || !song()) { toast("No tempo detected yet."); return; } song().bpm = audio.bpm; $("songBpm").value = audio.bpm; saveService(svc()); renderSetlist(); restartBeat(); toast(`Song BPM set to ${audio.bpm}`); };

function audioLoop() {
  if (!audio) return; audio.raf = requestAnimationFrame(audioLoop);
  const A = audio, { buf, bins } = A; A.an.getByteFrequencyData(buf);
  const band = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += buf[i]; return s / Math.max(1, b - a) / 255; };
  const bass = band(bins.b0, bins.b1), mid = band(bins.b1, bins.m1), high = band(bins.m1, Math.min(bins.h1, buf.length)), all = band(bins.b0, Math.min(bins.h1, buf.length));
  const gain = +$("aGain").value / 100, floor = +$("aFloor").value / 100, sm = +$("aSmooth").value / 100, sens = +$("aSens").value / 100;
  const raw = Math.min(1, all * 1.8 * gain);
  A.env += (raw - A.env) * (raw > A.env ? 1 - sm * 0.7 : (1 - sm) * 0.3);
  A.slow += (raw - A.slow) * 0.03;
  const lvl = clamp((A.env - floor) / Math.max(0.05, 1 - floor), 0, 1);
  // Beat detection on bass energy against its running average
  const now = performance.now(), e = bass * gain;
  const thr = A.bassAvg * (1.08 + (1 - sens) * 0.9) + 0.015;
  if (e > thr && e > 0.06 && now - A.lastBeat > 280) {
    if (A.lastBeat) { const iv = now - A.lastBeat; if (iv < 1500) { A.ivs.push(iv); if (A.ivs.length > 12) A.ivs.shift(); } }
    A.lastBeat = now; A.flash = 1; A.palIdx++; A.step++;
    if (A.ivs.length >= 4) { const sorted = [...A.ivs].sort((a, b) => a - b); let bpm = 60000 / sorted[sorted.length >> 1]; while (bpm < 70) bpm *= 2; while (bpm > 180) bpm /= 2; A.bpm = Math.round(bpm); $("audBpm").textContent = A.bpm; }
    const d = $("audBeat"); d.classList.add("hit"); setTimeout(() => d.classList.remove("hit"), 80);
  }
  A.bassAvg += (e - A.bassAvg) * 0.04;
  A.flash *= 0.88;
  // Meters
  $("aMeter").style.width = Math.round(lvl * 100) + "%"; $("audioToggle").style.setProperty("--lvl", Math.round(lvl * 100) + "%");
  if (A.tick++ % 2 === 0) { const c = $("spec"), g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
    for (let i = 0; i < 64; i++) { const v = buf[Math.floor(bins.b0 + i * (bins.h1 - bins.b0) / 64)] / 255; g.fillStyle = `rgba(255,255,255,${0.25 + v * 0.75})`; g.fillRect(i * (c.width / 64) + 1, c.height * (1 - v), c.width / 64 - 2, c.height * v); } }
  // Output to lights ~20 fps
  if (now - A.last < 50 || holdFx) return; A.last = now;
  const T = audioTargets(); if (!T.length) return;
  const minB = +$("aMin").value, maxB = +$("aMax").value, briOf = (k) => minB + (maxB - minB) * clamp(k, 0, 1);
  A.hue = (A.hue + 0.4 + lvl * 5) % 360;
  const pal = AUD.palette.length ? AUD.palette : [liveHex()];
  const baseFor = (i) => {
    const off = AUD.spread ? i : 0;
    if (AUD.mode === "palette") return hexToRgb(pal[(A.palIdx + off) % pal.length]);
    if (AUD.mode === "rainbow") return hsvToRgb(Math.round(A.hue + (AUD.spread ? i * 360 / T.length : 0)) % 360, 100, 100);
    if (AUD.source === "palette") return hexToRgb(pal[(A.palIdx + off) % pal.length]);
    if (AUD.source === "rainbow") return hsvToRgb(Math.round(A.hue + (AUD.spread ? i * 360 / T.length : 0)) % 360, 100, 100);
    return hexToRgb(liveHex());
  };
  T.forEach((l, i) => {
    let base = baseFor(i), k = lvl;
    switch (AUD.mode) {
      case "pulse": k = lvl; break;
      case "beat": k = Math.max(A.flash, 0); break;
      case "palette": k = 0.55 + 0.45 * Math.max(A.flash, lvl * 0.6); break;
      case "breathe": k = clamp((A.slow * gain * 1.6 - floor) / Math.max(0.05, 1 - floor), 0, 1); break;
      case "rainbow": k = 0.3 + 0.7 * lvl; break;
      case "spectrum": {
        const tot = bass + mid + high + 1e-6, c0 = hexToRgb(pal[0]), c1 = hexToRgb(pal[1 % pal.length]), c2 = hexToRgb(pal[2 % pal.length]);
        base = [0, 1, 2].map((j) => Math.round((c0[j] * bass + c1[j] * mid + c2[j] * high) / tot)); k = lvl; break; }
      case "drop": { const loud = lvl > 0.78; k = loud ? ((A.tick >> 1) % 2 ? 1 : 0) : lvl * 0.45; if (loud) base = AUD.source === "live" ? base : [255, 255, 255]; break; }
      case "chase": k = i === A.step % T.length ? Math.max(0.6, A.flash) : 0.08; break;
    }
    l.showRgb(base.map((x) => Math.round(x * briOf(k) / 100)), true);
  });
}

$("xfade").oninput = (e) => ($("xfadeV").textContent = +e.target.value ? e.target.value + "s" : "Instant");
$("strobeRate").oninput = (e) => ($("strobeRateV").textContent = e.target.value + " Hz");

/* Header live colour chip */
$("liveColor").oninput = (e) => setColour({ hex: e.target.value.toUpperCase() });
$("liveColor").onchange = commitRecent;

/* ---------------------------------------------------------------------
   12. SCENES (shared library)
   --------------------------------------------------------------------- */
const lookDesc = (c) => c.mode === "effect" ? patLabel(c.effect) : c.mode === "cct" ? `White ${kOf(c.cct)}K` : c.mode === "off" ? "Off" : c.mode === "audio" ? `♪ ${(AUD_MODES[c.audioMode || "pulse"] || ["Audio"])[0]}` : c.color;
function renderScenes() {
  const g = $("sceneGrid"); g.innerHTML = "";
  (DB.lib.scenes || []).forEach((s, i) => {
    const el = document.createElement("div"); el.className = "scene";
    el.innerHTML = `<canvas class="strip"></canvas><button class="x" aria-label="Delete">✕</button><div class="t">${esc(s.name)}</div><div class="d">${esc(lookDesc(s))} · ${s.bright}%</div>`;
    bindStrip(el.querySelector("canvas"), () => s);
    el.onclick = async (e) => {
      if (e.target.closest(".x")) { if (await confirmBox(`Delete scene "${s.name}"?`, "", "Delete", true)) { DB.lib.scenes.splice(i, 1); saveLib("scenes"); renderScenes(); } return; }
      applyLookTo(targets(), s, true);
    };
    g.appendChild(el);
  });
  sweepStrips();
}
$("sceneSave").onclick = async () => {
  const l = targets()[0]; if (!l) { toast("Select a light whose current look you want to save."); return; }
  const n = await ask("Scene name", "", "e.g. Communion"); if (!n) return;
  const s = l.state; DB.lib.scenes.push({ id: uid(), name: n, mode: s.mode === "mic" ? "color" : s.mode, color: s.color, effect: s.effect, cct: s.cct, bright: s.bright, speed: s.speed });
  saveLib("scenes"); renderScenes();
};
function applyLookTo(T, s, syncUi) {
  if (!T.length) { toast(lights.length ? "Select at least one connected light." : "Connect a light first."); return; }
  takeOver();
  if (s.mode === "color" && transitionSecs() > 0) {
    T.forEach((l) => { l.state.speed = s.speed ?? l.state.speed; l.state.bright = s.bright; });
    crossfade(T, s.color, transitionSecs());
    if (syncUi) { $("gBright").value = s.bright; $("gBrightV").textContent = s.bright; setColour({ hex: s.color }, false); }
    return;
  }
  T.forEach((l) => {
    if (s.mode === "off") { l.power(false); return; }
    l.power(true); l.state.speed = s.speed ?? l.state.speed;
    if (s.mode === "effect") l.effect(s.effect); else if (s.mode === "cct") l.cct(s.cct, cctRgb); else l.color(s.color);
    l.bright(s.bright);
  });
  if (syncUi) { $("gBright").value = s.bright; $("gBrightV").textContent = s.bright; if (s.speed != null) { $("gSpeed").value = s.speed; $("gSpeedV").textContent = s.speed; } if (s.mode === "color") setColour({ hex: s.color }, false); }
  updateLightRows();
}

/* ---------------------------------------------------------------------
   13. SHOW: services, setlists, cues
   --------------------------------------------------------------------- */
let svcIdx = 0, songIdx = 0, cueIdx = -1, editIdx = -1;
const svc = () => DB.services[svcIdx];
const song = () => { const it = svc()?.songs[songIdx]; return it && it.type !== "header" ? it : undefined; };
function sortServices() { const id = svc()?.id; DB.services.sort((a, b) => (b.service_date || "").localeCompare(a.service_date || "")); const i = DB.services.findIndex((s) => s.id === id); svcIdx = i >= 0 ? i : 0; }
function fmtDate(d) { if (!d) return ""; try { return new Date(d + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return d; } }

function renderSvcSelect() {
  const sel = $("svcSelect"); sel.innerHTML = "";
  if (!DB.services.length) { sel.innerHTML = `<option>No service</option>`; return; }
  DB.services.forEach((s, i) => { const o = document.createElement("option"); o.value = i; o.textContent = `${s.name || "Untitled Service"}${s.service_date ? " · " + fmtDate(s.service_date) : ""}`; sel.appendChild(o); });
  sel.value = svcIdx;
}
$("svcSelect").onchange = (e) => { svcIdx = +e.target.value; songIdx = 0; cueIdx = -1; editIdx = -1; stopShowFx(); renderShow(); };
function renderService() {
  const s = svc(); if (!s) return;
  if (document.activeElement !== $("svcName")) $("svcName").value = s.name || "";
  $("svcDate").value = s.service_date || "";
  if (document.activeElement !== $("svcNotes")) $("svcNotes").value = s.notes || "";
}
$("svcName").oninput = (e) => { svc().name = e.target.value; saveService(svc()); renderSvcSelect(); };
$("svcDate").onchange = (e) => { svc().service_date = e.target.value; saveService(svc()); sortServices(); renderSvcSelect(); };
$("svcNotes").oninput = (e) => { svc().notes = e.target.value; saveService(svc()); };
$("svcDup").onclick = async () => {
  const src = svc(); if (!src) return; const n = await ask("Name for the copy", src.name); if (!n) return;
  const s = JSON.parse(JSON.stringify(src)); s.id = uid(); s.name = n; s.service_date = new Date().toISOString().slice(0, 10); s.songs.forEach((x) => (x.id = uid()));
  DB.services.push(s); sortServices(); svcIdx = DB.services.indexOf(s); saveService(s); renderShow(); toast("Service duplicated");
};
$("svcDel").onclick = async () => {
  const s = svc(); if (!s || !(await confirmBox(`Delete "${s.name}"?`, "This removes it for everyone.", "Delete", true))) return;
  DB.services.splice(svcIdx, 1); svcIdx = 0; songIdx = 0; cueIdx = -1;
  await deleteServiceRemote(s.id);
  if (!DB.services.length) { const n = makeService(""); DB.services.push(n); saveService(n); }
  cacheLocal(); renderShow();
};

/* ---- ProPresenter-style playlist: services, items (songs + headers), library ---- */
const HDR_COLS = { PreShow: "#3E5A2E", Music: "#2D4A63", Worship: "#2D4A63", Sermon: "#6A5236", Presentation: "#6A5236", Response: "#5A3B6B", Offering: "#2F5F5A", Ending: "#4A4A4A" };
const HDR_SWATCHES = ["#3E5A2E", "#2D4A63", "#6A5236", "#5A3B6B", "#7A2E36", "#2F5F5A", "#4A4A4A"];
const SVC_TEMPLATES = {
  sunday: ["PreShow", "Worship", "Sermon", "Response"],
  simple: ["Music"],
  empty: [],
};
const isHdr = (it) => it && it.type === "header";
function makeService(name, template = "sunday") {
  const today = new Date(); const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return { id: uid(), name: (name || "").trim() || "Untitled Service", service_date: d, notes: "", updated_at: new Date().toISOString(),
    songs: (SVC_TEMPLATES[template] || []).map((h) => ({ id: uid(), type: "header", name: h, color: HDR_COLS[h] || "#4A4A4A" })) };
}
function addService(s) { DB.services.push(s); sortServices(); svcIdx = DB.services.indexOf(s); songIdx = 0; cueIdx = -1; editIdx = -1; saveService(s); renderShow(); }

function createServiceSheet(opts = {}) {
  const recent = [...DB.services].slice(0, 8);
  return modal(`<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><img src="icons/logo.png" alt="" style="width:44px;height:44px;border-radius:10px"><div><h2 style="margin:0">${opts.start ? "Start a service" : "New service"}</h2><p style="margin:0">Leave the name blank for "Untitled Service".</p></div></div>
    <label>Service name<input type="text" id="nsName" placeholder="Untitled Service"></label>
    <div class="row tight" style="gap:10px"><label style="flex:1">Date<input type="date" id="nsDate"></label>
      <label style="flex:1">Template<select id="nsTpl"><option value="sunday">PreShow · Worship · Sermon · Response</option><option value="simple">Music only</option><option value="empty">Empty</option></select></label></div>
    <div class="acts" style="margin-top:12px"><button class="btn" id="nsSkip">${opts.start ? (DB.services.length ? "Skip" : "Later") : "Cancel"}</button><button class="btn inv" id="nsGo">Create service</button></div>
    ${opts.start && recent.length ? `<h3 class="sub" style="font-size:12px;color:var(--muted);letter-spacing:1.2px;text-transform:uppercase;margin:18px 0 6px">Or open</h3>
      <div class="start-svc">${recent.map((s) => `<button class="btn" data-open="${s.id}"><span>${esc(s.name || "Untitled Service")}</span><small>${esc(fmtDate(s.service_date))} · ${(s.songs || []).filter((x) => !isHdr(x)).length} songs</small></button>`).join("")}</div>` : ""}`, (close) => {
    const t = new Date(); $("nsDate").value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    setTimeout(() => $("nsName").focus(), 50);
    const go = () => { const s = makeService($("nsName").value, $("nsTpl").value); s.service_date = $("nsDate").value || s.service_date; close(true); addService(s); toast(`Created "${s.name}"`); };
    $("nsGo").onclick = go; $("nsName").onkeydown = (e) => { if (e.key === "Enter") go(); };
    $("nsSkip").onclick = () => close(false);
    $("sheet").querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => { svcIdx = DB.services.findIndex((s) => s.id === b.dataset.open); songIdx = 0; cueIdx = -1; close(true); renderShow(); }));
  }).then((r) => { if (!DB.services.length) addService(makeService("")); return r; });
}
$("svcNew").onclick = () => createServiceSheet();

function renderSvcList() {
  const box = $("svcList"); box.innerHTML = "";
  if (!DB.services.length) { box.innerHTML = `<div class="ps-empty">No services yet. Tap + to create one.</div>`; return; }
  DB.services.forEach((s, i) => {
    const el = document.createElement("div"); el.className = "ps-row" + (i === svcIdx ? " cur" : "");
    el.innerHTML = `<span class="ps-i pl"></span><span class="t">${esc(s.name || "Untitled Service")}</span><span class="r">${esc(fmtDate(s.service_date))}</span><button class="ps-ico ps-more" aria-label="Service options">⋯</button>`;
    el.oncontextmenu = (e) => { e.preventDefault(); serviceMenu(i); };
    el.onclick = (e) => { if (e.target.closest(".ps-more")) { serviceMenu(i); return; } if (i === svcIdx) return; svcIdx = i; songIdx = 0; cueIdx = -1; editIdx = -1; takeOver(); renderShow(); };
    box.appendChild(el);
  });
}
function librarySongs() {
  const map = new Map();
  DB.services.forEach((s) => (s.songs || []).forEach((x) => { if (isHdr(x) || !x.name) return; const k = x.name.trim().toLowerCase();
    const prev = map.get(k); if (!prev || (s.updated_at || "") > (prev.svc.updated_at || "")) map.set(k, { song: x, svc: s }); }));
  return [...map.values()].sort((a, b) => a.song.name.localeCompare(b.song.name));
}
function renderLibList() {
  const n = librarySongs().length, box = $("libList"); box.innerHTML = "";
  const el = document.createElement("div"); el.className = "ps-row";
  el.innerHTML = `<span class="ps-i lib">♪</span><span class="t">Songs</span><span class="r">${n}</span>`;
  el.onclick = () => librarySheet(); box.appendChild(el);
}
function librarySheet() {
  const all = librarySongs();
  if (!all.length) { toast("The library fills up as you add songs to services."); return; }
  modal(`<h2>Song library</h2><p>Every song you've used in any service, with its cues. Tap to add it to "${esc(svc()?.name || "this service")}".</p>
    <input type="search" id="libQ" class="full" placeholder="Search songs">
    <div class="list" id="libRes" style="margin-top:10px"></div><div class="acts"><button class="btn" id="mNo">Close</button></div>`, (close) => {
    const draw = () => {
      const q = $("libQ").value.trim().toLowerCase();
      $("libRes").innerHTML = all.filter(({ song: x }) => !q || x.name.toLowerCase().includes(q)).map(({ song: x, svc: s }, j) =>
        `<button class="btn" data-k="${esc(x.name)}" style="justify-content:space-between"><span>${esc(x.name)}</span><small class="hint">${x.bpm ? x.bpm + " BPM · " : ""}${x.cues?.length || 0} cues · ${esc(s.name)}</small></button>`).join("") || `<p class="hint">No match.</p>`;
      $("libRes").querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
        const src = all.find(({ song: x }) => x.name === b.dataset.k).song; const c = JSON.parse(JSON.stringify(src)); c.id = uid();
        insertItem(c); toast(`Added "${c.name}"`); close();
      }));
    };
    $("libQ").oninput = draw; draw(); setTimeout(() => $("libQ").focus(), 50); $("mNo").onclick = () => close();
  });
}
$("songCopyFrom").onclick = librarySheet;

/* Insert after the selected item (so songs land under the header you picked) */
function insertItem(it) {
  if (!svc()) addService(makeService(""));
  const a = svc().songs, at = a.length ? Math.min(songIdx + 1, a.length) : 0;
  a.splice(at, 0, it); songIdx = at; cueIdx = -1; editIdx = -1; saveService(svc()); renderShow();
}
function headerSheet(h) {
  const isNew = !h; h = h || { id: uid(), type: "header", name: "", color: HDR_SWATCHES[0] };
  let col = h.color;
  return modal(`<h2>${isNew ? "Add header" : "Edit header"}</h2>
    <label>Name<input type="text" id="hdName" value="${esc(h.name)}" placeholder="e.g. PreShow, Worship, Sermon"></label>
    <div class="chips">${Object.keys(HDR_COLS).map((n) => `<button class="btn sm" data-n="${n}">${n}</button>`).join("")}</div>
    <div class="hint">Colour</div><div class="hdr-cols">${HDR_SWATCHES.map((c) => `<button data-c="${c}" style="background:${c}" class="${c === col ? "on" : ""}" aria-label="${c}"></button>`).join("")}</div>
    <div class="acts">${isNew ? "" : `<button class="btn danger" id="hdDel">Delete</button><span class="flex"></span>`}<button class="btn" id="mNo">Cancel</button><button class="btn inv" id="mOk">${isNew ? "Add" : "Save"}</button></div>`, (close) => {
    setTimeout(() => $("hdName").focus(), 50);
    $("sheet").querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => { $("hdName").value = b.dataset.n; col = HDR_COLS[b.dataset.n]; $("sheet").querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("on", x.dataset.c === col)); }));
    $("sheet").querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { col = b.dataset.c; $("sheet").querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("mNo").onclick = () => close();
    if ($("hdDel")) $("hdDel").onclick = () => { const a = svc().songs, i = a.indexOf(h); if (i >= 0) a.splice(i, 1); songIdx = Math.max(0, i - 1); saveService(svc()); renderShow(); close(); };
    $("mOk").onclick = () => { h.name = $("hdName").value.trim() || "Header"; h.color = col; if (isNew) insertItem(h); else { saveService(svc()); renderShow(); } close(); };
    $("hdName").onkeydown = (e) => { if (e.key === "Enter") $("mOk").click(); };
  });
}
async function newSongFlow() {
  if (!svc()) addService(makeService(""));
  const r = await songSheet("Add song", {}); if (!r) return;
  const cues = parseArrangement(r.arr);
  insertItem({ id: uid(), name: r.name, note: r.note, bpm: r.bpm, arr: r.arr, cues: cues.length ? cues : [{ name: "Look 1", ...LOOK("color") }] });
  toast(`Added "${r.name}" with ${cues.length} cues`);
}
$("songAdd").onclick = () => modal(`<h2>Add to ${esc(svc()?.name || "service")}</h2><p>New items go below the selected one.</p>
  <div class="list"><button class="btn" id="aiSong">♪  New song (from arrangement)</button><button class="btn" id="aiLib">⌕  Song from library</button><button class="btn" id="aiHdr">▬  Header (PreShow, Worship, Sermon…)</button></div>
  <div class="acts"><button class="btn" id="mNo">Cancel</button></div>`, (close) => {
  $("mNo").onclick = () => close();
  $("aiSong").onclick = () => { close(); setTimeout(newSongFlow, 30); };
  $("aiLib").onclick = () => { close(); setTimeout(librarySheet, 30); };
  $("aiHdr").onclick = () => { close(); setTimeout(() => headerSheet(), 30); };
});

function renderSetlist() {
  const box = $("setlist"); box.innerHTML = "";
  const items = svc()?.songs || [];
  $("itemCount").textContent = `${items.length} ITEM${items.length === 1 ? "" : "S"}`;
  if (!items.length) { box.innerHTML = `<div class="ps-empty">Empty. Tap + to add a song or header.</div>`; return; }
  items.forEach((it, i) => {
    const el = document.createElement("div");
    if (isHdr(it)) {
      el.className = "ps-hdr" + (i === songIdx ? " cur" : ""); el.style.setProperty("--h", it.color || "#4A4A4A");
      el.innerHTML = `<span>${esc(it.name)}</span><span class="r">✎</span>`;
      el.onclick = () => { if (i === songIdx) { headerSheet(it); return; } songIdx = i; cueIdx = -1; editIdx = -1; renderShow(); };
    } else {
      el.className = "ps-row" + (i === songIdx ? " cur" : "");
      el.innerHTML = `<span class="ps-i doc"></span><span class="t">${esc(it.name || "Untitled")}</span><span class="r">${esc(it.note || (it.bpm ? it.bpm + " BPM" : ""))}</span>`;
      el.onclick = () => { if (i === songIdx) return; songIdx = i; cueIdx = -1; editIdx = -1; takeOver(); renderShow(); };
    }
    box.appendChild(el);
  });
}
const cueLook = (c) => (c.mode === "audio" ? { mode: "effect", bright: c.bright, speed: 75, info: { kind: c.audioMode === "chase" ? "chase" : c.audioMode === "drop" ? "strobe" : "breathe", colors: [c.color], dir: 1 } } : { ...c, effect: c.effect, speed: c.speed });
/* ProPresenter-style groups: colour label per section */
const GROUPS_PP = [
  [/pre.?chorus|^pc\b|lift|build/i, "Pre-Chorus", "#E07B2E"],
  [/chorus|^c\d*\b|refrain/i, "Chorus", "#C9304F"],
  [/verse|^v\d*\b/i, "Verse", "#2F6FD0"],
  [/bridge|^b\d*\b/i, "Bridge", "#7F4FCF"],
  [/tag|vamp/i, "Tag", "#23955B"],
  [/inst|interlude|solo|turn/i, "Instrumental", "#B08A12"],
  [/intro|outro|ending|end\b|final/i, "Intro / Outro", "#6E6E6E"],
];
function groupOf(name) { for (const [re, g, col] of GROUPS_PP) if (re.test(name || "")) return { group: g, color: col }; return { group: "Other", color: "#4A4A4A" }; }
let editMode = false;
function setMode(edit) {
  editMode = edit; $("modeEdit").classList.toggle("on", edit); $("modeLive").classList.toggle("on", !edit);
  $("editTools").hidden = !edit; $("cueGrid").classList.toggle("editing", edit);
  if (!edit) { editIdx = -1; $("cueEdit").hidden = true; }
  renderCues();
}
$("modeLive").onclick = () => setMode(false);
$("modeEdit").onclick = () => setMode(true);

function renderCues() {
  const s = song(), g = $("cueGrid"); g.innerHTML = "";
  $("liveSong").textContent = s ? s.name || "Untitled" : "No song";
  if (!s) { const it = svc()?.songs[songIdx]; $("liveSong").textContent = isHdr(it) ? it.name : (svc() ? svc().name || "Untitled Service" : "No service"); $("liveCue").textContent = isHdr(it) ? "Header. Pick a song below it." : svc() ? "Add a song with + in the playlist" : "Create a service to begin"; $("songName").value = ""; $("songNote").value = ""; $("songBpm").value = ""; $("cueEdit").hidden = true; return; }
  if (document.activeElement !== $("songName")) $("songName").value = s.name || "";
  if (document.activeElement !== $("songNote")) $("songNote").value = s.note || "";
  if (document.activeElement !== $("songBpm")) $("songBpm").value = s.bpm || "";
  $("liveCue").textContent = cueIdx >= 0 && s.cues[cueIdx] ? `LIVE · ${s.cues[cueIdx].name}  (${cueIdx + 1}/${s.cues.length})` : (s.note ? s.note + " · " : "") + "Ready. Tap a tile or Next.";
  s.cues.forEach((c, i) => {
    const grp = groupOf(c.name);
    const el = document.createElement("div");
    el.className = "tile" + (i === cueIdx ? " live" : "") + (i === cueIdx + 1 && cueIdx >= 0 ? " next" : "") + (editMode && i === editIdx ? " ed" : "");
    el.style.setProperty("--g", grp.color);
    el.innerHTML = `<canvas class="thumb"></canvas><span class="num">${i + 1}</span><span class="badge">${i === cueIdx ? "LIVE" : "NEXT"}</span>
      <div class="lab"><b>${esc(c.name)}</b><small>${esc(lookDesc(c))}${c.beat !== "none" ? " · ♪" : ""}${c.fade ? ` · ${c.fade}s` : ""}</small></div>`;
    bindStrip(el.querySelector("canvas"), () => (c.mode === "off" ? { off: true } : cueLook(c)));
    el.onclick = () => (editMode ? openEditor(i) : goCue(i));
    el.oncontextmenu = (e) => { e.preventDefault(); if (!editMode) setMode(true); openEditor(i); };
    g.appendChild(el);
  });
  if (editMode) { const add = document.createElement("button"); add.className = "tile add"; add.textContent = "+ Add cue"; add.onclick = () => $("cueAddBlank").click(); g.appendChild(add); }
  if (!s.cues.length && !editMode) g.innerHTML = `<p class="hint">This song has no cues. Switch to <b>Edit</b> to add some.</p>`;
  sweepStrips();
}
function renderShow() { renderSvcSelect(); renderSvcList(); renderLibList(); renderService(); renderSetlist(); renderCues(); if (editIdx < 0) $("cueEdit").hidden = true; }

/* Song meta */
$("songName").oninput = (e) => { if (!song()) return; song().name = e.target.value; saveService(svc()); renderSetlist(); $("liveSong").textContent = e.target.value; };
$("songNote").oninput = (e) => { if (!song()) return; song().note = e.target.value; saveService(svc()); };
$("songBpm").onchange = (e) => { if (!song()) return; song().bpm = clamp(+e.target.value || 0, 40, 220); e.target.value = song().bpm; saveService(svc()); renderSetlist(); restartBeat(); };
/* Arrangement → cues. Codes: I V V1 V2 PC C B T IN O E (or full words) */
const SECTION_CODES = { I: "Intro", V: "Verse", PC: "Pre-Chorus", C: "Chorus", B: "Bridge", T: "Tag", IN: "Instrumental", INST: "Instrumental", O: "Outro", E: "Ending" };
function defaultLook(group, isLast) {
  switch (group) {
    case "Intro / Outro": return LOOK("color", { color: "#FFB066", bright: 35, fade: 3 });
    case "Verse": return LOOK("color", { color: "#3A2BFF", bright: 55, fade: 1.5 });
    case "Pre-Chorus": return LOOK("color", { color: "#9B2BFF", bright: 75, fade: 1, beat: "bar" });
    case "Chorus": return isLast ? LOOK("effect", { effect: 128, bright: 100, speed: 80 }) : LOOK("color", { color: "#FF1E8C", bright: 100, beat: "pulse" });
    case "Bridge": return LOOK("effect", { effect: 144, bright: 85, speed: 40 });
    case "Tag": return LOOK("color", { color: "#FFFFFF", bright: 90, beat: "half" });
    case "Instrumental": return LOOK("effect", { effect: 16, bright: 90, speed: 60 });
    default: return LOOK("color", { color: "#FFFFFF", bright: 80 });
  }
}
function parseArrangement(text) {
  const toks = String(text || "").toUpperCase().split(/[\s,>\-|/]+/).filter(Boolean);
  const names = toks.map((t) => {
    const m = t.match(/^([A-Z]+?)(\d*)$/); if (!m) return t;
    const base = SECTION_CODES[m[1]] || SECTION_CODES[m[1].slice(0, 2)] || (m[1][0] + m[1].slice(1).toLowerCase());
    return m[2] ? `${base} ${m[2]}` : base;
  });
  const lastChorus = names.map((n) => groupOf(n).group).lastIndexOf("Chorus");
  const choCount = names.filter((n) => groupOf(n).group === "Chorus").length;
  return names.map((n, i) => {
    const grp = groupOf(n).group, last = i === lastChorus && choCount > 1;
    return { name: last && /^Chorus$/.test(n) ? "Final Chorus" : n, ...defaultLook(grp, last) };
  });
}
const ARR_PRESETS = [["Standard", "I V1 PC C V2 PC C B C C O"], ["Simple", "I V1 C V2 C B C O"], ["Worship", "I V1 V2 C C B B C T E"], ["Hymn", "I V1 V2 V3 V4 E"]];
function songSheet(title, init) {
  return modal(`<h2>${esc(title)}</h2>
    <label>Song name<input type="text" id="sgName" value="${esc(init.name || "")}" placeholder="e.g. Way Maker"></label>
    <div class="row tight" style="gap:10px"><label style="flex:1">BPM<input type="number" id="sgBpm" value="${init.bpm || 100}" min="40" max="220" inputmode="numeric"></label>
      <label style="flex:1">Key / notes<input type="text" id="sgNote" value="${esc(init.note || "")}" placeholder="e.g. Key of A"></label></div>
    <label>Arrangement<input type="text" id="sgArr" class="mono" value="${esc(init.arr || ARR_PRESETS[0][1])}" autocapitalize="characters"></label>
    <div class="arr-chips">${ARR_PRESETS.map(([n, a]) => `<button class="btn sm" data-arr="${a}">${n}</button>`).join("")}</div>
    <p class="hint" style="margin:6px 0 0">I intro · V1 verse 1 · PC pre-chorus · C chorus · B bridge · T tag · IN instrumental · O outro · E ending</p>
    <div class="legend">${GROUPS_PP.map(([, g, c]) => `<span><i style="background:${c}"></i>${g}</span>`).join("")}</div>
    <div class="acts"><button class="btn" id="mNo">Cancel</button><button class="btn inv" id="mOk">${init.ok || "Create"}</button></div>`, (close) => {
    setTimeout(() => $("sgName").focus(), 50);
    $("sheet").querySelectorAll("[data-arr]").forEach((b) => (b.onclick = () => ($("sgArr").value = b.dataset.arr)));
    $("mNo").onclick = () => close(null);
    $("mOk").onclick = () => { const name = $("sgName").value.trim(); if (!name) { $("sgName").focus(); return; }
      close({ name, bpm: clamp(+$("sgBpm").value || 100, 40, 220), note: $("sgNote").value.trim(), arr: $("sgArr").value.trim() }); };
  });
}
$("songArr").onclick = async () => {
  const s = song(); if (!s) return;
  const r = await songSheet("Rebuild cues", { name: s.name, bpm: s.bpm, note: s.note, arr: s.arr || s.cues.map((c) => c.name.replace(/\s+/g, "")).join(" "), ok: "Rebuild" }); if (!r) return;
  if (!(await confirmBox("Replace this song's cues?", "Cues are rebuilt from the arrangement with default looks. Looks you set by hand will be replaced.", "Replace", true))) return;
  Object.assign(s, { name: r.name, bpm: r.bpm, note: r.note, arr: r.arr, cues: parseArrangement(r.arr) }); cueIdx = -1; editIdx = -1; saveService(svc()); renderShow();
};
$("songDup").onclick = () => { const s = svc()?.songs[songIdx]; if (!s) return; const c = JSON.parse(JSON.stringify(s)); c.id = uid(); c.name += " (copy)"; svc().songs.splice(songIdx + 1, 0, c); songIdx++; saveService(svc()); renderShow(); };
$("songDel").onclick = async () => { const s = svc()?.songs[songIdx]; if (!s || !(await confirmBox(`Remove "${s.name}" from this service?`, "", "Remove", true))) return; svc().songs.splice(songIdx, 1); songIdx = Math.max(0, songIdx - 1); cueIdx = -1; editIdx = -1; saveService(svc()); renderShow(); };
$("songUp").onclick = () => moveSong(-1); $("songDown").onclick = () => moveSong(1);
function moveSong(d) { if (!svc()) return; const a = svc().songs, j = songIdx + d; if (j < 0 || j >= a.length) return; [a[songIdx], a[j]] = [a[j], a[songIdx]]; songIdx = j; saveService(svc()); renderSetlist(); }
/* Cue editor */
function fillEffectSelect() {
  const sel = $("ceEffect"); sel.innerHTML = ""; const seen = new Set();
  [...PATTERNS].sort((a, b) => a.code - b.code).forEach((p) => { if (seen.has(p.code)) return; seen.add(p.code);
    const o = document.createElement("option"); o.value = p.code; o.textContent = `#${p.code} · ${patLabel(p.code)}`; sel.appendChild(o); });
}
function openEditor(i) {
  if (!editMode) { editMode = true; $("modeEdit").classList.add("on"); $("modeLive").classList.remove("on"); $("editTools").hidden = false; $("cueGrid").classList.add("editing"); }
  editIdx = i; const c = song()?.cues[i]; if (!c) return; fillEffectSelect();
  $("cueEdit").hidden = false; $("ceName").value = c.name; $("ceMode").value = c.mode; $("ceColor").value = c.color; $("ceEffect").value = c.effect;
  $("ceCct").value = c.cct; $("ceBright").value = c.bright; $("ceBrightV").textContent = c.bright + "%"; $("ceSpeed").value = c.speed; $("ceSpeedV").textContent = c.speed + "%";
  $("ceFade").value = c.fade; $("ceBeat").value = c.beat; $("ceWho").value = c.who || "sel"; $("ceAudio").value = c.audioMode || "pulse";
  fillPreviewFields(c.effect); showModeFields(c.mode); renderCues();
  $("cueEdit").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function showModeFields(m) { document.querySelectorAll("#cueEdit [data-m]").forEach((el) => (el.hidden = !el.dataset.m.split(" ").includes(m))); }
Object.entries(KINDS).forEach(([k, n]) => { const o = document.createElement("option"); o.value = k; o.textContent = n; $("ceKind").appendChild(o); });
function fillPreviewFields(code) { const info = patInfo(code); $("ceKind").value = info.kind; const c = info.colors; $("ceP1").value = c[0] || "#FFFFFF"; $("ceP2").value = c[1] || c[0] || "#000000"; $("ceP3").value = c[2] || c[1] || c[0] || "#000000"; }
$("ceP").onclick = () => { const c = song()?.cues[editIdx]; if (!c) return; const m = DB.lib.patterns[c.effect] || {};
  DB.lib.patterns[c.effect] = { ...m, kind: $("ceKind").value, colors: [...new Set([$("ceP1").value, $("ceP2").value, $("ceP3").value].map((x) => x.toUpperCase()))] };
  saveLib("patterns"); renderCues(); toast(`Preview saved for ${patLabel(c.effect)} (shared)`); };
$("ceKind").onchange = () => $("ceP").click();
$("ceEffect").addEventListener("change", () => fillPreviewFields(+$("ceEffect").value));
bindStrip($("cePreviewStrip"), () => { const c = song()?.cues[editIdx]; return c ? (c.mode === "off" ? { off: true } : cueLook(c)) : { off: true }; });
function editCue() {
  const c = song()?.cues[editIdx]; if (!c) return;
  Object.assign(c, { name: $("ceName").value || "Cue", mode: $("ceMode").value, color: $("ceColor").value.toUpperCase(), effect: +$("ceEffect").value, cct: +$("ceCct").value,
    bright: +$("ceBright").value, speed: +$("ceSpeed").value, fade: clamp(+$("ceFade").value || 0, 0, 20), beat: $("ceBeat").value, who: $("ceWho").value, audioMode: $("ceAudio").value });
  $("ceBrightV").textContent = c.bright + "%"; $("ceSpeedV").textContent = c.speed + "%"; showModeFields(c.mode); saveService(svc()); renderCues();
}
["ceName", "ceMode", "ceColor", "ceEffect", "ceCct", "ceBright", "ceSpeed", "ceFade", "ceBeat", "ceWho", "ceAudio"].forEach((id) => { $(id).addEventListener("input", editCue); $(id).addEventListener("change", editCue); });
$("ceClose").onclick = () => { editIdx = -1; $("cueEdit").hidden = true; renderCues(); };
$("ceTry").onclick = () => goCue(editIdx);
$("ceDel").onclick = async () => { if (!(await confirmBox("Delete this cue?", "", "Delete", true))) return; song().cues.splice(editIdx, 1); editIdx = -1; cueIdx = -1; saveService(svc()); renderShow(); };
$("ceLeft").onclick = () => moveCue(-1); $("ceRight").onclick = () => moveCue(1);
function moveCue(d) { const a = song().cues, j = editIdx + d; if (j < 0 || j >= a.length) return; [a[editIdx], a[j]] = [a[j], a[editIdx]]; editIdx = j; cueIdx = j; saveService(svc()); renderCues(); }
function currentLook() { const l = targets()[0] || lights[0]; if (!l) return null; const s = l.state;
  return { mode: ["effect", "cct"].includes(s.mode) ? s.mode : "color", color: s.color, effect: s.effect ?? 16, cct: s.cct, bright: s.bright, speed: s.speed }; }
$("ceGrab").onclick = () => { const lk = currentLook(); if (!lk) { toast("Connect a light first."); return; } Object.assign(song().cues[editIdx], lk); saveService(svc()); openEditor(editIdx); };
$("cueAdd").onclick = () => { if (!song()) { toast("Add a song first."); return; } const lk = currentLook() || {}; song().cues.push({ name: `Cue ${song().cues.length + 1}`, ...LOOK("color", lk) }); saveService(svc()); openEditor(song().cues.length - 1); };
$("cueAddBlank").onclick = () => { if (!song()) { toast("Add a song first."); return; } song().cues.push({ name: `Cue ${song().cues.length + 1}`, ...LOOK("color") }); saveService(svc()); openEditor(song().cues.length - 1); };

/* Show engine: cue playback, fades, beat pulse */
let fadeTimer = null, beatTimer = null, beatCount = 0, activeCue = null;
function stopShowFx() { clearInterval(fadeTimer); fadeTimer = null; clearInterval(beatTimer); beatTimer = null; clearInterval(xfTimer); xfTimer = null; clearInterval(rampTimer); rampTimer = null; }
const cueTargets = (c) => (c.who === "all" ? lights : lights.filter((l) => selected.has(l.id))).filter((l) => l.char);
const scaleHex = (hex, b) => hexToRgb(hex).map((x) => Math.round(x * b / 100));
function goCue(i) {
  const s = song(); if (!s || !s.cues.length) return;
  i = clamp(i, 0, s.cues.length - 1); cueIdx = i; const c = s.cues[i]; activeCue = c; takeOver(c.mode === "audio" ? "audio" : "");
  renderCues();
  const T = cueTargets(c);
  if (!T.length) { toast(lights.length ? "No target lights for this cue. Check your selection." : "Connect a light to run cues."); return; }
  if (c.mode === "off") T.forEach((l) => l.power(false));
  else if (c.mode === "audio") {
    AUD.mode = c.audioMode || "pulse"; AUD.source = "live"; AUD.who = c.who || "sel"; AUD.max = c.bright; syncAudioUi();
    setColour({ hex: c.color }, false);
    if (!audio) startAudio(); 
  }
  else if (c.mode === "effect") { T.forEach((l) => { l.state.speed = c.speed; l.effect(c.effect); l.bright(c.bright); }); startBeat(c, T); }
  else if (c.mode === "cct") { T.forEach((l) => { l.cct(c.cct, cctRgb); l.bright(c.bright); }); startBeat(c, T); }
  else {
    // Colour cues bake brightness into RGB so fades and pulses stay smooth
    T.forEach((l) => { l.prep(); l.state.bright = c.bright; });
    if (c.fade > 0) fadeTo(T, c.color, c.bright, c.fade, () => startBeat(c, T));
    else { const rgb = scaleHex(c.color, c.bright); T.forEach((l) => { l.state.mode = "color"; l.state.color = c.color; l.showRgb(rgb); }); startBeat(c, T); }
    setColour({ hex: c.color }, false);
  }
  $("gBright").value = c.bright; $("gBrightV").textContent = c.bright;
  log(`Cue: ${s.name} → ${c.name}`, "ok"); updateLightRows();
}
function fadeTo(T, hex, bright, secs, done) {
  const steps = Math.max(1, Math.round(secs * 15)); let n = 0;
  const from = T.map((l) => (l.state.on ? l._shown || (l.state.mode === "color" ? scaleHex(l.state.color, l.state.bright) : l.state.mode === "cct" ? cctRgbOf(l.state.cct).map((x) => Math.round(x * l.state.bright / 100)) : [0, 0, 0]) : [0, 0, 0]));
  const to = scaleHex(hex, bright);
  T.forEach((l) => { l.state.mode = "color"; l.state.color = hex; });
  fadeTimer = setInterval(() => {
    n++; const t = n / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    T.forEach((l, k) => { const rgb = from[k].map((v, j) => Math.round(v + (to[j] - v) * e)); l.showRgb(rgb, true); });
    if (n >= steps) { clearInterval(fadeTimer); fadeTimer = null; done && done(); }
  }, 1000 / 15);
}
function startBeat(c, T) {
  if (c.beat === "none" || !song()?.bpm) return;
  const every = { pulse: 1, flash: 1, half: 2, bar: 4 }[c.beat] || 1, ms = 60000 / song().bpm; beatCount = 0;
  beatTimer = setInterval(() => {
    beatCount++; const dot = $("beatDot"); dot.classList.add("hit"); setTimeout(() => dot.classList.remove("hit"), 90);
    if (beatCount % every || holdFx) return;
    const hold = Math.min(ms * every * 0.45, 220);
    if (c.mode === "color") {
      const hi = scaleHex(c.color, c.bright), lo = scaleHex(c.color, c.beat === "flash" ? 0 : Math.round(c.bright * 0.35));
      T.forEach((l) => l.showRgb(hi));
      setTimeout(() => { if (beatTimer && !holdFx) T.forEach((l) => l.showRgb(lo)); }, hold);
    } else {
      T.forEach((l) => l.send(CMD.bright(c.bright)));
      setTimeout(() => T.forEach((l) => l.send(CMD.bright(c.beat === "flash" ? 1 : Math.max(1, Math.round(c.bright * 0.35))))), hold);
    }
  }, ms);
}
function restartBeat() { if (activeCue && beatTimer) { clearInterval(beatTimer); beatTimer = null; startBeat(activeCue, cueTargets(activeCue)); } }
$("cueNext").onclick = () => goCue(cueIdx + 1);
$("clearHouse").onclick = () => { takeOver(); cueIdx = -1; renderCues(); applyLookTo(lights.filter((l) => l.char), { mode: "color", color: "#FFB066", bright: 70, speed: 50 }, true); $("liveCue").textContent = "House lights"; };
$("holdBeat").onclick = () => { takeOver(); targets().forEach((l) => l.restore()); toast("Stopped beat pulse, fades, audio and FX"); };
$("cuePrev").onclick = () => goCue(cueIdx - 1);
let taps = [];
$("tapTempo").onclick = () => {
  const now = performance.now(); taps = taps.filter((t) => now - t < 3000); taps.push(now);
  if (taps.length >= 3 && song()) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); song().bpm = clamp(Math.round(60000 / iv), 40, 220); $("songBpm").value = song().bpm; saveService(svc()); renderSetlist(); restartBeat(); }
  const dot = $("beatDot"); dot.classList.add("hit"); setTimeout(() => dot.classList.remove("hit"), 90);
};

/* ---------------------------------------------------------------------
   14. SCHEDULE
   --------------------------------------------------------------------- */
const DAYS = [["M", 1], ["T", 2], ["W", 4], ["T", 8], ["F", 16], ["S", 32], ["S", 64]];
function dayPicker(id, init) { const el = $(id); el.dataset.mask = init;
  DAYS.forEach(([d, bit]) => { const b = document.createElement("button"); b.className = "btn sm" + (init & bit ? " on" : ""); b.textContent = d;
    b.onclick = () => { let m = +el.dataset.mask; m ^= bit; el.dataset.mask = m; b.classList.toggle("on", !!(m & bit)); }; el.appendChild(b); }); }
dayPicker("onDays", 127); dayPicker("offDays", 127);
$("syncClock").onclick = () => { const d = new Date(); if (each((l) => l.send(CMD.clock(d.getHours(), d.getMinutes(), d.getSeconds(), d.getDay() || 7)))) toast("Clock synced"); };
function sendTimer(isOff) {
  const [h, m] = $(isOff ? "offTime" : "onTime").value.split(":").map(Number); let days = +$(isOff ? "offDays" : "onDays").dataset.mask;
  if ($(isOff ? "offEn" : "onEn").checked) days += 0x80;
  if (each((l) => l.send(CMD.timer(h, m, isOff, days)))) toast(`${isOff ? "Off" : "On"} timer sent`);
}
$("onSet").onclick = () => sendTimer(false); $("offSet").onclick = () => sendTimer(true);
setInterval(() => ($("nowClock").textContent = new Date().toLocaleTimeString()), 1000);

/* ---------------------------------------------------------------------
   15. CONSOLE
   --------------------------------------------------------------------- */
function sendRaw(str) {
  const bytes = str.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x.replace(/^0x/i, ""), 16));
  if (!bytes.length || bytes.some((b) => isNaN(b) || b < 0 || b > 255)) { toast("Enter hex bytes like: 7e 00 05 03 ff 00 00 00 ef"); return; }
  each((l) => l.send(bytes));
}
$("rawSend").onclick = () => sendRaw($("rawHex").value);
$("rawHex").onkeydown = (e) => { if (e.key === "Enter") sendRaw(e.target.value); };
document.querySelectorAll("[data-raw]").forEach((b) => (b.onclick = () => sendRaw(b.dataset.raw)));
$("logClear").onclick = () => ($("log").innerHTML = "");

/* ---------------------------------------------------------------------
   INTEGRATIONS: ProPresenter + OBS via the GMS Lighting Bridge
   The bridge (bridge/ folder) runs on the ProPresenter / OBS computer and
   broadcasts slide-group and scene changes on a channel derived from the passcode.
   --------------------------------------------------------------------- */
const BR = { ch: null, last: 0, info: {}, lastEvent: "", ppGroupKey: "",
  followPP: local.get("followPP", true), followOBS: local.get("followOBS", true) };
async function sha256hex(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
async function startBridgeListener() {
  if (!DB.sb || !DB.code || !crypto.subtle) return;
  try { if (BR.ch) DB.sb.removeChannel(BR.ch); } catch (e) {}
  const topic = "gms-" + (await sha256hex(DB.code + ":gms-bridge")).slice(0, 24);
  BR.ch = DB.sb.channel(topic)
    .on("broadcast", { event: "hello" }, ({ payload }) => { BR.last = Date.now(); BR.info = payload || {}; updateBridgeUi(); })
    .on("broadcast", { event: "pp" }, ({ payload }) => { BR.last = Date.now(); onProPresenter(payload || {}); })
    .on("broadcast", { event: "obs" }, ({ payload }) => { BR.last = Date.now(); onObs(payload || {}); })
    .subscribe();
  setInterval(updateBridgeUi, 5000);
}
const bridgeOnline = () => Date.now() - BR.last < 15000;
function updateBridgeUi() {
  const on = bridgeOnline(), ppOn = on && BR.info.pp === "connected";
  const b = $("ppFollow"); b.hidden = !ppOn && !BR.followPPShown;
  if (ppOn) BR.followPPShown = true;
  b.classList.toggle("on", BR.followPP); b.textContent = BR.followPP ? "● Following ProPresenter" : "○ Follow ProPresenter";
  b.title = ppOn ? `${BR.info.ppVersion || "ProPresenter"} on ${BR.info.host || "bridge"}` : "Bridge offline";
  b.disabled = !ppOn;
  const st = $("brStatus"); if (st) st.innerHTML = bridgeStatusHtml();
}
function bridgeStatusHtml() {
  if (!DB.code) return "Unlock with the passcode to use integrations.";
  if (!bridgeOnline()) return `<span style="color:#ff8080">● Bridge offline</span>. Start it on the ProPresenter / OBS computer (see bridge/README).`;
  const i = BR.info;
  return `<span style="color:#fff">● Bridge online</span> on <b>${esc(i.host || "?")}</b> · ProPresenter: <b>${esc(i.pp || "?")}</b> · OBS: <b>${esc(i.obs || "?")}</b>${i.obsScene ? ` (${esc(i.obsScene)})` : ""}${BR.lastEvent ? `<br>Last: ${esc(BR.lastEvent)}` : ""}`;
}
$("ppFollow").onclick = () => { BR.followPP = !BR.followPP; local.set("followPP", BR.followPP); BR.ppGroupKey = ""; updateBridgeUi(); toast(BR.followPP ? "Lights now follow ProPresenter" : "Stopped following ProPresenter"); };

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function onProPresenter(p) {
  BR.lastEvent = `ProPresenter · ${p.presentation || "?"} › ${p.group || "(no group)"}`;
  if (!BR.followPP || !svc()) return;
  // 1. Find the song in this service with the same name as the ProPresenter presentation
  const items = svc().songs, pn = norm(p.presentation);
  let si = items.findIndex((x) => !isHdr(x) && norm(x.name) === pn);
  if (si < 0 && pn) si = items.findIndex((x) => !isHdr(x) && (norm(x.name).includes(pn) || pn.includes(norm(x.name))) && norm(x.name).length > 2);
  if (si < 0) { $("liveCue").textContent = `ProPresenter: "${p.presentation}" isn't in this setlist`; return; }
  if (si !== songIdx) { songIdx = si; cueIdx = -1; editIdx = -1; renderSetlist(); renderCues(); BR.ppGroupKey = ""; }
  // 2. Only react when the slide group changes (several slides in one Chorus = one cue)
  const gk = p.uuid + ":" + norm(p.group);
  if (gk === BR.ppGroupKey) return; BR.ppGroupKey = gk;
  if (!p.group) return;
  const cues = song().cues, g = norm(p.group), cat = groupOf(p.group).group;
  // Search forward first (songs move forward), exact name before same section type, then wrap around
  const fwd = (pred) => { for (let i = cueIdx + 1; i < cues.length; i++) if (pred(cues[i])) return i; return -1; };
  const any = (pred) => cues.findIndex(pred);
  const exact = (c) => norm(c.name) === g, same = (c) => cat !== "Other" && groupOf(c.name).group === cat;
  let ci = fwd(exact); if (ci < 0) ci = fwd(same); if (ci < 0) ci = any(exact); if (ci < 0) ci = any(same);
  if (ci >= 0 && ci !== cueIdx) goCue(ci);
}

function obsMap() { return (DB.lib.aliases && DB.lib.aliases.__obs) || {}; }
function onObs(p) {
  BR.lastEvent = `OBS · ${p.scene}`; BR.info.obsScene = p.scene; updateBridgeUi();
  if (!BR.followOBS || p.initial) return;
  const act = obsMap()[p.scene]; if (!act) return;
  const T = lights.filter((l) => l.char);
  if (act === "blackout") { $("blackout").click(); }
  else if (act === "house") { $("clearHouse").click(); }
  else if (act.startsWith("scene:")) { const sc = (DB.lib.scenes || []).find((x) => x.id === act.slice(6)); if (sc) { applyLookTo(T, sc, true); } }
  toast(`OBS → ${p.scene}`);
}
function integrationsHtml() {
  const scenes = [...new Set([...(BR.info.obsScenes || []), ...Object.keys(obsMap())])];
  const opts = (v) => `<option value="">Do nothing</option><option value="blackout"${v === "blackout" ? " selected" : ""}>Blackout</option><option value="house"${v === "house" ? " selected" : ""}>House lights</option>` +
    (DB.lib.scenes || []).map((s) => `<option value="scene:${s.id}"${v === "scene:" + s.id ? " selected" : ""}>Scene: ${esc(s.name)}</option>`).join("");
  return `<details style="margin-top:12px" ${DB.code ? "open" : ""}><summary class="hint" style="cursor:pointer">ProPresenter &amp; OBS</summary>
    <p class="hint" id="brStatus" style="margin:8px 0">${bridgeStatusHtml()}</p>
    <label class="check" style="flex-direction:row;margin:6px 0"><input type="checkbox" id="stFollowPP" ${BR.followPP ? "checked" : ""}> Follow ProPresenter: when a slide group changes (Verse, Chorus…), run the matching cue in the song with the same name</label>
    <label class="check" style="flex-direction:row;margin:6px 0"><input type="checkbox" id="stFollowOBS" ${BR.followOBS ? "checked" : ""}> Follow OBS scenes</label>
    ${scenes.length ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;margin-top:6px">${scenes.map((sc) => `<span>${esc(sc)}</span><select data-obs="${esc(sc)}">${opts(obsMap()[sc] || "")}</select>`).join("")}</div>`
      : `<p class="hint">OBS scenes appear here once the bridge connects to OBS.</p>`}
  </details>`;
}
function wireIntegrations() {
  if (!$("stFollowPP")) return;
  $("stFollowPP").onchange = (e) => { BR.followPP = e.target.checked; local.set("followPP", BR.followPP); BR.ppGroupKey = ""; updateBridgeUi(); };
  $("stFollowOBS").onchange = (e) => { BR.followOBS = e.target.checked; local.set("followOBS", BR.followOBS); };
  $("sheet").querySelectorAll("[data-obs]").forEach((s) => (s.onchange = () => {
    DB.lib.aliases = DB.lib.aliases || {}; const m = { ...obsMap() };
    if (s.value) m[s.dataset.obs] = s.value; else delete m[s.dataset.obs];
    DB.lib.aliases.__obs = m; saveLib("aliases");
  }));
}

/* ---- Service actions: rename, date, duplicate, delete ---- */
function serviceMenu(i) {
  const s = DB.services[i]; if (!s) return;
  modal(`<h2>Service</h2>
    <label>Name<input type="text" id="smName" value="${esc(s.name || "")}" placeholder="Untitled Service"></label>
    <label>Date<input type="date" id="smDate" value="${esc(s.service_date || "")}"></label>
    <label>Notes<textarea id="smNotes" rows="2">${esc(s.notes || "")}</textarea></label>
    <div class="acts" style="justify-content:space-between">
      <span class="row tight" style="gap:8px"><button class="btn danger" id="smDel">Delete</button><button class="btn" id="smDup">Duplicate</button></span>
      <span class="row tight" style="gap:8px"><button class="btn" id="mNo">Cancel</button><button class="btn inv" id="smSave">Save</button></span>
    </div>`, (close) => {
    setTimeout(() => { $("smName").focus(); $("smName").select(); }, 50);
    $("mNo").onclick = () => close();
    const save = () => { s.name = $("smName").value.trim() || "Untitled Service"; s.service_date = $("smDate").value || s.service_date; s.notes = $("smNotes").value; saveService(s); sortServices(); svcIdx = DB.services.indexOf(s); close(); renderShow(); };
    $("smSave").onclick = save; $("smName").onkeydown = (e) => { if (e.key === "Enter") save(); };
    $("smDup").onclick = () => { close(); svcIdx = i; setTimeout(() => $("svcDup").click(), 30); };
    $("smDel").onclick = () => { close(); svcIdx = i; setTimeout(() => $("svcDel").click(), 30); };
  });
}

/* ---------------------------------------------------------------------
   16. KEYBOARD + BOOT
   --------------------------------------------------------------------- */
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) || !$("modal").hidden) return;
  const k = e.key.toLowerCase();
  if ($("v-show").classList.contains("on")) {
    if (e.key === " " || e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); goCue(cueIdx + 1); return; }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); goCue(cueIdx - 1); return; }
    if (/^[1-9]$/.test(e.key)) { goCue(+e.key - 1); return; }
    if (k === "t") { $("tapTempo").click(); return; }
  }
  if ($("v-patterns").classList.contains("on")) { if (e.key === "ArrowRight") labSet(labCode + 1); if (e.key === "ArrowLeft") labSet(labCode - 1); }
  if (k === "b") $("blackout").click();
  if (k === "a" && !e.ctrlKey && !e.metaKey) toggleAudio();
  if (!e.repeat && (k === "f" || k === "s")) startHold(k === "f" ? "flash" : "strobe");
});
document.addEventListener("keyup", (e) => { const k = e.key.toLowerCase(); if ((k === "f" || k === "s") && holdFx) endHold(false); });

function renderAll(keepEditor) {
  if (svcIdx >= DB.services.length) svcIdx = 0;
  renderLights(); renderShow(); renderScenes(); swatchGrid($("recent"), DB.lib.recent || []);
  if ($("v-patterns").classList.contains("on")) renderPatterns();
  if (keepEditor && editIdx >= 0 && song()?.cues[editIdx]) openEditor(editIdx);
}

swatchGrid($("swatches"), SW);
setColour({ hex: "#FFFFFF" }, false);
labSet(0, false);
syncAudioUi(); $("audWho").value = AUD.who;
if (navigator.mediaDevices?.enumerateDevices) listInputs();
sortServices();
renderAll();
log("Ready. Connect a light to begin.");
const btp = bluetoothProblem(); if (btp) { showBtWarn(btp); log(btp.replace(/<[^>]+>/g, ""), "err"); }
initCloud().finally(() => createServiceSheet({ start: true }));

window.__gms = { onProPresenter, onObs, state: () => ({ song: song()?.name, cue: song()?.cues[cueIdx]?.name, cueIdx }) };
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
