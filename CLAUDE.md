# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vital-Route** (WTF — Where's The Fastest Hospital) is a healthcare network routing demo for the LA area. It treats patients as packets and hospitals as nodes, ranking the top 3 options by a scoring formula. Live utilization data comes from the HHS Socrata API; traffic-aware travel times come from Google Distance Matrix.

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

**Required before running:** create a `.env` file with `GOOGLE_MAPS_API_KEY=<key>`. Without it, the app runs in fallback mode (haversine estimates; geocoding and Places Autocomplete disabled).

## Architecture

Single-page React frontend talking to an Express backend via a Vite dev proxy (`/api/*` → `localhost:8787`). All state is in-memory on the server — no database.

### Backend (`server/index.js`)

**In-memory stores:**
- `requests` — individual hospital notification records
- `dispatches` — EMT dispatch sessions (ordered chain of hospitals)
- `hospitalOverrides` — admin-injected status overrides `{ [hospitalId]: "Open"|"Saturation"|"Diversion" }`

**Key pipeline functions:**
- `fetchHospitalsByDistance(lat, lng, radiusMiles)` — queries HHS Socrata API, deduplicates by latest week, filters by haversine distance
- `fetchAndCacheHospitals(city, state, limit)` — city-based fetch with 1-hour cache
- `getTravelMetrics(origin, nodes)` — Google Distance Matrix with haversine fallback
- `computeRoute(origin, specification, insurance)` — full pipeline: fetch → travel metrics → score → filter → return top 3
- `scoreHospital(node, spec)` — `specialty × status × availableBeds / (ETA + waitMins)`
- `createRequest(dispatch, chainIndex, escalatedFromName)` — creates a request record, auto-approves if `shouldAutoApprove`
- `shouldAutoApprove(hospitalId, nodeMetrics)` — `status === "Open" && availableBeds >= 5 && waitMins <= 60`; respects `hospitalOverrides`
- `getEffectiveStatus(hospitalId, utilization)` — returns override if set, else `deriveStatus(utilization)`
- `deriveStatus(utilization)` — Open < 0.80, Saturation 0.80–0.95, Diversion ≥ 0.95

**Scoring multipliers:**
- Specialty: 3.0 (match), 0.5 (spec requested but no match), 1.0 (no spec)
- Status: Open=1.0, Saturation=0.5, Diversion=0

**API endpoints (all prefixed `/api/`):**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Provider status (`google` or `fallback`) |
| POST | `/geocode` | Address → `{ lat, lng }` |
| POST | `/hospitals-by-coords` | Hospitals within 50 mi of `{ lat, lng }` |
| POST | `/route` | Full recommendation → top 3 |
| GET | `/telemetry` | Utilization snapshot by city |
| GET | `/hospitals` | Raw Socrata data by city/state |
| GET | `/nodes` | Alias for `/hospitals` |
| POST | `/dispatch` | Create dispatch session with ordered hospital chain |
| GET | `/dispatch/:dispatchId` | Poll dispatch status + chain with per-entry request status |
| GET | `/requests` | List requests, filter by `?hospitalId=` |
| PATCH | `/requests/:requestId` | Accept or divert; divert auto-escalates to next in chain |
| POST | `/admin/override` | Set hospital status override |
| DELETE | `/admin/override/:hospitalId` | Remove override |
| GET | `/admin/overrides` | List active overrides |

**Dispatch / escalation flow:**
1. EMT calls `POST /api/dispatch` with `{ chain: [{hospitalId, hospitalName, etaMins, utilization, availableBeds, waitMins}, ...], patientSpec, insurance }`
2. Server creates a `dispatch` record and fires `createRequest` for chain index 0
3. Auto-approve check runs immediately; if approved, request status = `"accepted"`, dispatch status = `"accepted"`
4. If pending: hospital staff call `PATCH /api/requests/:id` with `{ status: "diverted" }`
5. On divert: server advances `dispatch.currentIndex`, creates a new request for the next hospital
6. If chain is exhausted: `dispatch.status = "exhausted"`

### Frontend (`src/App.jsx`)

Single large component. Key state:
- `nodes` — hospital list from `/api/hospitals-by-coords`
- `route` — result from `/api/route` (includes `top3`, `closest`, `recommended`)
- `dispatch` — polled dispatch session from `/api/dispatch/:id`
- `adminHospitals` — hospital list for admin override UI
- `activeTab` — `"emt"` | `"hospital"` | `"admin"` (admin only visible with `?admin=true`)

**Key flows:**
1. Address input / map click / Places Autocomplete → geocode → `fetchHospitalsByCoords` → `requestRecommendations`
2. "Dispatch Patient" button → `handleDispatch()` → `POST /api/dispatch` → polls `GET /api/dispatch/:id` every 3s while `dispatch.status === "active"`
3. Telemetry polled every 10s via `fetchTelemetry()` (updates map circle colors)
4. Hospital tab polls `GET /api/requests` every 3.5s while tab is active

**Admin mode:** append `?admin=true` to URL to reveal the Admin tab. Lets you toggle any hospital's status to force Saturation or Diversion, enabling divert testing in the demo.

**Map rendering:** `@react-google-maps/api`. Hospitals are colored `Circle` overlays (green < 50%, yellow 50–89%, red ≥ 90%, pulsing above 90%) with `Polyline` routes (dashed grey = closest baseline, solid cyan = recommended, lighter cyan = alternatives).

### Data model

Hospital node from `/api/route`:
```js
{
  id, name, lat, lng, address, city, state, zip,
  distance, durationMins, distanceMiles,
  beds: { inpatient_total, inpatient_used, inpatient_utilization, icu_total, icu_used, icu_utilization },
  utilization, waitMins, availableBeds, status
}
```

Dispatch chain entry sent from frontend:
```js
{ hospitalId, hospitalName, etaMins, utilization, availableBeds, waitMins }
```

## Environment & Configuration

| File | Purpose |
|------|---------|
| `.env` | `GOOGLE_MAPS_API_KEY`, optional `PORT` (default 8787) |
| `vite.config.js` | React plugin, `/api` proxy to `:8787`, exposes `VITE_` and `GOOGLE_` env vars |
| `tailwind.config.js` | Fonts: Space Grotesk (display), IBM Plex Mono (mono) |
| `eslint.config.js` | Lints `src/` only; `server/` and `dist/` excluded |

## Fallback Mode

When `GOOGLE_MAPS_API_KEY` is missing: haversine distances only, `provider = "fallback"`, address input and Places Autocomplete disabled, map click still works.
