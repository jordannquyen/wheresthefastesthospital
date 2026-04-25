# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vital-Route** is a healthcare network routing demo for the LA area. It treats patients as packets and hospitals as nodes, then ranks the top 3 hospital options by: (1) shortest travel distance, (2) higher available beds as tie-breaker, (3) lower estimated wait time. Live hospital utilization data comes from the HHS Socrata API; traffic-aware travel times come from Google Distance Matrix.

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

**Required before running:** create a `.env` file with `GOOGLE_MAPS_API_KEY=<key>`. Without it, the app runs in fallback mode (haversine estimates instead of Distance Matrix; geocoding and Places Autocomplete disabled).

## Architecture

The app is a single-page React frontend talking to an Express backend via a Vite dev proxy (`/api/*` → `localhost:8787`).

### Backend (`server/index.js`)

All routing logic lives here. Key functions:

- `fetchHospitalsByDistance(lat, lng, radiusMiles)` — queries HHS Socrata API for CA hospitals, filters by haversine distance, returns sorted list
- `getTravelMetrics(origin, nodes)` — calls Google Distance Matrix for real travel times; falls back to haversine if no API key
- `computeRoute(origin, specification, insurance)` — main pipeline: fetch hospitals → get travel metrics → score and rank → apply specialty/insurance filters → return top 3

API endpoints (all prefixed `/api/`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Provider status (`google` or `fallback`) |
| POST | `/geocode` | Address → `{ lat, lng }` via Google Geocoding |
| POST | `/hospitals-by-coords` | Hospitals within 50 mi of `{ lat, lng }` |
| POST | `/route` | Full recommendation: `{ origin, specification?, insurance? }` → top 3 |
| GET | `/telemetry` | Live utilization snapshot (polled every 10s by frontend) |
| GET | `/hospitals` | Raw hospital list by city/state |
| GET | `/nodes` | Alias for `/hospitals` |

Hospital cache TTL is 1 hour to limit Socrata API calls.

### Frontend (`src/App.jsx`)

Single large component managing all state. Key flows:

1. **Address input** → `handleLocationSubmit()` → geocode → fetch hospitals by coords → request route recommendations
2. **Map click** → `handleMapClick()` → skip geocode, use clicked `{ lat, lng }` → same fetch/route flow
3. **Places Autocomplete** → `handlePlaceChanged()` → same flow as address input
4. **Telemetry polling** → `fetchTelemetry()` runs every 10 seconds via `setInterval`

Map rendering uses `@react-google-maps/api`. Hospitals are rendered as colored `Circle` overlays (green < 50% utilization, yellow 50–89%, red ≥ 90%, pulsing above 90%) with `Polyline` routes (dashed grey = closest baseline, solid cyan = recommended, lighter cyan = alternatives 2 & 3).

### Data model

A hospital node returned from `/api/route` looks like:
```js
{
  id, name, lat, lng, address, city, state, zip,
  distance, durationMins, distanceMiles,
  beds: { inpatient_total, inpatient_used, inpatient_utilization, icu_total, icu_used, icu_utilization },
  utilization, waitMins, availableBeds
}
```

## Environment & Configuration

| File | Purpose |
|------|---------|
| `.env` | `GOOGLE_MAPS_API_KEY` (required for full functionality) |
| `vite.config.js` | React plugin, `/api` proxy to `:8787`, exposes `VITE_` and `GOOGLE_` env vars to frontend |
| `tailwind.config.js` | Extends fonts: Space Grotesk (display), IBM Plex Mono (mono) |
| `eslint.config.js` | Lints `src/` only; `server/` and `dist/` are excluded |

## Fallback Mode

When `GOOGLE_MAPS_API_KEY` is missing:
- Backend uses haversine distance (no real traffic data); `provider` field returns `"fallback"`
- Frontend disables the address input and Places Autocomplete, shows a warning
- Map click still works for setting origin
- All routing and telemetry still function with estimated distances
