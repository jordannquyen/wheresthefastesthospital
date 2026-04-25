import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { Client } from "@googlemaps/google-maps-services-js";

dotenv.config();

const requests = {};

const app = express();
const googleMapsClient = new Client({});
const port = Number(process.env.PORT || 8787);
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

app.use(cors());
app.use(express.json());

// Keep only the most recent record per hospital_pk (Socrata returns multiple weeks)
function deduplicateByLatestWeek(rawRecords) {
  const seen = new Map();
  for (const h of rawRecords) {
    if (!seen.has(h.hospital_pk) || h.collection_week > seen.get(h.hospital_pk).collection_week) {
      seen.set(h.hospital_pk, h);
    }
  }
  return [...seen.values()];
}

// Helper function to fetch hospitals for the entire state and filter by distance
async function fetchHospitalsByDistance(lat, lng, radiusMiles = 50) {
  try {
    // Fetch all CA hospitals, most recent week first
    const socrataUrl = new URL("https://healthdata.gov/resource/anag-cw7u.json");
    socrataUrl.searchParams.set("$limit", 1000);
    socrataUrl.searchParams.set("state", "CA");
    socrataUrl.searchParams.set("$order", "collection_week DESC");

    const response = await fetch(socrataUrl.toString(), { timeout: 5000 });
    if (!response.ok) throw new Error(`Socrata API returned ${response.status}`);

    const raw = await response.json();
    const hospitals = deduplicateByLatestWeek(raw.filter((h) => h.geocoded_hospital_address));

    const mapped = hospitals
      .map((h) => {
        const coords = h.geocoded_hospital_address?.coordinates;
        const inpatientUsed = parseFloat(h.inpatient_beds_used_7_day_avg) || 0;
        const inpatientTotal = parseFloat(h.inpatient_beds_7_day_avg) || 1;
        const icuUsed = parseFloat(h.staffed_adult_icu_bed_occupancy_7_day_avg) || 0;
        const icuTotal = parseFloat(h.total_staffed_adult_icu_beds_7_day_avg) || 1;

        const hospitalLat = coords ? coords[1] : null;
        const hospitalLng = coords ? coords[0] : null;
        const distance = hospitalLat && hospitalLng ? haversineMiles(lat, lng, hospitalLat, hospitalLng) : 999;

        return {
          id: h.hospital_pk,
          name: h.hospital_name,
          lat: hospitalLat,
          lng: hospitalLng,
          address: h.address,
          city: h.city,
          state: h.state,
          zip: h.zip,
          distance: Number(distance.toFixed(2)),
          beds: {
            inpatient_total: inpatientTotal,
            inpatient_used: inpatientUsed,
            inpatient_utilization: Math.round((inpatientUsed / inpatientTotal) * 100),
            icu_total: icuTotal,
            icu_used: icuUsed,
            icu_utilization: Math.round((icuUsed / icuTotal) * 100),
          },
          collectionDate: h.collection_week,
        };
      });

    // Filter by distance radius and sort by distance
    return mapped
      .filter((h) => h.distance <= radiusMiles)
      .sort((a, b) => a.distance - b.distance);
  } catch (error) {
    console.error("Failed to fetch hospitals by distance:", error);
    return [];
  }
}

// Cache hospitals to avoid excessive API calls
let cachedHospitals = [];
let cacheTimestamp = 0;
const CACHE_DURATION = 3600000; // 1 hour

async function fetchAndCacheHospitals(city = "LOS ANGELES", state = "CA", limit = 150) {
  const cacheKey = `${city}|${state}`;
  const now = Date.now();
  
  // Return cache if still valid
  if (cachedHospitals.length > 0 && now - cacheTimestamp < CACHE_DURATION) {
    return cachedHospitals;
  }

  try {
    const socrataUrl = new URL("https://healthdata.gov/resource/anag-cw7u.json");
    socrataUrl.searchParams.set("$limit", limit);
    socrataUrl.searchParams.set("state", state);
    socrataUrl.searchParams.set("$where", `city='${city}'`);
    socrataUrl.searchParams.set("$order", "collection_week DESC");

    const response = await fetch(socrataUrl.toString(), { timeout: 5000 });
    if (!response.ok) throw new Error(`Socrata API returned ${response.status}`);

    const raw = await response.json();
    const hospitals = deduplicateByLatestWeek(raw.filter((h) => h.geocoded_hospital_address));

    cachedHospitals = hospitals
      .map((h) => {
        const coords = h.geocoded_hospital_address?.coordinates;
        const inpatientUsed = parseFloat(h.inpatient_beds_used_7_day_avg) || 0;
        const inpatientTotal = parseFloat(h.inpatient_beds_7_day_avg) || 1;
        const icuUsed = parseFloat(h.staffed_adult_icu_bed_occupancy_7_day_avg) || 0;
        const icuTotal = parseFloat(h.total_staffed_adult_icu_beds_7_day_avg) || 1;

        return {
          id: h.hospital_pk,
          name: h.hospital_name,
          lat: coords ? coords[1] : null,
          lng: coords ? coords[0] : null,
          address: h.address,
          city: h.city,
          state: h.state,
          zip: h.zip,
          beds: {
            inpatient_total: inpatientTotal,
            inpatient_used: inpatientUsed,
            inpatient_utilization: Math.round((inpatientUsed / inpatientTotal) * 100),
            icu_total: icuTotal,
            icu_used: icuUsed,
            icu_utilization: Math.round((icuUsed / icuTotal) * 100),
          },
          collectionDate: h.collection_week,
        };
      });

    cacheTimestamp = now;
    return cachedHospitals;
  } catch (error) {
    console.error("Failed to fetch hospitals from Socrata:", error);
    return cachedHospitals; // Return stale cache on error
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: googleMapsApiKey ? "google" : "fallback" });
});

app.get("/api/nodes", async (req, res) => {
  const { city, state = "CA" } = req.query;
  
  // If no city/state provided, return empty (global view)
  if (!city) {
    res.json({ nodes: [] });
    return;
  }
  
  const hospitals = await fetchAndCacheHospitals(city.toUpperCase(), state);
  res.json({ nodes: hospitals });
});

app.post("/api/hospitals-by-coords", async (req, res) => {
  const { lat, lng } = req.body ?? {};
  
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }

  try {
    const hospitals = await fetchHospitalsByDistance(lat, lng, 50);
    res.json({ nodes: hospitals });
  } catch (error) {
    console.error("Error fetching hospitals by coords:", error);
    res.status(500).json({ error: "Failed to fetch hospitals for location" });
  }
});

app.get("/api/telemetry", async (req, res) => {
  const { city, state = "CA" } = req.query;
  
  // If no city/state, return empty telemetry
  if (!city) {
    res.json({ updatedAt: new Date().toISOString(), nodes: {} });
    return;
  }
  
  const hospitals = await fetchAndCacheHospitals(city.toUpperCase(), state);
  
  // Generate telemetry from real bed utilization data
  const telemetryNodes = Object.fromEntries(
    hospitals.map((h) => [
      h.id,
      {
        utilization: h.beds.inpatient_utilization / 100,
        waitMins: Math.round(10 + h.beds.inpatient_utilization * 0.5),
        availableBeds: Math.round(h.beds.inpatient_total - h.beds.inpatient_used),
        updatedAt: new Date().toISOString(),
      },
    ])
  );

  res.json({ updatedAt: new Date().toISOString(), nodes: telemetryNodes });
});

app.get("/api/hospitals", async (req, res) => {
  const { city, state = "CA", limit = 100 } = req.query;

  try {
    const socrataUrl = new URL("https://healthdata.gov/resource/anag-cw7u.json");
    socrataUrl.searchParams.set("$limit", limit);
    socrataUrl.searchParams.set("state", state);
    
    // City parameter is optional and matches in UPPERCASE
    if (city) {
      socrataUrl.searchParams.set("$where", `city='${city.toUpperCase()}'`);
    }

    const response = await fetch(socrataUrl.toString(), {
      timeout: 5000,
    });

    if (!response.ok) {
      throw new Error(`Socrata API returned ${response.status}`);
    }

    const hospitals = await response.json();

    // Transform and normalize the data for the frontend
    const transformed = hospitals
      .filter((h) => h.geocoded_hospital_address) // Only include hospitals with coordinates
      .map((h) => {
        const coords = h.geocoded_hospital_address?.coordinates;
        return {
          id: h.hospital_pk,
          name: h.hospital_name,
          address: h.address,
          city: h.city,
          state: h.state,
          zip: h.zip,
          location: coords
            ? {
                lat: coords[1], // GeoJSON is [lng, lat]
                lng: coords[0],
              }
            : null,
          beds: {
            inpatient_total: parseFloat(h.inpatient_beds_7_day_avg) || 0,
            inpatient_used: parseFloat(h.inpatient_beds_used_7_day_avg) || 0,
            inpatient_utilization: h.inpatient_beds_used_7_day_avg && h.inpatient_beds_7_day_avg
              ? Math.round((parseFloat(h.inpatient_beds_used_7_day_avg) / parseFloat(h.inpatient_beds_7_day_avg)) * 100)
              : 0,
            icu_total: parseFloat(h.total_staffed_adult_icu_beds_7_day_avg) || 0,
            icu_used: parseFloat(h.staffed_adult_icu_bed_occupancy_7_day_avg) || 0,
            icu_utilization: h.staffed_adult_icu_bed_occupancy_7_day_avg && h.total_staffed_adult_icu_beds_7_day_avg
              ? Math.round((parseFloat(h.staffed_adult_icu_bed_occupancy_7_day_avg) / parseFloat(h.total_staffed_adult_icu_beds_7_day_avg)) * 100)
              : 0,
          },
          collectionDate: h.collection_week,
        };
      });

    res.json({ hospitals: transformed, count: transformed.length });
  } catch (error) {
    console.error("Socrata fetch error", error);
    res.status(500).json({ error: "Failed to fetch hospital data" });
  }
});

app.post("/api/geocode", async (req, res) => {
  const { address } = req.body ?? {};

  if (!address || typeof address !== "string") {
    return res.status(400).json({ error: "address is required" });
  }

  if (!googleMapsApiKey) {
    return res.status(400).json({ error: "GOOGLE_MAPS_API_KEY is required for address geocoding" });
  }

  try {
    const response = await googleMapsClient.geocode({
      params: {
        address,
        region: "us",
        key: googleMapsApiKey,
      },
      timeout: 3500,
    });

    const first = response.data.results?.[0];
    if (!first) {
      return res.status(404).json({ error: "Address not found" });
    }

    return res.json({
      formattedAddress: first.formatted_address,
      location: {
        lat: first.geometry.location.lat,
        lng: first.geometry.location.lng,
      },
    });
  } catch (error) {
    console.error("Geocode error", error);
    return res.status(500).json({ error: "Failed to geocode address" });
  }
});

app.post("/api/route", async (req, res) => {
  const { origin, specification, insurance } = req.body ?? {};
  if (!origin || typeof origin.lat !== "number" || typeof origin.lng !== "number") {
    return res.status(400).json({ error: "origin.lat and origin.lng are required numeric fields" });
  }

  try {
    const routeResult = await computeRoute(origin, specification, insurance);
    res.json(routeResult);
  } catch (error) {
    console.error("Routing error", error);
    res.status(500).json({ error: "Failed to compute route" });
  }
});

app.listen(port, () => {
  console.log(`backend listening on http://localhost:${port}`);
});

async function computeRoute(origin, specification, insurance) {
  // Fetch hospitals for the input location
  const allNodes = await fetchHospitalsByDistance(origin.lat, origin.lng, 50);
  const normalizedSpecification = normalizeSpecification(specification);
  const normalizedInsurance = normalizeInsurance(insurance);

  // Google Distance Matrix allows max 25 destinations per request; nodes are pre-sorted by haversine
  const nodes = allNodes.slice(0, 25);

  const trafficResults = await getTravelMetrics(origin, nodes);

  const scored = nodes.map((node, index) => {
    const traffic = trafficResults[index];
    const availableBeds = Math.round(node.beds.inpatient_total - node.beds.inpatient_used);
    const waitMins = Math.round(10 + (node.beds.inpatient_utilization * 0.5)); // Estimated wait based on utilization
    const utilization = node.beds.inpatient_utilization / 100;

    return {
      ...node,
      waitMins,
      utilization,
      availableBeds,
      distanceMiles: traffic.distanceMiles,
      durationMins: traffic.durationMins,
      status,
    };
  });

  const ranked = [...scored].sort((a, b) => {
    // Primary: sort by distance
    if (a.distanceMiles !== b.distanceMiles) {
      return a.distanceMiles - b.distanceMiles;
    }
    // Secondary: more available beds is better
    if (a.availableBeds !== b.availableBeds) {
      return b.availableBeds - a.availableBeds;
    }
    // Tertiary: lower wait time is better
    return a.waitMins - b.waitMins;
  });

  // Filter by clinical specification if provided
  let candidates = normalizedSpecification
    ? ranked.filter((node) => (node.centerTypes ?? []).includes(normalizedSpecification))
    : ranked;

  // Filter by insurance if provided
  if (normalizedInsurance) {
    candidates = candidates.filter((node) =>
      (node.acceptedInsurance ?? []).includes(normalizedInsurance)
    );
  }

  const activeRanking = candidates.length > 0 ? candidates : ranked;

  const top3 = activeRanking.slice(0, 3);
  const closest = [...scored].sort((a, b) => a.distanceMiles - b.distanceMiles)[0];
  const recommended = top3[0] ?? closest;

  return {
    origin,
    specification: normalizedSpecification,
    specificationMatchFound: candidates.length > 0 || !normalizedSpecification,
    insurance: normalizedInsurance,
    insuranceMatchFound: !normalizedInsurance || candidates.some((node) => (node.acceptedInsurance ?? []).includes(normalizedInsurance)),
    model: "score = specialty × status × availableBeds / (ETA + waitMins)",
    closest,
    recommended,
    top3,
    candidates: activeRanking,
    provider: googleMapsApiKey ? "google" : "fallback",
    generatedAt: new Date().toISOString(),
  };
}

function normalizeSpecification(input) {
  if (!input || typeof input !== "string") {
    return null;
  }

  const normalized = input.trim().toLowerCase();
  if (["stemi", "stroke", "trauma"].includes(normalized)) {
    return normalized;
  }

  return null;
}

function normalizeInsurance(input) {
  if (!input || typeof input !== "string") {
    return null;
  }

  const normalized = input.trim();
  const validInsurance = ["Medicare", "Medicaid", "Blue Cross", "Aetna", "United Healthcare", "Cigna", "Kaiser"];
  if (validInsurance.includes(normalized)) {
    return normalized;
  }

  return null;
}

async function getTravelMetrics(origin, nodes) {
  if (!googleMapsApiKey) {
    return nodes.map((node) => {
      const distanceMiles = haversineMiles(origin.lat, origin.lng, node.lat, node.lng);
      const durationMins = Math.round((distanceMiles / 24) * 60);
      return { distanceMiles: Number(distanceMiles.toFixed(2)), durationMins };
    });
  }

  const response = await googleMapsClient.distancematrix({
    params: {
      origins: [`${origin.lat},${origin.lng}`],
      destinations: nodes.map((node) => `${node.lat},${node.lng}`),
      departure_time: "now",
      traffic_model: "best_guess",
      key: googleMapsApiKey,
    },
    timeout: 3500,
  });

  const matrixRow = response.data.rows?.[0]?.elements ?? [];

  return matrixRow.map((element, index) => {
    if (element.status !== "OK") {
      const node = nodes[index];
      const distanceMiles = haversineMiles(origin.lat, origin.lng, node.lat, node.lng);
      const durationMins = Math.round((distanceMiles / 24) * 60);
      return { distanceMiles: Number(distanceMiles.toFixed(2)), durationMins };
    }

    const distanceMiles = Number((element.distance.value / 1609.344).toFixed(2));
    const durationSource = element.duration_in_traffic?.value ?? element.duration?.value ?? 0;
    const durationMins = Math.round(durationSource / 60);

    return {
      distanceMiles,
      durationMins,
    };
  });
}

function shouldAutoApprove(hospitalId) {
  const state = getTelemetry().nodes[hospitalId];
  if (!state) return false;
  return deriveStatus(state.utilization) === "Open"
    && state.availableBeds >= 5
    && state.waitMins <= 60;
}

function deriveStatus(utilization) {
  if (utilization >= 0.95) return "Diversion";
  if (utilization >= 0.80) return "Saturation";
  return "Open";
}

function scoreHospital(node, spec) {
  const STATUS_MULTIPLIER = { Open: 1.0, Saturation: 0.5, Diversion: 0 };
  const timeToTreatment = (node.durationMins + node.waitMins) || 1;
  const specialty = spec
    ? (node.centerTypes ?? []).includes(spec) ? 3.0 : 0.5
    : 1.0;
  const status = STATUS_MULTIPLIER[node.status] ?? 1.0;
  return specialty * status * node.availableBeds / timeToTreatment;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const dToR = (deg) => (deg * Math.PI) / 180;
  const earthMiles = 3958.8;

  const dLat = dToR(lat2 - lat1);
  const dLon = dToR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(dToR(lat1)) * Math.cos(dToR(lat2)) * Math.sin(dLon / 2) ** 2;

  return earthMiles * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
