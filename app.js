// ===== GPS → ThingSpeak (fields 7 & 8). ESP32 pushes fields 1–6 after /start =====

// --- CONFIG ---
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const PUSH_PERIOD   = 80_000; // 80 seconds

// If this page is HTTPS and ESP32 is HTTP (on phone hotspot), browser will block requests.
// Easiest: host this page from ESP32 (HTTP). Otherwise set ESP32_BASE to its IP (HTTP).
const ESP32_BASE = ""; // e.g., "http://192.168.4.1"

// --- State ---
let mapLeaflet = null;
let marker = null;
let accuracyCircle = null;
let polyline = null;
let path = []; // [ [lat, lng], ... ] (restored from localStorage)
let gpsWatchId = null;
let safetyTimer = null;
let lastCoords = null;
let lastPushMs = 0;
let follow = true;
// --- Demo mode (simulate movement without leaving your chair) ---
let DEMO_MODE = false;
let demoTimer = null;

// optional: keep demo path separate from real runs
const DEMO_CLEAR_PATH_ON_START = true;

function startDemo() {
  if (demoTimer) return;
  DEMO_MODE = true;
  ensureMapInit();

  // turn on Follow so you can test it
  follow = true;
  $('#toggleFollowBtn')?.textContent = 'Follow: on';

  if (DEMO_CLEAR_PATH_ON_START) {
    // reuse your clearPath() if you included it; otherwise inline clear:
    if (typeof clearPath === 'function') clearPath();
    else {
      path = [];
      localStorage.removeItem('gps_path');
      if (polyline) polyline.setLatLngs([]);
      if (marker) { marker.remove(); marker = null; }
      if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; }
    }
  }

  setStatus('Demo mode: simulating movement…');

  // A smooth loop around central Dublin (~300m radius)
  const center = [53.3498, -6.2603];
  const R = 0.003;            // ≈ 300 m in latitude
  let t = 0;

  demoTimer = setInterval(() => {
    t += 0.05;                 // speed; lower is slower
    const lat = center[0] + R * Math.cos(t);
    // correct longitude scaling by latitude
    const lon = center[1] + (R * Math.sin(t)) / Math.cos(center[0] * Math.PI / 180);

    // Feed your existing handler a fake geolocation Position
    handlePosition({ coords: { latitude: lat, longitude: lon, accuracy: 5 } });
  }, 1000);

  // Make the button read "Stop Demo"
  const btn = $('#demoBtn'); if (btn) btn.textContent = 'Stop Demo';
}

function stopDemo() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  DEMO_MODE = false;
  setStatus('Demo stopped.');
  const btn = $('#demoBtn'); if (btn) btn.textContent = 'Demo Follow';
}

const MIN_MOVE_METERS = 2; // ignore tiny GPS jitter

// --- UI helpers ---
const $ = s => document.querySelector(s);
const log = (...a) => console.log(...a);
const setStatus = msg => { const el = $('#gpsStatus'); if (el) el.textContent = msg; };
const setEsp = msg => { const el = $('#espStatus'); if (el) el.textContent = msg; };

// --- Restore any previous breadcrumb (useful during dev reloads) ---
try {
  const stored = JSON.parse(localStorage.getItem('gps_path') || '[]');
  if (Array.isArray(stored)) path = stored.slice();
} catch { /* ignore */ }

// --- Map ---
function ensureMapInit() {
  if (mapLeaflet) return;
  const el = document.getElementById('map');
  if (!el) return;

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

  // accuracy circle
  if (!accuracyCircle) {
    accuracyCircle = L.circle([lat, lon], { radius: accuracy || 0, stroke: false, fillOpacity: 0.1 }).addTo(mapLeaflet);
  } else {
    accuracyCircle.setLatLng([lat, lon]).setRadius(accuracy || 0);
  }

  marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy||0)} m`);

  // Follow behavior
  if (follow) {
    const targetZoom = Math.max(mapLeaflet.getZoom(), 16);
    mapLeaflet.setView([lat, lon], targetZoom, { animate: true });
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

// --- ESP32 control (/start, /stop, /status) ---
async function espCall(path) {
  const url = sameOriginUrl(path);
  if (isHttpsPage() && isHttpTarget(url)) {
    // Mixed content would be blocked — just show a hint and skip
    throw new Error("Blocked: page is HTTPS but ESP32 is HTTP. Host page on ESP32 (HTTP) or use HTTPS proxy.");
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json().catch(() => ({}));
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

  // Path + visuals
  ensureMapInit();
  if (maybeAppendPoint(latitude, longitude)) {
    path.push([latitude, longitude]);
    if (polyline) polyline.addLatLng([latitude, longitude]);
    localStorage.setItem('gps_path', JSON.stringify(path));
  }
  updateVisuals(latitude, longitude, accuracy);

  if (lastPushMs === 0) {
    // push immediately on first fix
    pushGps("first-fix");
  } else {
    // allow movement/overdue triggers
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
  if (polyline) polyline.setLatLngs([]);
  if (marker) { marker.remove(); marker = null; }
  if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; }
  setStatus("Cleared path & marker.");
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

  // new
  $('#demoBtn')?.addEventListener('click', () => {
  console.log('Demo button clicked');
  if (demoTimer) stopDemo(); else startDemo();
});

  $('#toggleFollowBtn')?.addEventListener('click', toggleFollow);
  $('#clearPathBtn')?.addEventListener('click', clearPath);

  ensureMapInit(); // shows any restored path
});
