# Vital-Route LA Demo

Vital-Route is a healthcare network routing demo that treats patients as packets and hospitals as nodes. EMTs describe the patient out loud, the app extracts condition + insurance + location from speech, and ranks the top 3 hospitals by distance, capacity, and specialty match.

## What this demo includes

- **Hands-free voice intake (ElevenLabs)**: tap-to-record audio, transcribe via ElevenLabs Scribe, speak responses back via ElevenLabs Flash v2.5. Auto-fills the suspected condition (STEMI / stroke / trauma), insurance carrier, and current location from the EMT's natural speech.
- Real-time hospital data from HHS Socrata API (no auth required)
- Global map view initially, then fetches hospitals within 50 miles of entered address
- Address-based location input (example: "200 N Spring St, Los Angeles") that geocodes to coordinates
- Address autocomplete using Google Places so users can pick addresses without typing full strings
- Device-GPS startup auto-fill: the Current Location field reverse-geocodes to an actual street address on first load
- Real bed capacity and utilization data from HHS hospitals dataset (last reported occupancy)
- Top-3 hospital ranking logic:
	- primary: shortest distance
	- secondary tie-breaker: higher available beds
	- tertiary: lower estimated wait time based on utilization

- Google Distance Matrix integration for real-time traffic-aware travel metrics
- Hospital dispatch chain with auto-escalation (Open / Saturation / Diversion)
- Admin override view (`?admin` query string) for forcing hospital status to demo the diversion fallback
- Frontend dashboard with:
	- glowing utilization circles (green, yellow, red) based on real bed data
	- voice intake card with live status (listening / transcribing / speaking) and patient summary
	- address or click-to-route for patient origin points
	- grey dashed line for closest-hospital baseline
	- bright blue line for top recommendation
	- in-map legend (bottom-right)

## Architecture

- Frontend: React + Vite + Tailwind + Google Maps JavaScript API
- Backend: Express (Node.js) + Socrata API client + Distance Matrix client + ElevenLabs SDK + MongoDB Atlas driver
- Voice pipeline: browser `MediaRecorder` → multipart upload → backend proxies to ElevenLabs Scribe (STT) and Flash v2.5 (TTS). API key stays server-side.
- Patient extraction: pure regex/keyword extractor in [src/lib/extractPatient.js](src/lib/extractPatient.js) maps transcripts to `{ specification, insurance, location, age, sex, vitals }`.
- Data model:
	- Real-time hospitals fetched from HHS Socrata API https://healthdata.gov/resource/anag-cw7u.json
	- Hospitals within 50-mile radius sorted by distance from input location
	- [server/index.js](server/index.js): API endpoints and routing logic
	- [src/hooks/useVoice.js](src/hooks/useVoice.js): tap-to-talk hook (record → STT → TTS playback)

## API endpoints

### Routing & hospital data
- GET /api/health → `{ ok, provider, voice, mongo }`
- GET /api/nodes (expects `?city=...&state=...`)
- POST /api/hospitals-by-coords
	- body: `{ "lat": 34.0522, "lng": -118.2437 }`
	- Returns hospitals within 50 miles sorted by distance
- GET /api/telemetry (expects `?city=...&state=...`)
- POST /api/geocode
	- body: `{ "address": "200 N Spring St, Los Angeles" }`
- POST /api/route
	- body: `{ "origin": { "lat": 34.02, "lng": -118.49 }, "specification": "stemi|stroke|trauma" (optional), "insurance": "Medicare|Medicaid|..." (optional) }`

### Voice (ElevenLabs)
- POST /api/stt
	- multipart/form-data: `audio` field with WebM/Opus blob
	- Returns `{ "transcript": "..." }`
- POST /api/tts
	- body: `{ "text": "...", "voiceId": "..." (optional) }`
	- Streams `audio/mpeg` MP3 back

### Dispatch chain
- POST /api/dispatch
	- body: `{ chain: [{ hospitalId, hospitalName, etaMins, utilization, availableBeds, waitMins }, ...], patientSpec, insurance }`
- GET /api/dispatch/:dispatchId
- GET /api/requests (optional `?hospitalId=...`)
- PATCH /api/requests/:requestId
	- body: `{ "status": "accepted" | "diverted" }`

### Admin overrides
- POST /api/admin/override → body: `{ hospitalId, status: "Open" | "Saturation" | "Diversion" }`
- DELETE /api/admin/override/:hospitalId
- GET /api/admin/overrides

### Patient persistence (MongoDB)
- POST /api/patients
	- body: `{ "name": "Jane Doe", "age": 47, "specification": "stroke", "location": { "lat": 34.05, "lng": -118.24 }, "status": "active" }`
- GET /api/patients (optional `?status=...&specification=...`)
- GET /api/patients/:patientId
- PATCH /api/patients/:patientId
	- body: any subset of name, age, specification, location, status

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Add environment variables in .env:

- `GOOGLE_MAPS_API_KEY` — required for maps, address autocomplete, geocoding
- `ELEVENLABS_API_KEY` — required for the voice intake card; without it, `/api/stt` and `/api/tts` return 503 and the mic button is disabled
- `ELEVENLABS_VOICE_ID` (optional) — ElevenLabs voice ID for TTS responses; defaults to `JBFqnCBsd6RMkjVDRZzb` (George)
- `MONGODB_URI` — MongoDB Atlas connection string (optional; only needed for `/api/patients` persistence)
- `MONGODB_DB_NAME` — database name inside your Atlas cluster, e.g. `vital_route`

Notes:
- If `ELEVENLABS_API_KEY` is missing, the voice card is greyed out and shows "voice offline" — the typed-address path still works.
- If `GOOGLE_MAPS_API_KEY` is missing, backend distance lookups fall back to haversine estimates and the map / autocomplete won't load.
- If Mongo vars are missing, patient routes return HTTP 503; dispatch and routing still work fine in memory.

4. Start frontend + backend:

```bash
npm run dev
```

5. Open the app URL shown by Vite (usually http://localhost:5173). Allow microphone and location permissions when prompted.

## Demo script for pitch

1. **Voice intake**: tap the 🎤, say something like *"32-year-old male, chest pain, BP 88 over 54, possible STEMI. Patient is at the Santa Monica Pier. Insurance is Blue Cross."* The patient summary card fills in, the address and specification autofill, and ElevenLabs speaks back a confirmation while the top 3 STEMI-capable hospitals load.
2. **Dispatch**: confirm the recommendation; the request goes to the #1 hospital. Auto-approves on healthy capacity, escalates down the chain otherwise.
3. **Diversion demo**: append `?admin` to the URL, force the top hospital to Diversion, then re-dispatch from EMT view to see the system reroute.

## Notes

- Voice flow uses Web standard `MediaRecorder` → backend proxy → ElevenLabs. The browser mic permission must be granted; geolocation must also be granted for the GPS auto-fill on startup.
- macOS users: if you see `kCLErrorLocationUnknown`, open Apple Maps once to prime CoreLocation, or just type / pick an address manually.
- The Current Location input is uncontrolled by design so Google Places autocomplete clicks stick — voice/GPS-resolved addresses are pushed into the field via an imperative ref-sync effect.
