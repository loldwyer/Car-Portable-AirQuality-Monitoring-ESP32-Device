// ===== GPS → ThingSpeak (fields 7 & 8 only) =====

// --- CONFIG ---
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const PUSH_PERIOD   = 80_000; // 80 seconds

// --- State ---
let mapLeaflet = null;
let marker = null;
let gpsWatchId = null;
let lastCoords = null;
let lastPushMs = 0;
let safetyTimer = null; // fires every PUSH_PERIOD using last known coords

// --- UI helpers ---
const $ = s => document.querySelector(s);
const log = (...a) => { console.log(...a); };
function setStatus(msg) { const el = $('#gpsStatus'); if (el) el.textContent = msg; }

// --- Map ---
function ensureMapInit() {
  if (mapLeaflet) return;
  const el = document.getElementById('map');
  if (!el) return;
  mapLeaflet = L.map(el).setView([53.3498, -6.2603], 12); // Dublin default
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(mapLeaflet);
}

function updateMap(lat, lon, accuracy) {
  if (!mapLeaflet) return;
  if (!marker) {
    marker = L.marker([lat, lon]).addTo(mapLeaflet);
  } else {
    marker.setLatLng([lat, lon]);
  }
  marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy||0)} m`);
  if (mapLeaflet.getZoom() < 14) mapLeaflet.setView([lat, lon], 14, { animate: true });
}

// --- ThingSpeak push (GPS only) ---
async function sendToThingSpeakGPS(lat, lon) {
  const params = new URLSearchParams({
    api_key: TS_WRITE_KEY,
    field7: String(lat),
    field8: String(lon)
  });

  const url = `https://api.thingspeak.com/update?${params.toString()}`;
  log("ThingSpeak GPS payload:", { field7: lat, field8: lon, url: url.replace(TS_WRITE_KEY, '***') });

  const res = await fetch(url, { method: "GET" });
  const text = (await res.text()).trim();
  if (text === "0") throw new Error("ThingSpeak rejected update (rate limit or bad key/fields).");
  return text; // entry id
}

// push now if enough time passed
async function maybePushNow(reason = "movement") {
  if (!lastCoords) { setStatus("Waiting for GPS fix…"); return; }
  const now = Date.now();
  if (now - lastPushMs < PUSH_PERIOD && reason !== "manual") {
    log(`Skip push (${reason}); ${Math.round((PUSH_PERIOD - (now - lastPushMs))/1000)}s left`);
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

// --- Geolocation handlers ---
async function handlePosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords || {};
  if (latitude == null || longitude == null) return;

  lastCoords = { latitude, longitude, accuracy, t: Date.now() };
  $('#latDisp').textContent = latitude.toFixed(6);
  $('#lonDisp').textContent = longitude.toFixed(6);
  updateMap(latitude, longitude, accuracy);

  // 1) Push immediately on first fix
  if (lastPushMs === 0) {
    maybePushNow("first-fix");
    return;
  }
  // 2) Otherwise push if >= 80s elapsed
  maybePushNow("movement");
}

function startGpsTest() {
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

  // Safety timer: in case the browser throttles movement callbacks,
  // push the last known coords every 80s anyway.
  if (!safetyTimer) {
    safetyTimer = setInterval(() => maybePushNow("timer"), PUSH_PERIOD);
  }
}

function stopGpsTest() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (safetyTimer) {
    clearInterval(safetyTimer);
    safetyTimer = null;
  }
  setStatus("Stopped.");
}

function pushNowManual() {
  if (!lastCoords) { setStatus("No GPS fix yet."); return; }
  maybePushNow("manual");
}

// Handle page visibility (helps on mobile)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // try a push if we’re overdue
    maybePushNow("visibility");
  }
});

// --- Wire UI ---
document.addEventListener("DOMContentLoaded", () => {
  $('#startGpsBtn')?.addEventListener('click', startGpsTest);
  $('#stopGpsBtn')?.addEventListener('click', stopGpsTest);
  $('#pushNowBtn')?.addEventListener('click', pushNowManual);
  ensureMapInit();
});
