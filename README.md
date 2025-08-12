A lightweight browser dashboard for a vehicle‑mounted ESP32 air‑quality device.
It visualizes CO₂, PM1.0/2.5/10, temperature, humidity, and GPS, then lets you merge the two data streams into a single CSV for mapping/analysis.

* Stack: HTML + CSS + JS (Leaflet), ThingSpeak REST API, optional Blynk mobile app.
* Device: ESP32 + SCD30 + SPS30 + DS3231 + microSD (firmware logs CSV and uploads to cloud).

Features of Webpgae (index.html)
* Live maps (Leaflet): Start/stop GPS upload from the browser; track your route.
* ThingSpeak integration:
    * Sensors → fields 1–6 (from ESP32)
    * GPS → fields 7–8 (from the browser)
* Slotting / Interleaving: Sensor rows sent on even 40‑s slots; GPS rows on odd 40‑s slots → clean, collision‑free channel feeds.
* Fetch & Merge: Pull recent channel data, pair sensor rows to nearest GPS row (default ±90 s window), compute speed (km/h), distance, cumulative km, and an AQI estimate (PM2.5‑based).
* Download CSV: Export the merged table in one click.
* Quick sensor tabs: Embedded ThingSpeak charts for CO₂/PM/Temp/Humidity.

Repo Structure
├── index.html     # UI: header, nav, map, sensor tabs, merge table, buttons
├── app.js         # Logic: GPS watch, slotting, TS uploads, fetch & merge, table export
├── style.css      # Styles for layout, buttons, tabs, map, tables
└── images/        # (optional) logos/screenshots used by index.html
Prereqs
A ThingSpeak channel (public or with a Read API Key)

Field mapping (recommended):

* field1 PM1.0, field2 PM2.5, field3 PM10
* field4 CO₂, field5 Temp, field6 Humidity
* field7 Latitude, field8 Longitude
* An ESP32 device pushing sensor rows to fields 1–6 every even 40‑s slot.
* (Optional) Blynk mobile dashboard for live gauges.
* A modern browser (Chrome/Edge/Firefox) with Geolocation permission, e.g. mobile phone.

Quick Start (Local)
Because the app uses navigator.geolocation and fetches remote JSON, run it via a local server (not file://).

* Clone the repo
  * git clone https://github.com/loldwyer/Car-Portable-AirQuality-Monitoring-ESP32-Device.git
  * cd Car-Portable-AirQuality-Monitoring-ESP32-Device
  * Configure your channel + keys
* Open app.js and set:

// ThingSpeak write key for GPS uploads (fields 7 & 8)
const THINGSPEAK_WRITE_KEY = "YOUR_WRITE_KEY";

// The update URL is already set
const THINGSPEAK_UPDATE_URL = "https://api.thingspeak.com/update.json";
In the page (right column), set your Channel ID and (if private) Read API Key.

Serve locally
Use any simple server, e.g.:
# Python 3
python -m http.server 8080
# or VS Code "Live Server" extension
Then open: http://localhost:8080/index.html

** Give GPS permission in the browser when prompted.**

Using the Dashboard
1) Live GPS upload
Click Start GPS Upload.

* The map centers on your location; a marker follows as you drive.

* The page posts lat/lon to ThingSpeak fields 7–8 on odd 40‑s slots.

* Stop any time with the Stop button.

* Slot length is editable (default 40 000 ms). Keep the ESP32 and browser in sync.

2) View live charts (ThingSpeak)
Use the Sensor Overview tabs to open embedded charts (CO₂, PM, Temp, Humidity).

Latest live values show above each chart.

3) Fetch & Merge → CSV
Select how many rows (e.g., 200) and a merge window (default 90 s).

Click Fetch & Merge.

A table appears with sensor + GPS on each row, plus:

speed_kmh, seg_km, total_km, and aqi (PM2.5-based)

Click Download CSV to save locally.

Data Flow (at a glance)
ESP32 (every 5 s): reads SCD30 + SPS30 → logs CSV to SD → updates Blynk V0–V6

ESP32 → ThingSpeak (even slots): fields 1–6 (PM/CO₂/Temp/Hum)

Browser → ThingSpeak (odd slots): fields 7–8 (lat/lon) via REST

Browser (fetch): reads channel JSON → pairs sensor row with nearest GPS row (≤ window) → computes speed/distance/AQI → displays table → CSV export

ThingSpeak Field Map
Field	Meaning	Source
1	PM1.0 (µg/m³)	ESP32
2	PM2.5 (µg/m³)	ESP32
3	PM10 (µg/m³)	ESP32
4	CO₂ (ppm)	ESP32
5	Temp (°C)	ESP32
6	Humidity (%)	ESP32
7	Latitude	Browser
8	Longitude	Browser

Configuration Tips
Slotting parity:

Keep ESP32 on even slots; browser on odd.

If misaligned, adjust parity or change SLOT_MS for one side.

Timezone: app.js requests ThingSpeak feeds with timezone=Europe/Dublin. Adjust if needed.

Privacy: Users must opt in to GPS sharing. The page shows current status.

Security Notes
Do not commit real API keys to public repos.

Use placeholders in app.js and/or load keys from a non‑versioned file.

If you fork this repo, regenerate your keys if you accidentally expose them.

Troubleshooting
No GPS on map: Ensure you served via http:// (or https://), not file://. Allow location permission.

No TS writes: Check THINGSPEAK_WRITE_KEY, channel fields, and slot alignment.

Empty merge table: Increase “How many rows” and/or Merge window (e.g., 120–180 s) and verify both streams exist in the time range.

Charts not loading: Private channels need a Read API Key in the right‑hand controls.

Roadmap
Color‑coded route overlays (PM/CO₂) directly on Leaflet.

Autosave merged CSV to local storage.

Optional AQI presets (e.g., US/EU) and humidity correction toggles.

Multi‑channel compare (e.g., multiple cars/devices).

License
Add your preferred license (e.g., MIT) here.

Acknowledgements
Sensor libraries and ThingSpeak visualizations.

Leaflet for mapping.

ESP32 firmware that powers the data feed.
