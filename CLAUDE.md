# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vital-Route** (WTF — Where's The Fastest Hospital) is a healthcare network routing demo for the LA area. EMTs speak a patient intake, the app extracts structured data from the transcript, and routes to the top 3 hospitals scored by capacity, ETA, and specialty match. Live utilization comes from the HHS Socrata API; traffic times from Google Distance Matrix; voice I/O from ElevenLabs.

## Commands

```bash
npm install          # install dependencies
npm run dev          # run frontend (Vite) + backend (Express) concurrently
npm run dev:client   # Vite only (port 5173)
npm run dev:server   # Express only (port 8787, with --watch)
npm run build        # production build of frontend
npm run lint         # ESLint
npm run preview      # preview production build
npm start            # production Express server only
```

If Vite crashes with a missing `@rollup/rollup-win32-x64-msvc` error, delete `node_modules` and `package-lock.json` and re-run `npm install`.

## Environment Variables (`.env`)

| Variable | Purpose |
|---|---|
| `GOOGLE_MAPS_API_KEY` | Geocoding, Distance Matrix, Places Autocomplete |
| `ELEVENLABS_API_KEY` | Speech-to-text (`/api/stt`) and text-to-speech (`/api/tts`) |
| `ELEVENLABS_VOICE_ID` | Optional — defaults to `JBFqnCBsd6RMkjVDRZzb` |
| `MONGODB_URI` | MongoDB Atlas connection string for patient persistence |
| `MONGODB_DB_NAME` | Database name (e.g. `vital_route`) |
| `PORT` | Backend port — defaults to `8787` |

Without `GOOGLE_MAPS_API_KEY`: haversine fallback, address input disabled, map click still works. Without `ELEVENLABS_API_KEY`: voice button disabled, UI shows "voice offline". Without MongoDB: patient persistence disabled, all other features work.

## Architecture

Single-page React frontend (`src/App.jsx`) talking to an Express backend (`server/index.js`) via a Vite dev proxy (`/api/*` → `localhost:8787`). All dispatch/request state is in-memory on the server; patient records persist to MongoDB Atlas when configured.

### Backend (`server/index.js`)

**In-memory stores:**
- `requests` — individual hospital notification records
- `dispatches` — EMT dispatch sessions with ordered hospital chain
- `hospitalOverrides` — admin status overrides `{ [hospitalId]: "Open"|"Saturation"|"Diversion" }`

**Key pipeline:**
- `fetchHospitalsByDistance(lat, lng, radiusMiles)` — Socrata API, deduplicates by latest week, 60-second cache keyed by lat/lng bucket
- `fetchAndCacheHospitals(city, state, limit)` — city-based fetch, 1-hour cache
- `getTravelMetrics(origin, nodes)` — Google Distance Matrix, haversine fallback if no key
- `computeRoute(origin, specification, insurance)` — fetch → travel metrics → score → filter → top 3
- `scoreHospital(node, spec)` — `specialty × status × availableBeds / (ETA + waitMins)`
- `createRequest(dispatch, chainIndex, escalatedFromName)` — creates request, auto-approves if conditions met
- `shouldAutoApprove(hospitalId, nodeMetrics)` — `status === "Open" && availableBeds >= 5 && waitMins <= 60`; respects `hospitalOverrides`
- `getEffectiveStatus(hospitalId, utilization)` — returns override if set, else `deriveStatus`
- `deriveStatus(utilization)` — Open < 0.80, Saturation 0.80–0.95, Diversion ≥ 0.95

**Scoring multipliers:** specialty match=3.0, no match=0.5, no spec=1.0 | Open=1.0, Saturation=0.5, Diversion=0

**All API endpoints (`/api/`):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Provider status: `{ google, voice, mongo }` flags |
| POST | `/patients` | Create patient record in MongoDB |
| GET | `/patients` | List patients (filter by `?status=`, `?specification=`) |
| GET | `/patients/:patientId` | Get single patient |
| PATCH | `/patients/:patientId` | Update patient fields |
| GET | `/nodes` | Hospitals by `?city=` |
| POST | `/hospitals-by-coords` | Hospitals within 50 mi of `{ lat, lng }` |
| GET | `/telemetry` | Utilization snapshot by `?city=` |
| GET | `/hospitals` | Raw Socrata data by city/state |
| POST | `/geocode` | Address → `{ lat, lng }` |
| POST | `/route` | Full recommendation → top 3 |
| POST | `/stt` | Multipart audio → `{ transcript }` via ElevenLabs |
| POST | `/tts` | `{ text }` → audio stream via ElevenLabs |
| POST | `/dispatch` | Create dispatch session with hospital chain |
| GET | `/dispatch/:dispatchId` | Poll dispatch + chain status |
| GET | `/requests` | List requests, filter by `?hospitalId=` |
| PATCH | `/requests/:requestId` | Accept or divert; divert auto-escalates chain |
| POST | `/admin/override` | Force hospital status |
| DELETE | `/admin/override/:hospitalId` | Remove override |
| GET | `/admin/overrides` | List active overrides |

**Dispatch / escalation:** EMT calls `POST /api/dispatch` with `{ chain: [{hospitalId, hospitalName, etaMins, utilization, availableBeds, waitMins}], patientSpec, insurance }`. Server creates requests for chain[0], auto-approves if healthy. On divert, escalates to chain[1], and so on. `dispatch.status` → `"active"` → `"accepted"` or `"exhausted"`.

### Frontend (`src/App.jsx`)

Single large component. Key state: `nodes`, `route`, `dispatch`, `adminHospitals`, `activeTab` (`"emt"|"hospital"|"admin"`).

**Key flows:**
1. **On load** — browser geolocation → `fetchHospitalsByCoords` → `requestRecommendations`; map panned imperatively via `mapRef.current.panTo()`
2. **Voice intake** — `useVoice` hook records audio → `POST /api/stt` → transcript → `extractPatient()` → fills form fields
3. **Address / autocomplete** — Places Autocomplete geometry used directly on form submit; backend geocoder only as fallback
4. **Map click** — `handleMapClick` → same fetch/route flow
5. **Dispatch** — `handleDispatch()` → `POST /api/dispatch` → polls `GET /api/dispatch/:id` every 3s while `status === "active"`
6. **Hospital tab** — polls `GET /api/requests` every 3.5s
7. **Telemetry** — polls `GET /api/telemetry` every 10s

**Admin mode:** append `?admin=true` to URL to reveal the Admin tab for demo override testing.

**Map:** `@react-google-maps/api` with `Circle` overlays (green < 50%, yellow 50–89%, red ≥ 90% utilization) and `Polyline` routes. Map instance stored in `mapRef` via `onLoad` for imperative control.

### Voice pipeline (`src/hooks/useVoice.js`, `src/lib/extractPatient.js`)

`useVoice` — manages `MediaRecorder`, sends audio blob to `/api/stt`, receives transcript. Also wraps `/api/tts` for spoken replies. Backend uses ElevenLabs for both directions.

`extractPatient(transcript)` — pure client-side regex extraction. Returns `{ name, age, sex, specification, insurance, location: { phrase }, vitals: { bp, hr, spo2 }, transcript }`. `location.phrase` is free text that must be geocoded before posting to `/api/route`.

### Data model

Hospital node from `/api/route`:
```js
{ id, name, lat, lng, address, city, state, zip,
  distance, durationMins, distanceMiles,
  beds: { inpatient_total, inpatient_used, inpatient_utilization, icu_total, icu_used, icu_utilization },
  utilization, waitMins, availableBeds, status }
```

Patient record (MongoDB):
```js
{ patientId, name, age, specification, location: { lat, lng }, status, createdAt }
```

## Configuration Files

| File | Purpose |
|---|---|
| `vite.config.js` | React plugin, `/api` proxy to `:8787`, exposes `VITE_` and `GOOGLE_` env vars |
| `tailwind.config.js` | Fonts: Space Grotesk (display), IBM Plex Mono (mono) |
| `eslint.config.js` | Lints `src/` only; `server/` and `dist/` excluded |
