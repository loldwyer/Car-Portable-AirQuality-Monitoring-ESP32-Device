(() => {
  'use strict';

  // ---------------- constants ----------------
  const THINGSPEAK_WRITE_KEY = "9YXHS30JF6Z9YHXI";
  const THINGSPEAK_UPDATE_URL = "https://api.thingspeak.com/update.json";

  // ---------------- dom helpers ----------------
  const $ = s => document.querySelector(s);
  function setStatus(msg, cls='muted'){ const el = $("#status"); if (!el) return; el.className = cls; el.textContent = msg; }
  function setParityLabel(p){ const el = $("#parity"); if (el) el.textContent = p===1 ? "odd" : "even"; }
  function setAlign(msg, cls='muted'){ const el = $("#align"); if (!el) return; el.className = cls; el.textContent = msg; }
  function ensureMapInit(){ /* no-op */ }

  // ---------------- map ----------------
  let map = L.map('map').setView([53.35, -6.26], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19}).addTo(map);
  let marker;

  // ---------------- slotting ----------------
  let SLOT_MS = parseInt($("#slotLen")?.value, 10) || 40000;
  $("#slotLen")?.addEventListener('change', ()=>{ SLOT_MS = parseInt($("#slotLen").value,10) || 40000; });

  let gpsWatchId = null;
  let lastLat = null, lastLon = null;
  let slotTimer = null;
  let lastSlotSent = -1;
  let gpsParity = 1;
  let autoAligned = false;
  let mismatchCount = 0;
  const MIS_MATCH_TO_FLIP = 2;
  const currentSlot = () => Math.floor(Date.now() / SLOT_MS);

  // ---------------- tabs/nav ----------------
  const tabGroups = { scd30: ['co2','temp','rh'], sps30: ['pm1','pm25','pm10'], mics: [] };

  function showTab(id, el) {
    hideAllTabs();
    const tab = document.getElementById(id);
    if (tab) tab.style.display = 'block';
    document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
    if (el) el.classList.add('active');
    const sel = document.getElementById('sensorSelect'); if (sel) sel.value = 'none';
    if (id === 'gps') ensureMapInit();
  }

  function handleSensorSelect(sensor) {
    hideAllTabs();
    if (sensor in tabGroups) {
      tabGroups[sensor].forEach(id => document.getElementById(id)?.style && (document.getElementById(id).style.display = 'block'));
      document.querySelectorAll('.tablink').forEach(btn => btn.classList.remove('active'));
    }
  }

  function hideAllTabs() { document.querySelectorAll('.tabcontent').forEach(el => el.style.display = 'none'); }

  function showSection(sectionId) {
    document.querySelectorAll("section").forEach(sec => sec.style.display = "none");
    const target = document.getElementById(sectionId); if (target) target.style.display = "block";
    document.querySelectorAll(".navlink").forEach(link => link.classList.remove("active"));
    const mapTxt = { location: "Device Tracking", "sensor-overview": "Sensor Overview", hardware: "Hardware", enclosure: "Enclosure", deployment: "Deployment" };
    const txt = mapTxt[sectionId] || "";
    [...document.querySelectorAll(".navlink")].forEach(l => { if (l.textContent.includes(txt)) l.classList.add("active"); });
  }

  // expose to inline HTML
  window.showTab = showTab;
  window.handleSensorSelect = handleSensorSelect;
  window.showSection = showSection;

  // ---------------- ThingSpeak fetch/merge ----------------
  async function readChannelFeeds(channelId, readKey, results=40) {
    const u = new URL(`https://api.thingspeak.com/channels/${channelId}/feeds.json`);
    if (readKey) u.searchParams.set('api_key', readKey);
    u.searchParams.set('results', results);
    u.searchParams.set('timezone', 'Europe/Dublin');
    const r = await fetch(u, {cache:'no-store'});
    if (!r.ok) throw new Error(`TS read HTTP ${r.status}`);
    const j = await r.json();
    return j.feeds.map(f => ({
      created_at: f.created_at,
      ts: new Date(f.created_at).getTime(),
      pm1: parseFloat(f.field1) || null,
      pm25: parseFloat(f.field2) || null,
      pm10: parseFloat(f.field3) || null,
      co2: parseFloat(f.field4) || null,
      temp: parseFloat(f.field5) || null,
      hum: parseFloat(f.field6) || null,
      lat: parseFloat(f.field7),
      lon: parseFloat(f.field8)
    }));
  }

  function isSensorRow(r){ return [r.pm1,r.pm25,r.pm10,r.co2,r.temp,r.hum].some(v => typeof v === 'number' && !Number.isNaN(v)); }
  function isGpsRow(r){ return Number.isFinite(r.lat) && Number.isFinite(r.lon); }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2-lat1) * Math.PI/180;
    const dLon = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); // km
  }

  function calcAQIpm25(pm) {
    const bp = [
      {cLow:0.0, cHigh:12.0, aqiLow:0, aqiHigh:50},
      {cLow:12.1, cHigh:35.4, aqiLow:51, aqiHigh:100},
      {cLow:35.5, cHigh:55.4, aqiLow:101, aqiHigh:150},
      {cLow:55.5, cHigh:150.4, aqiLow:151, aqiHigh:200},
      {cLow:150.5, cHigh:250.4, aqiLow:201, aqiHigh:300},
      {cLow:250.5, cHigh:500.4, aqiLow:301, aqiHigh:500}
    ];
    for (let i of bp) if (pm >= i.cLow && pm <= i.cHigh)
      return Math.round(((i.aqiHigh - i.aqiLow)/(i.cHigh - i.cLow)) * (pm - i.cLow) + i.aqiLow);
    return null;
  }

  function mergeSameChannel(rows, windowSec){
    const W = windowSec * 1000;
    const sensors = rows.filter(isSensorRow);
    const gps = rows.filter(isGpsRow);

    const out = [];
    let prevLat = null, prevLon = null, prevTime = null;
    let totalKm = 0;

    for (const s of sensors) {
      // closest GPS within window
      let best = null, bestDt = Infinity;
      for (const g of gps) {
        const dt = Math.abs(s.ts - g.ts);
        if (dt < bestDt && dt <= W) { best = g; bestDt = dt; }
      }
      if (best && Number.isFinite(best.lat) && Number.isFinite(best.lon)) {
        let segKm = null, speed = null;

        if (prevLat != null && prevLon != null && prevTime != null) {
          segKm = haversine(prevLat, prevLon, best.lat, best.lon);
          // if (segKm < 0.01) segKm = 0; // optional jitter filter
          totalKm += segKm;
          const dtHr = (s.ts - prevTime) / 3600000;
          if (dtHr > 0) speed = +((segKm / dtHr).toFixed(1));
        }

        const aqi = (() => {
          let base = calcAQIpm25(s.pm25);
          if (s.co2 > 1000) base += 5;
          if (s.co2 > 2000) base += 15;
          return base;
        })();

        out.push({
          created_at: s.created_at,
          pm1: s.pm1 ?? '', pm25: s.pm25 ?? '', pm10: s.pm10 ?? '',
          co2: s.co2 ?? '', temp: s.temp ?? '', hum: s.hum ?? '',
          lat: best.lat, lon: best.lon,
          dt_s: Math.round(bestDt/1000),
          speed_kmh: (speed ?? ''),
          seg_km: (segKm != null ? +segKm.toFixed(3) : ''),
          total_km: +totalKm.toFixed(3),
          aqi: aqi ?? ''
        });

        prevLat = best.lat; prevLon = best.lon; prevTime = s.ts;
      }
    }
    return out;
  }

  function renderTable(rows){
    if (!rows.length) { $("#tbl").innerHTML = '<tr><td>No merged rows</td></tr>'; return; }
    const cols = ['created_at','pm1','pm25','pm10','co2','temp','hum',
                  'lat','lon','dt_s','speed_kmh','seg_km','total_km','aqi'];
    $("#tbl").innerHTML =
      '<thead><tr>' + cols.map(c=>`<th>${c}</th>`).join('') + '</tr></thead>' +
      '<tbody>' + rows.map(r => '<tr>' +
        cols.map(c => `<td>${(r[c] ?? '')}</td>`).join('') +
      '</tr>').join('') + '</tbody>';
  }

  async function postToThingSpeak(lat, lon){
    try {
      const body = new URLSearchParams({api_key: THINGSPEAK_WRITE_KEY, field7: lat, field8: lon});
      const r = await fetch(THINGSPEAK_UPDATE_URL, {method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const entryId = await r.json();
      if (+entryId === 0) { setStatus('TS rejected GPS', 'err'); return 0; }
      setStatus(`GPS uploaded: ${lat.toFixed(6)}, ${lon.toFixed(6)}`, 'ok');
      return +entryId;
    } catch(e){ setStatus(`Upload error: ${e.message}`,'err'); return 0; }
  }

  async function trySlotUpload(){
    if (lastLat == null || lastLon == null) return;
    const slot = currentSlot();
    const slotEl = $("#slot"); if (slotEl) slotEl.textContent = String(slot);
    if (slot === lastSlotSent) return;
    if ((slot % 2) !== gpsParity) return;
    await new Promise(res => setTimeout(res, 200));
    const id = await postToThingSpeak(lastLat, lastLon);
    if (id > 0) lastSlotSent = slot;
  }

  $("#startBtn")?.addEventListener('click', () => {
    if (!navigator.geolocation) { alert('Geolocation not supported'); return; }
    if (gpsWatchId) { setStatus('Already running', 'warn'); return; }
    gpsWatchId = navigator.geolocation.watchPosition(pos => {
      lastLat = pos.coords.latitude;
      lastLon = pos.coords.longitude;
      if (marker) marker.setLatLng([lastLat, lastLon]);
      else marker = L.marker([lastLat, lastLon]).addTo(map);
      map.setView([lastLat, lastLon], 15);
      trySlotUpload();
      if (!slotTimer) slotTimer = setInterval(trySlotUpload, 1000);
    }, err => setStatus(`GPS error: ${err.message}`, 'err'), { enableHighAccuracy:true });
  });

  $("#stopBtn")?.addEventListener('click', () => {
    if (gpsWatchId) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
    if (slotTimer) { clearInterval(slotTimer); slotTimer = null; }
    setStatus('Stopped', 'muted');
  });

  // ---------------- CSV state ----------------
  let lastMerged = [];
  let lastCols = ['created_at','pm1','pm25','pm10','co2','temp','hum',
                  'lat','lon','dt_s','speed_kmh','seg_km','total_km','aqi'];

  $("#fetchBtn")?.addEventListener('click', async () => {
    const chId = $("#chId")?.value.trim();
    const readKey = $("#readKey")?.value.trim();
    const results = parseInt($("#results")?.value || '200', 10);
    const windowSec = parseInt($("#window")?.value || '90', 10);
    try {
      $("#mergeStatus").textContent = 'Fetching…';
      const rows = await readChannelFeeds(chId, readKey, results);
      $("#mergeStatus").textContent = 'Merging…';
      lastMerged = mergeSameChannel(rows, windowSec);
      renderTable(lastMerged);
      $("#dlBtn").disabled = lastMerged.length === 0;
      $("#mergeStatus").textContent = `Merged ${lastMerged.length} rows`;
    } catch (e) {
      $("#mergeStatus").textContent = `Error: ${e.message}`;
    }
  });

  $("#dlBtn")?.addEventListener('click', () => {
    if (!lastMerged.length) return;
    const lines = [lastCols.join(',')].concat(lastMerged.map(r => lastCols.map(c => r[c]).join(',')));
    const blob = new Blob([lines.join('\n')], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'merged_thingspeak.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // initial view
  document.addEventListener('DOMContentLoaded', () => { showSection('sensor-overview'); });

})(); 
