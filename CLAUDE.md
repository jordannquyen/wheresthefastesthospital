# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**WTF — Where's The Fastest Hospital** is a healthcare routing demo. It ranks nearby LA hospitals by distance, real-time capacity, and optional filters (clinical specialty, insurance), then visualizes results on an interactive Google Map.

## Commands

```bash
npm install          # Install all dependencies (required before first run)
npm run dev          # Run frontend (Vite, port 5173) + backend (Express, port 8787) concurrently
npm run dev:client   # Frontend only
npm run dev:server   # Backend only (node --watch)
npm run build        # Production build
npm run lint         # ESLint
```

## Environment

Requires a `.env` file at the project root:

```
GOOGLE_MAPS_API_KEY=your_key_here
PORT=8787
```

The app degrades gracefully without a key: the map won't load, geocoding fails, and the backend falls back to haversine distance estimation instead of Google Distance Matrix.

## Architecture

**Frontend** (`src/`) — React 18 + Vite + Tailwind CSS (Space Grotesk / IBM Plex Mono fonts). Single component in `App.jsx` manages all state. Vite proxies `/api/*` to `localhost:8787` in development.

**Backend** (`server/`) — Express on port 8787.
- `nodes.json` — static list of 8 LA hospitals (location, specialty, accepted insurance)
- `telemetry.js` — in-memory simulation of hospital metrics (utilization, wait times, beds); jitters every 10 seconds
- `index.js` — REST API: `/api/nodes`, `/api/telemetry`, `/api/geocode`, `/api/route`, `/api/health`

**Routing algorithm** (`POST /api/route`): ranks hospitals by distance (ascending) → available capacity (descending) → wait time. Accepts optional `spec` (STEMI/Stroke/Trauma) and `insurance` filters. Uses Google Distance Matrix API if key is present, otherwise haversine.

**Real-time loop**: Frontend polls `/api/telemetry` every 10 seconds. Markers pulse red when utilization ≥ 90%.

## Key Frontend Behaviors

- Clicking the map immediately triggers routing from that point (no geocode needed)
- Address search uses Google Places Autocomplete, then POSTs to `/api/geocode`
- Map polylines: grey dashed = closest by distance only, bright blue = recommended, cyan = alternatives
- Marker color: green < 50% utilization, yellow 50–89%, pulsing red ≥ 90%
