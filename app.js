// ===== GPS + ESP32 sensors → ThingSpeak =====

// --- CONFIG ---
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const PUSH_PERIOD   = 80_000; // 80 seconds

// If your page is HTTPS and ESP32 is HTTP on hotspot, the browser will block requests.
// Best: serve this page from ESP32 (HTTP) OR use an HTTPS reverse-proxy.
// Otherwise, set your ESP32 IP here when you’re on the phone hotspot:
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
  mapLeaflet = L.map(el).setView([53.3498, -6.2603], 12); // Dublin
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(mapLeaflet);
}
function updateMap(lat, lon, accuracy) {
  if (!mapLeaflet) return;
  if (!marker) marker = L.marker([lat, lon]).addTo(mapLeaflet);
  else marker.setLatLng([lat, lon]);
  marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy||0)} m`);
  if (mapLeaflet.getZoom() < 14) mapLeaflet.setView([lat, lon], 14, { animate: true });
}

// --- ESP32 helpers ---
function sameOriginUrl(path) {
  if (!ESP32_BASE) return path.startsWith("/") ? path : `/${path}`;
  return `${ESP32_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
function isHttpsPage() { return location.protocol === "https:"; }
function isHttpTarget(url) {
  try { return new URL(url, location.href).protocol === "http:"; } catch { return false; }
}
function mapReadingsToThingSpeak(r) {
  return {
    field1: r?.pm1,
    field2: r?.pm25,
    field3: r?.pm10,
    field4: r?.co2,
    field5: r?.temperature,
    field6: r?.humidity
  };
}
async function getESP32Readings() {
  const url = sameOriginUrl("/sensors");
  if (isHttpsPage() && isHttpTarget(url)) {
    throw new Error("Blocked: page is HTTPS but ESP32 is HTTP. Serve over HTTP or set up HTTPS proxy.");
  }
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    throw new Error(`/sensors fetch failed (network/CORS): ${e.message}`);
  }
  if (!res.ok) throw new Error(`/sensors HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("/sensors returned non-JSON");
  }
}

// --- ThingSpeak push ---
async function sendToThingSpeak(payload) {
  // filter invalids and sentinel -1 values
  const params = new URLSearchParams({ api_key: TS_WRITE_KEY });
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null || v === "") continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    if (num === -1) continue; // skip sentinel
    params.set(k, String(num));
  }

  const qs = params.toString();
  const safeUrl = `https://api.thingspeak.com/update?${qs.replace(TS_WRITE_KEY, '***')}`;
  log("ThingSpeak payload:", Object.fromEntries([...params].filter(([k]) => k !== 'api_key')), safeUrl);

  const res = await fetch(`https://api.thingspeak.com/update?${qs}`, { method: "GET" });
  const text = (await res.text()).trim();
  if (text === "0") throw new Error("ThingSpeak rejected update (rate limit or bad key/fields).");
  return text; // entry id
}

async function pushGpsAndSensors(reason = "timer") {
  if (!lastCoords) { setStatus("Waiting for GPS fix…"); return; }
  const now = Date.now();
  if (reason !== "manual" && now - lastPushMs < PUSH_PERIOD) {
    const left = Math.max(0, PUSH_PERIOD - (now - lastPushMs));
    log(`Skip push (${reason}); ${Math.round(left/1000)}s left`);
    return;
  }

  const payload = {
    field7: lastCoords.latitude,
    field8: lastCoords.longitude
  };

  // try to include ESP32 readings, but don't fail the whole push if ESP32 is unreachable
  try {
    setEsp("reading…");
    const r = await getESP32Readings();
    const mapped = mapReadingsToThingSpeak(r);
    // only add valid, non -1 values
    for (const [k, v] of Object.entries(mapped)) {
      if (v !== undefined && v !== null && Number.isFinite(+v) && +v !== -1) {
        payload[k] = v;
      }
    }
    setEsp("ok");
  } catch (e) {
    setEsp(e.message);
  }

  try {
    const entry = await sendToThingSpeak(payload);
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

  // push immediately on first fix
  if (lastPushMs === 0) {
    pushGpsAndSensors("first-fix");
  } else {
    // if we're overdue, push on movement too
    pushGpsAndSensors("movement");
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

  setStatus("Starting… allow location access.");
  gpsWatchId = navigator.geolocation.watchPosition(
    handlePosition,
    err => { setStatus(`GPS error: ${err.message || err.code}`); },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );

  // Safety timer ensures a push every 80s using last known coords
  if (!safetyTimer) {
    safetyTimer = setInterval(() => pushGpsAndSensors("timer"), PUSH_PERIOD);
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
  setStatus("Stopped.");
  setEsp("idle");
}

function pushNowManual() {
  if (!lastCoords) { setStatus("No GPS fix yet."); return; }
  pushGpsAndSensors("manual");
}

// Handle page visibility (helps on mobile)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pushGpsAndSensors("visibility");
});

// --- Wire UI ---
document.addEventListener("DOMContentLoaded", () => {
  $('#startGpsBtn')?.addEventListener('click', startTest);
  $('#stopGpsBtn')?.addEventListener('click', stopTest);
  $('#pushNowBtn')?.addEventListener('click', pushNowManual);
  ensureMapInit();
});
