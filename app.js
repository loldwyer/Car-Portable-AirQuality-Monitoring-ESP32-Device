// ===== GPS → ThingSpeak (fields 7 & 8). ESP32 pushes fields 1–6 after /start =====
"use strict";

// ---- Tiny error catcher so we see issues on the page ----
window.addEventListener("error", (e) => {
  const el = document.querySelector("#gpsStatus");
  if (el) el.textContent = `JS error: ${e.message}`;
  console.error(e.error || e.message);
});

// --- CONFIG ---
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const PUSH_PERIOD   = 80_000; // 80 seconds
const ESP32_BASE    = "";     // e.g., "http://192.168.4.1"

// --- State ---
let mapLeaflet = null;
let marker = null;
let accuracyCircle = null;
let polyline = null;
let path = [];               // [ [lat, lng], ... ] (restored from localStorage)
let gpsWatchId = null;
let safetyTimer = null;
let lastCoords = null;
let lastPushMs = 0;
let follow = true;

let DEMO_MODE = false;       // Demo mode (fake movement)
let demoTimer = null;

const MIN_MOVE_METERS = 2;   // ignore tiny GPS jitter
const DEMO_CLEAR_PATH_ON_START = true;

// --- UI helpers ---
const $ = (s) => document.querySelector(s);
const log = (...a) => console.log(...a);
const setStatus = (msg) => { const el = $('#gpsStatus'); if (el) el.textContent = msg; };
const setEsp    = (msg) => { const el = $('#espStatus'); if (el) el.textContent = msg; };

// --- Restore previous breadcrumb (optional) ---
try {
  const stored = JSON.parse(localStorage.getItem('gps_path') || '[]');
  if (Array.isArray(stored)) path = stored.slice();
} catch { /* ignore */ }

// --- Map ---
function ensureMapInit() {
  if (mapLeaflet) return;
  const el = document.getElementById('map');
  if (!el) return;

  if (typeof L === "undefined") {
    setStatus("Leaflet not loaded (L is undefined). Check the CDN script tag.");
    return;
  }

  mapLeaflet = L.map(el, { zoomControl: true }).setView([53.3498, -6.2603], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(mapLeaflet);

  polyline = L.polyline(path, { weight: 4, opacity: 0.9 }).addTo(mapLeaflet);
  if (path.length >= 2) {
    mapLeaflet.fitBounds(polyline.getBounds(), { padding: [30, 30] });
  }
}

function updateVisuals(lat, lon, accuracy) {
  if (!mapLeaflet) return;

  if (!marker) {
    marker = L.marker([lat, lon], { title: 'You are here' }).addTo(mapLeaflet);
  } else {
    marker.setLatLng([lat, lon]);
  }

  if (!accuracyCircle) {
    accuracyCircle = L.circle([lat, lon], { radius: accuracy || 0, stroke: false, fillOpacity: 0.1 }).addTo(mapLeaflet);
  } else {
    accuracyCircle.setLatLng([lat, lon]).setRadius(accuracy || 0);
  }

  marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy||0)} m`);

  if (follow) {
    mapLeaflet.setView([lat, lon], Math.max(mapLeaflet.getZoom(), 16), { animate: true });
  }
}

// --- URL helpers ---
function sameOriginUrl(path) {
  if (!ESP32_BASE) return path.startsWith("/") ? path : `/${path}`;
  return `${ESP32_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
function isHttpsPage() { return location.protocol === "https:"; }
function isHttpTarget(url) {
  try { return new URL(url, location.href).protocol === "http:"; } catch { return false; }
}

// --- ESP32 control (/start, /stop) ---
async function espCall(path) {
  const url = sameOriginUrl(path);
  if (isHttpsPage() && isHttpTarget(url)) {
    throw new Error("Blocked: page is HTTPS but ESP32 is HTTP. Host this page on ESP32 (HTTP) or use an HTTPS proxy.");
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}
async function espStart() {
  try { setEsp("starting…"); await espCall("/start"); setEsp("running"); }
  catch (e) { setEsp(e.message); }
}
async function espStop() {
  try { setEsp("stopping…"); await espCall("/stop"); setEsp("idle"); }
  catch (e) { setEsp(e.message); }
}

// --- ThingSpeak push (GPS only) ---
async function sendToThingSpeakGPS(lat, lon) {
  const params = new URLSearchParams({ api_key: TS_WRITE_KEY, field7: String(lat), field8: String(lon) });
  const url = `https://api.thingspeak.com/update?${params.toString()}`;
  log("TS GPS payload:", { field7: lat, field8: lon, url: url.replace(TS_WRITE_KEY, '***') });
  const res = await fetch(url, { method: "GET" });
  const text = (await res.text()).trim();
  if (text === "0") throw new Error("ThingSpeak rejected update (rate limit or bad key/fields).");
  return text;
}

async function pushGps(reason = "timer") {
  if (DEMO_MODE) { setStatus("Demo mode: not pushing to ThingSpeak."); return; }
  if (!lastCoords) { setStatus("Waiting for GPS fix…"); return; }
  const now = Date.now();
  if (reason !== "manual" && now - lastPushMs < PUSH_PERIOD) {
    const left = Math.max(0, PUSH_PERIOD - (now - lastPushMs));
    log(`Skip push (${reason}); ${Math.round(left/1000)}s left`);
    return;
  }
  try {
    const { latitude, longitude } = lastCoords;
    const entry = await sendToThingSpeakGPS(latitude, longitude);
    lastPushMs = now;
    setStatus(`Pushed #${entry} at ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(`Push failed: ${e.message}`);
    console.error(e);
  }
}

// --- Geolocation ---
function maybeAppendPoint(lat, lon) {
  const last = path[path.length - 1];
  if (!last) return true;
  const dist = mapLeaflet ? mapLeaflet.distance([lat, lon], last) : 9999;
  return dist > MIN_MOVE_METERS;
}

function handlePosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords || {};
  if (latitude == null || longitude == null) return;

  lastCoords = { latitude, longitude, accuracy, t: Date.now() };
  $('#latDisp').textContent = latitude.toFixed(6);
  $('#lonDisp').textContent = longitude.toFixed(6);

  ensureMapInit();
  if (maybeAppendPoint(latitude, longitude)) {
    path.push([latitude, longitude]);
    if (polyline) polyline.addLatLng([latitude, longitude]);
    localStorage.setItem('gps_path', JSON.stringify(path));
  }
  updateVisuals(latitude, longitude, accuracy);

  if (lastPushMs === 0) pushGps("first-fix");
  else pushGps("movement");
}

function startTest() {
  ensureMapInit();

  if (!('geolocation' in navigator)) { setStatus("Geolocation not supported on this device."); return; }
  if (gpsWatchId != null)            { setStatus("Already running."); return; }

  espStart(); // ESP32 begins its own periodic pushes (fields 1–6)

  setStatus("Starting… allow location access.");
  gpsWatchId = navigator.geolocation.watchPosition(
    handlePosition,
    (err) => setStatus(`GPS error: ${err.message || err.code}`),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );

  if (!safetyTimer) safetyTimer = setInterval(() => pushGps("timer"), PUSH_PERIOD);
}

function stopTest() {
  if (gpsWatchId != null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
  if (safetyTimer)        { clearInterval(safetyTimer); safetyTimer = null; }
  espStop();
  setStatus("Stopped."); setEsp("idle");
}

function pushNowManual() {
  if (!lastCoords) { setStatus("No GPS fix yet."); return; }
  pushGps("manual");
}

function toggleFollow() {
  follow = !follow;
  const btn = $('#toggleFollowBtn');
  if (btn) btn.textContent = `Follow: ${follow ? 'on' : 'off'}`;
  if (follow && marker) {
    const { lat, lng } = marker.getLatLng();
    mapLeaflet.setView([lat, lng], Math.max(mapLeaflet.getZoom(), 16), { animate: true });
  }
}

function clearPath() {
  path = [];
  localStorage.removeItem('gps_path');
  if (polyline) { polyline.setLatLngs([]); }
  if (marker) { marker.remove(); marker = null; }
  if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; }
  setStatus("Cleared path & marker.");
}

// --- Demo mode (simulate movement) ---
function startDemo() {
  if (demoTimer) return;
  DEMO_MODE = true;
  ensureMapInit();

  follow = true;
  $('#toggleFollowBtn')?.textContent = 'Follow: on';

  if (DEMO_CLEAR_PATH_ON_START) clearPath();

  setStatus('Demo mode: simulating movement…');

  const center = [53.3498, -6.2603];
  const R = 0.003;  // ≈ 300 m
  let t = 0;

  demoTimer = setInterval(() => {
    t += 0.05;
    const lat = center[0] + R * Math.cos(t);
    const lon = center[1] + (R * Math.sin(t)) / Math.cos(center[0] * Math.PI / 180);
    handlePosition({ coords: { latitude: lat, longitude: lon, accuracy: 5 } });
  }, 1000);

  const btn = $('#demoBtn'); if (btn) btn.textContent = 'Stop Demo';
}
function stopDemo() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  DEMO_MODE = false;
  setStatus('Demo stopped.');
  const btn = $('#demoBtn'); if (btn) btn.textContent = 'Demo Follow';
}

// --- Page visibility (helps on mobile) ---
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pushGps("visibility");
});

// --- Wire UI ---
document.addEventListener("DOMContentLoaded", () => {
  ensureMapInit(); // initialize map ASAP

  $('#startGpsBtn')?.addEventListener('click', startTest);
  $('#stopGpsBtn')?.addEventListener('click', stopTest);
  $('#pushNowBtn')?.addEventListener('click', pushNowManual);

  $('#demoBtn')?.addEventListener('click', () => {
    console.log('Demo button clicked');
    if (demoTimer) stopDemo(); else startDemo();
  });

  $('#toggleFollowBtn')?.addEventListener('click', toggleFollow);
  $('#clearPathBtn')?.addEventListener('click', clearPath);
});
