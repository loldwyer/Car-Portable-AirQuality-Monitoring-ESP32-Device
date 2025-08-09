// ===== GPS → ThingSpeak (fields 7 & 8 only) =====

// --- CONFIG ---
const TS_CHANNEL_ID = "2960675";
const TS_WRITE_KEY  = "9YXHS30JF6Z9YHXI";
const PUSH_PERIOD   = 80_000; // 80 seconds

// --- State ---
let mapLeaflet = null;
let marker = null;
let gpsWatchId = null;
let pushTimerId = null;
let lastCoords = null;

// --- UI helpers ---
const $ = sel => document.querySelector(sel);
const statusEl = () => $('#gpsStatus');

function setStatus(msg) {
  if (statusEl()) statusEl().textContent = msg;
}

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

  // Debug log without the key
  const debug = { field7: lat, field8: lon };
  console.log("ThingSpeak GPS payload:", debug);

  const url = `https://api.thingspeak.com/update?${params.toString()}`;
  const res = await fetch(url, { method: "GET" });
  const text = (await res.text()).trim();
  if (text === "0") throw new Error("ThingSpeak rejected update (rate limit or bad key/fields).");
  return text; // entry id
}

// --- Geolocation handlers ---
async function handlePosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords || {};
  if (latitude == null || longitude == null) return;

  lastCoords = { latitude, longitude, accuracy, t: Date.now() };
  $('#latDisp').textContent = latitude.toFixed(6);
  $('#lonDisp').textContent = longitude.toFixed(6);
  updateMap(latitude, longitude, accuracy);
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
    err => setStatus(`GPS error: ${err.message || err.code}`),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );

  // Start a fixed-interval push every 80s using the latest coords we have
  if (pushTimerId == null) {
    pushTimerId = setInterval(async () => {
      try {
        if (!lastCoords) {
          setStatus("Waiting for first GPS fix…");
          return;
        }
        const { latitude, longitude } = lastCoords;
        const entry = await sendToThingSpeakGPS(latitude, longitude);
        setStatus(`Pushed entry #${entry} at ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        setStatus(`Push failed: ${e.message}`);
      }
    }, PUSH_PERIOD);
  }
}

function stopGpsTest() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (pushTimerId != null) {
    clearInterval(pushTimerId);
    pushTimerId = null;
  }
  setStatus("Stopped.");
}

// --- Wire UI ---
document.addEventListener("DOMContentLoaded", () => {
  $('#startGpsBtn')?.addEventListener('click', startGpsTest);
  $('#stopGpsBtn')?.addEventListener('click', stopGpsTest);
  ensureMapInit(); // prepare map immediately
});
