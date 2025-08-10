// ===== GPS → ThingSpeak (fields 7 & 8). ESP32 pushes fields 1–6 after /start =====

// --- CONFIG ---
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const PUSH_PERIOD   = 80_000; // 80 seconds

// If this page is HTTPS and ESP32 is HTTP (on phone hotspot), browser will block requests.
// Easiest for local dev: serve this page on http://localhost (secure context exception for geolocation).
// Otherwise set ESP32_BASE to its IP (HTTP) and ensure you're not on HTTPS, or proxy the ESP32 over HTTPS.
const ESP32_BASE = ""; // e.g., "http://192.168.4.1"

// --- State ---
let mapLeaflet = null;
let marker = null;
let gpsWatchId = null;
let safetyTimer = null;
let lastCoords = null;
let lastPushMs = 0;

// --- UI helpers ---
const $ = s => document.querySelector(s);
const log = (...a) => console.log(...a);
const setStatus = msg => { const el = $('#gpsStatus'); if (el) el.textContent = msg; };
const setEsp = msg => { const el = $('#espStatus'); if (el) el.textContent = msg; };

// --- Map ---
function ensureMapInit() {
  if (mapLeaflet) return;
  const el = document.getElementById('map');
  if (!el) return;
  mapLeaflet = L.map(el).setView([53.3498, -6.2603], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(mapLeaflet);
}

function updateMap(lat, lon, accuracy) {
  if (!mapLeaflet) return;
  if (!marker) marker = L.marker([lat, lon]).addTo(mapLeaflet);
  else marker.setLatLng([lat, lon]);
  marker.bindPopup(
    `Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy || 0)} m`
  );
  if (mapLeaflet.getZoom() < 14) mapLeaflet.setView([lat, lon], 14, { animate: true });
}

// --- URL helpers ---
function sameOriginUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!ESP32_BASE) return p;
  return `${ESP32_BASE}${p}`;
}
function isHttpsPage() { return location.protocol === "https:"; }
function isHttpTarget(url) {
  try { return new URL(url, location.href).protocol === "http:"; } catch { return false; }
}

// --- ESP32 control (/start, /stop, /status) ---
async function espCall(path) {
  const url = sameOriginUrl(path);
  if (isHttpsPage() && isHttpTarget(url)) {
    // Mixed content would be blocked — just show a hint and skip
    throw new Error("Blocked: page is HTTPS but ESP32 is HTTP. Host page on localhost/HTTP or use an HTTPS proxy.");
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  // If ESP32 returns no JSON, tolerate it
  try {
    return await res.json();
  } catch {
    return {};
  }
}
async function espStart() {
  try {
    setEsp("starting…");
    await espCall("/start");
    setEsp("running");
  } catch (e) {
    setEsp(e.message);
  }
}
async function espStop() {
  try {
    setEsp("stopping…");
    await espCall("/stop");
    setEsp("idle");
  } catch (e) {
    setEsp(e.message);
  }
}

// --- ThingSpeak push (GPS only) ---
async function sendToThingSpeakGPS(lat, lon) {
  const params = new URLSearchParams({
    api_key: TS_WRITE_KEY,
    field7: String(lat),
    field8: String(lon)
  });
  const url = `https://api.thingspeak.com/update?${params.toString()}`;
  log("TS GPS payload:", { field7: lat, field8: lon, url: url.replace(TS_WRITE_KEY, '***') });
  const res = await fetch(url, { method: "GET" });
  const text = (await res.text()).trim();
  if (text === "0") throw new Error("ThingSpeak rejected update (rate limit or bad key/fields).");
  return text; // entry id
}

async function pushGps(reason = "timer") {
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
function handlePosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords || {};
  if (latitude == null || longitude == null) return;

  lastCoords = { latitude, longitude, accuracy, t: Date.now() };
  $('#latDisp').textContent = latitude.toFixed(6);
  $('#lonDisp').textContent = longitude.toFixed(6);
  updateMap(latitude, longitude, accuracy);

  if (lastPushMs === 0) {
    // push immediately on first fix
    pushGps("first-fix");
  } else {
    // allow a movement-triggered push, but rate-limited by pushGps
    pushGps("movement");
  }
}

function startTest() {
  ensureMapInit();

  if (!('geolocation' in navigator)) {
    setStatus("Geolocation not supported on this device.");
    return;
  }
  if (gpsWatchId != null) {
    setStatus("Already running.");
    return;
  }

  // Tell ESP32 to begin its own 80s sensor pushes (fields 1–6)
  espStart();

  setStatus("Starting… allow location access.");
  gpsWatchId = navigator.geolocation.watchPosition(
    handlePosition,
    err => { setStatus(`GPS error: ${err.message || err.code}`); },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );

  // Safety timer: ensure a GPS push at least every 80s
  if (!safetyTimer) {
    safetyTimer = setInterval(() => pushGps("timer"), PUSH_PERIOD);
  }
}

function stopTest() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (safetyTimer) {
    clearInterval(safetyTimer);
    safetyTimer = null;
  }
  // Tell ESP32 to stop its periodic pushes
  espStop();

  setStatus("Stopped.");
  setEsp("idle");
}

function pushNowManual() {
  if (!lastCoords) { setStatus("No GPS fix yet."); return; }
  pushGps("manual");
}

// Handle page visibility (helps on mobile)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pushGps("visibility");
});

// --- Wire UI ---
document.addEventListener("DOMContentLoaded", () => {
  $('#startGpsBtn')?.addEventListener('click', startTest);
  $('#stopGpsBtn')?.addEventListener('click', stopTest);
  $('#pushNowBtn')?.addEventListener('click', pushNowManual);
  ensureMapInit();
});
