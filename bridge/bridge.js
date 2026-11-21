// GMS Lighting Bridge
// Watches ProPresenter (slide groups) and OBS (program scene) on this network
// and relays changes to the GMS Lighting Dashboard through Supabase Realtime.
// Nothing is sent to the lights from here: the dashboard decides what to do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import OBSWebSocket from "obs-websocket-js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(DIR, "config.json");
const t = () => new Date().toLocaleTimeString();
const say = (...a) => console.log(`[${t()}]`, ...a);

if (!fs.existsSync(CFG_PATH)) {
  fs.copyFileSync(path.join(DIR, "config.example.json"), CFG_PATH);
  console.log("\nCreated config.json. Open it, type the team passcode in \"passcode\",");
  console.log("check the ProPresenter port and OBS settings, then start the bridge again.\n");
  process.exit(0);
}
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const code = String(cfg.passcode || "").trim().toUpperCase();
if (!code) { console.log("\nconfig.json has no passcode. Add the team passcode and start again.\n"); process.exit(1); }

const topic = "gms-" + crypto.createHash("sha256").update(code + ":gms-bridge").digest("hex").slice(0, 24);
const SB = cfg.supabaseUrl.replace(/\/$/, "");
const HDR = { apikey: cfg.supabaseKey, "Content-Type": "application/json" };

async function fetchJson(url, opts = {}, ms = 2500) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const txt = await r.text(); return txt ? JSON.parse(txt) : null; }
  finally { clearTimeout(tm); }
}
async function send(event, payload) {
  try {
    await fetchJson(`${SB}/realtime/v1/api/broadcast`, { method: "POST", headers: HDR,
      body: JSON.stringify({ messages: [{ topic, event, payload: { ...payload, at: Date.now() }, private: false }] }) }, 4000);
  } catch (e) { say("Could not reach the dashboard (internet?):", e.message); }
}

/* ---------------- ProPresenter (official API, 7.9+) ---------------- */
const pp = { ok: false, version: "", lastKey: "", lastGroupKey: "", pres: null, presUuid: "", presAt: 0 };
const PP = cfg.propresenter || {};
const ppBase = `http://${PP.host || "127.0.0.1"}:${PP.port || 50001}`;

function slideMap(presentation) {
  const out = [];
  for (const g of presentation?.groups || []) for (const s of g.slides || []) out.push({ group: g.name || "", text: (s.text || "").slice(0, 80), label: s.label || "" });
  return out;
}
async function ppTick() {
  try {
    if (!pp.ok) {
      const v = await fetchJson(`${ppBase}/version`);
      pp.ok = true; pp.version = v?.host_description || "ProPresenter";
      say(`ProPresenter connected (${pp.version} at ${ppBase})`);
    }
    const si = await fetchJson(`${ppBase}/v1/presentation/slide_index`);
    const pi = si?.presentation_index;
    if (!pi || pi.index == null || !pi.presentation_id) return;
    const uuid = pi.presentation_id.uuid || pi.presentation_id.name || "";
    const key = uuid + ":" + pi.index;
    if (key === pp.lastKey) return;
    pp.lastKey = key;
    if (uuid !== pp.presUuid || Date.now() - pp.presAt > 30000) {
      const a = await fetchJson(`${ppBase}/v1/presentation/active`);
      pp.pres = a?.presentation || null; pp.presUuid = uuid; pp.presAt = Date.now();
    }
    const map = slideMap(pp.pres);
    const slide = map[pi.index] || {};
    const name = pi.presentation_id.name || pp.pres?.id?.name || "";
    const groupKey = uuid + ":" + (slide.group || "#" + pi.index);
    const groupChanged = groupKey !== pp.lastGroupKey; pp.lastGroupKey = groupKey;
    say(`ProPresenter  ${name}  ›  ${slide.group || "(no group)"}  [slide ${pi.index + 1}]`);
    await send("pp", { presentation: name, uuid, index: pi.index, group: slide.group || "", label: slide.label || "", text: slide.text || "", groupChanged });
  } catch (e) {
    if (pp.ok) say(`ProPresenter not reachable at ${ppBase} (${e.message}). Retrying…`);
    pp.ok = false; pp.lastKey = ""; await new Promise((r) => setTimeout(r, 3000));
  }
}
async function ppLoop() { for (;;) { await ppTick(); await new Promise((r) => setTimeout(r, 250)); } }

/* ---------------- OBS (obs-websocket v5, built into OBS 28+) ---------------- */
const OB = cfg.obs || {};
const obsState = { ok: false, scenes: [], scene: "" };
const obs = new OBSWebSocket();
obs.on("CurrentProgramSceneChanged", ({ sceneName }) => { obsState.scene = sceneName; say(`OBS scene  ›  ${sceneName}`); send("obs", { scene: sceneName }); });
obs.on("SceneListChanged", ({ scenes }) => { obsState.scenes = (scenes || []).map((s) => s.sceneName).reverse(); });
obs.on("ConnectionClosed", () => { if (obsState.ok) say("OBS disconnected. Retrying…"); obsState.ok = false; setTimeout(obsConnect, 5000); });
async function obsConnect() {
  try {
    await obs.connect(OB.url || "ws://127.0.0.1:4455", OB.password || undefined);
    obsState.ok = true;
    const list = await obs.call("GetSceneList");
    obsState.scenes = (list.scenes || []).map((s) => s.sceneName).reverse();
    const cur = await obs.call("GetCurrentProgramScene");
    obsState.scene = cur.currentProgramSceneName || cur.sceneName || "";
    say(`OBS connected (${OB.url}). Scenes: ${obsState.scenes.join(", ")}`);
    send("obs", { scene: obsState.scene, initial: true });
  } catch (e) {
    if (!obsState.ok) { /* quiet retry */ }
    obsState.ok = false;
    if (/auth/i.test(e.message || "")) say("OBS refused the password. Check obs.password in config.json.");
    setTimeout(obsConnect, 5000);
  }
}

/* ---------------- Heartbeat so the dashboard shows status ---------------- */
async function hello() {
  await send("hello", { host: os.hostname(), pp: PP.enabled === false ? "off" : pp.ok ? "connected" : "offline", ppVersion: pp.version,
    obs: OB.enabled === false ? "off" : obsState.ok ? "connected" : "offline", obsScenes: obsState.scenes, obsScene: obsState.scene });
}

/* ---------------- Start ---------------- */
console.log("\n  GMS Lighting Bridge\n  -------------------");
const check = await fetchJson(`${SB}/rest/v1/rpc/gms_check`, { method: "POST", headers: HDR, body: JSON.stringify({ code }) }, 8000).catch((e) => { console.log("  Can't reach the database: " + e.message); process.exit(1); });
if (check !== true) { console.log("  Wrong passcode in config.json.\n"); process.exit(1); }
say("Passcode OK. Sending to the dashboard.");
if (PP.enabled !== false) ppLoop(); else say("ProPresenter disabled in config.json");
if (OB.enabled !== false) obsConnect(); else say("OBS disabled in config.json");
hello(); setInterval(hello, 5000);
say("Running. Leave this window open during the service. Press Ctrl+C to stop.\n");
