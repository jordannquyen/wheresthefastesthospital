# Vital-Route LA Demo

Vital-Route is a healthcare network routing demo that treats patients as packets and hospitals as nodes. The app visualizes congestion and ranks the top 3 hospital choices by distance first, then available capacity.

## What this demo includes

- Real-time hospital data from HHS Socrata API (no auth required)
- Global map view initially, then fetches hospitals within 50 miles of entered address
- Address-based location input (example: "200 N Spring St, Los Angeles") that geocodes to coordinates
- Address autocomplete using Google Places so users can pick addresses without typing full strings
- Real bed capacity and utilization data from HHS hospitals dataset (last reported occupancy)
- Top-3 hospital ranking logic:
	- primary: shortest distance
	- secondary tie-breaker: higher available beds
	- tertiary: lower estimated wait time based on utilization

- Google Distance Matrix integration for real-time traffic-aware travel metrics
- Frontend dashboard with:
	- glowing utilization circles (green, yellow, red pulse) based on real bed data
	- address or click-to-route for patient origin points
	- grey dashed line for closest-hospital baseline
	- bright blue line for top recommendation
	- in-map legend (bottom-right)

## Architecture

- Frontend: React + Tailwind + Google Maps JavaScript API
- Backend: Express (Node.js) + Socrata API client + Distance Matrix client
- Data model:
	- Real-time hospitals fetched from HHS Socrata API https://healthdata.gov/resource/anag-cw7u.json
	- Hospitals within 50-mile radius sorted by distance from input location
	- [server/index.js](server/index.js): API endpoints and routing logic

## API endpoints

- GET /api/health
- GET /api/nodes (returns empty initially, expects city/state query params)
- POST /api/hospitals-by-coords
	- body: { "lat": 34.0522, "lng": -118.2437 }
	- Returns hospitals within 50 miles sorted by distance
- GET /api/telemetry (returns empty initially)
- POST /api/geocode
	- body: { "address": "200 N Spring St, Los Angeles" }
- POST /api/route
	- body: { "origin": { "lat": 34.02, "lng": -118.49 }, "specification": "stemi|stroke|trauma" (optional) }

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Add API keys in .env:

- GOOGLE_MAPS_API_KEY

4. Start frontend + backend:

```bash
npm run dev
```

5. Open the app URL shown by Vite (usually http://localhost:5173).

## Demo script for pitch

1. Discovery: Enter an LA address and compute recommendations.
2. Explain ranking: show that top 3 is distance-first with capacity as the tie-breaker.
3. Compare: highlight nearest baseline vs best ranked option and discuss capacity tradeoffs.

## Notes

- If GOOGLE_MAPS_API_KEY is absent, backend automatically falls back to haversine estimates.
- Address lookup requires GOOGLE_MAPS_API_KEY for geocoding.
- Address autocomplete requires GOOGLE_MAPS_API_KEY with Places API enabled.
