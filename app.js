// app.js
// ===== Browser → ESP32 control. ESP32 → ThingSpeak only when uploadsEnabled =====

"use strict";

/** ========================
 *   CONFIG — SET THIS!
 *  ======================== */
const ESP32_BASE = "http://192.168.4.1"; // <-- change to your ESP32 IP (HTTP)
const GPS_SEND_MIN_MS = 5000;            // throttle /location posts (ms)
const MOVEMENT_MIN_METERS = 3;           // only send if moved ~3m
const INITIAL_ZOOM = 12;
const FOLLOW_ZOOM  = 14;

/** ========================
 *   STATE
 *  ======================== */
let mapLeaflet = null;
let marker = null;
let gpsWatchId = null;
let lastCoords = null;     // { latitude, longitude, accuracy, t }
let lastSentGpsMs = 0;
let startedUploads = false;

/** ========================
 *   UI HELPERS
 *  ======================== */
const $ = s => document.querySelector(s);
const setStatus = msg => { const el = $('#gpsStatus'); if (el) el.textContent = msg; };
const setEsp    = msg => { const el = $('#espStatus'); if (el) el.textContent = msg; };

/** ========================
 *   MAP (Leaflet)
 *  ======================== */
function ensureMapInit() {
  if (mapLeaflet) return;
  const el = document.getElementById('map');
  if (!el) return;
  mapLeaflet = L.map(el).setView([53.3498, -6.2603], INITIAL_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(mapLeaflet);
}

function updateMap(lat, lon, accuracy) {
  if (!mapLeaflet) return;
  if (!marker) marker = L.marker([lat, lon]).addTo(mapLeaflet);
  else marker.setLatLng([lat, lon]);
  marker.bindPopup(`Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}<br>±${Math.round(accuracy || 0)} m`);
  if (mapLeaflet.getZoom() < FOLLOW_ZOOM) {
    mapLeaflet.setView([lat, lon], FOLLOW_ZOOM, { animate: true });
  }
}

/** ========================
 *   HTTP HELPERS
 *  ======================== */
function fullUrl(path) { return `${ESP32_BASE}${path.startsWith('/') ? path : `/${path}`}`; }

async function req(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(fullUrl(path), opts);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res;
}

async function postJSON(path, body) { return req("POST", path, body); }

/** ========================
 *   ESP32 CONTROLS
 *  ======================== */
async function espStartUploads() {
  try {
    setEsp("starting…");
    await postJSON("/startUploads", {});
    startedUploads = true;
    setEsp("running");
  } catch (e) {
    setEsp(e.message);
    console.error(e);
  }
}

async function espStopUploads() {
  try {
    setEsp("stopping…");
    await postJSON("/stopUploads", {});
    startedUploads = false;
    setEsp("idle");
  } catch (e) {
    setEsp(e.message);
    console.error(e);
  }
}

async function espStopLocation() {
  try { await postJSON("/stopLocation", {}); }
  catch (e) { /* non-fatal */ }
}

async function espSendLocation(lat, lon) {
  const now = Date.now();

  // throttle
  if (now - lastSentGpsMs < GPS_SEND_MIN_MS) return;

  // movement filter
  if (lastCoords) {
    const d = haversineMeters(lastCoords.latitude, lastCoords.longitude, lat, lon);
    if (d < MOVEMENT_MIN_METERS) return;
  }

  try {
    await postJSON("/location", { lat, lon });
    lastSentGpsMs = now;
    setStatus(`GPS sent: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  } catch (e) {
    setStatus(`Send GPS failed: ${e.message}`);
    console.error(e);
  }
}

/** ========================
 *   GEOLOCATION
 *  ======================== */
function handlePosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords || {};
  if (latitude == null || longitude == null) return;

  lastCoords = { latitude, longitude, accuracy, t: Date.now() };
  $('#latDisp').textContent = latitude.toFixed(6);
  $('#lonDisp').textContent = longitude.toFixed(6);
  updateMap(latitude, longitude, accuracy);

  // Start uploads on first fix
  if (!startedUploads) espStartUploads();

  // Send location to ESP32 (rate-limited)
  espSendLocation(latitude, longitude);
}

function startTest() {
  ensureMapInit();

  if (!('geolocation' in navigator)) {
    setStatus("Geolocation not supported.");
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
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

async function stopTest() {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  await espStopLocation();
  await espStopUploads();
  setStatus("Stopped.");
}

/** ========================
 *   UTILITIES
 *  ======================== */
const toRad = v => v * Math.PI / 180;
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** ========================
 *   WIRE UI
 *  ======================== */
document.addEventListener("DOMContentLoaded", () => {
  $('#startGpsBtn')?.addEventListener('click', startTest);
  $('#stopGpsBtn')?.addEventListener('click', stopTest);
  $('#pushNowBtn')?.addEventListener('click', () => {
    if (!lastCoords) { setStatus("No GPS fix yet."); return; }
    // Force-send current location now (ignore throttle)
    lastSentGpsMs = 0;
    espSendLocation(lastCoords.latitude, lastCoords.longitude);
  });

  ensureMapInit();
  setEsp("idle");
});
