import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { Client } from "@googlemaps/google-maps-services-js";

dotenv.config();

const requests = {};
const dispatches = {};
const hospitalOverrides = {}; // { [hospitalId]: "Open" | "Saturation" | "Diversion" }

const app = express();
const googleMapsClient = new Client({});
const port = Number(process.env.PORT || 8787);
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

app.use(cors());
app.use(express.json());

function deduplicateByLatestWeek(rawRecords) {
  const seen = new Map();
  for (const h of rawRecords) {
    if (!seen.has(h.hospital_pk) || h.collection_week > seen.get(h.hospital_pk).collection_week) {
      seen.set(h.hospital_pk, h);
    }
  }
  return [...seen.values()];
}

async function fetchHospitalsByDistance(lat, lng, radiusMiles = 50) {
  try {
    const socrataUrl = new URL("https://healthdata.gov/resource/anag-cw7u.json");
    socrataUrl.searchParams.set("$limit", 1000);
    socrataUrl.searchParams.set("state", "CA");
    socrataUrl.searchParams.set("$order", "collection_week DESC");

    const response = await fetch(socrataUrl.toString(), { timeout: 5000 });
    if (!response.ok) throw new Error(`Socrata API returned ${response.status}`);

    const raw = await response.json();
    const hospitals = deduplicateByLatestWeek(raw.filter((h) => h.geocoded_hospital_address));

    const mapped = hospitals.map((h) => {
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

    return mapped.filter((h) => h.distance <= radiusMiles).sort((a, b) => a.distance - b.distance);
  } catch (error) {
    console.error("Failed to fetch hospitals by distance:", error);
    return [];
  }
}

let cachedHospitals = [];
let cacheTimestamp = 0;
const CACHE_DURATION = 3600000;

async function fetchAndCacheHospitals(city = "LOS ANGELES", state = "CA", limit = 150) {
  const now = Date.now();
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

    cachedHospitals = hospitals.map((h) => {
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
    return cachedHospitals;
  }
}

// --- Core endpoints ---

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: googleMapsApiKey ? "google" : "fallback" });
});

app.get("/api/nodes", async (req, res) => {
  const { city, state = "CA" } = req.query;
  if (!city) return res.json({ nodes: [] });
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
  if (!city) return res.json({ updatedAt: new Date().toISOString(), nodes: {} });

  const hospitals = await fetchAndCacheHospitals(city.toUpperCase(), state);
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
    if (city) socrataUrl.searchParams.set("$where", `city='${city.toUpperCase()}'`);

    const response = await fetch(socrataUrl.toString(), { timeout: 5000 });
    if (!response.ok) throw new Error(`Socrata API returned ${response.status}`);

    const hospitals = await response.json();
    const transformed = hospitals
      .filter((h) => h.geocoded_hospital_address)
      .map((h) => {
        const coords = h.geocoded_hospital_address?.coordinates;
        return {
          id: h.hospital_pk,
          name: h.hospital_name,
          address: h.address,
          city: h.city,
          state: h.state,
          zip: h.zip,
          location: coords ? { lat: coords[1], lng: coords[0] } : null,
          beds: {
            inpatient_total: parseFloat(h.inpatient_beds_7_day_avg) || 0,
            inpatient_used: parseFloat(h.inpatient_beds_used_7_day_avg) || 0,
            inpatient_utilization:
              h.inpatient_beds_used_7_day_avg && h.inpatient_beds_7_day_avg
                ? Math.round(
                    (parseFloat(h.inpatient_beds_used_7_day_avg) /
                      parseFloat(h.inpatient_beds_7_day_avg)) *
                      100
                  )
                : 0,
            icu_total: parseFloat(h.total_staffed_adult_icu_beds_7_day_avg) || 0,
            icu_used: parseFloat(h.staffed_adult_icu_bed_occupancy_7_day_avg) || 0,
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
      params: { address, region: "us", key: googleMapsApiKey },
      timeout: 3500,
    });
    const first = response.data.results?.[0];
    if (!first) return res.status(404).json({ error: "Address not found" });
    return res.json({
      formattedAddress: first.formatted_address,
      location: { lat: first.geometry.location.lat, lng: first.geometry.location.lng },
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

// --- Dispatch endpoints ---

app.post("/api/dispatch", (req, res) => {
  const { chain, patientSpec, insurance } = req.body ?? {};
  if (!Array.isArray(chain) || chain.length === 0) {
    return res.status(400).json({ error: "chain must be a non-empty array" });
  }

  const dispatchId = randomUUID();
  const dispatch = {
    dispatchId,
    chain,
    currentIndex: 0,
    patientSpec: patientSpec ?? null,
    insurance: insurance ?? null,
    activeRequestId: null,
    status: "active",
    createdAt: new Date().toISOString(),
  };
  dispatches[dispatchId] = dispatch;

  const requestId = createRequest(dispatch, 0, null);
  dispatch.activeRequestId = requestId;
  if (requests[requestId].status === "accepted") dispatch.status = "accepted";

  return res.json({ dispatchId, requestId, status: requests[requestId].status, autoApproved: requests[requestId].autoApproved });
});

app.get("/api/dispatch/:dispatchId", (req, res) => {
  const dispatch = dispatches[req.params.dispatchId];
  if (!dispatch) return res.status(404).json({ error: "dispatch not found" });

  const activeRequest = requests[dispatch.activeRequestId] ?? null;
  const chainWithStatus = dispatch.chain.map((entry, index) => {
    const r = Object.values(requests).find(
      (r) => r.dispatchId === dispatch.dispatchId && r.chainIndex === index
    );
    return { ...entry, requestStatus: r?.status ?? null, requestId: r?.requestId ?? null };
  });

  return res.json({
    dispatchId: dispatch.dispatchId,
    status: dispatch.status,
    currentIndex: dispatch.currentIndex,
    currentHospital: dispatch.chain[dispatch.currentIndex] ?? null,
    activeRequest,
    chain: chainWithStatus,
    patientSpec: dispatch.patientSpec,
    insurance: dispatch.insurance,
  });
});

// --- Request endpoints ---

app.get("/api/requests", (req, res) => {
  const { hospitalId } = req.query;
  let result = Object.values(requests);
  if (hospitalId) result = result.filter((r) => r.hospitalId === hospitalId);
  result.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  res.json({ requests: result });
});

app.patch("/api/requests/:requestId", (req, res) => {
  const { requestId } = req.params;
  const { status } = req.body ?? {};
  const record = requests[requestId];

  if (!record) return res.status(404).json({ error: "request not found" });
  if (record.status !== "pending") return res.status(409).json({ error: "request already resolved" });
  if (status !== "accepted" && status !== "diverted") {
    return res.status(400).json({ error: "status must be accepted or diverted" });
  }

  record.status = status;

  const dispatch = record.dispatchId ? dispatches[record.dispatchId] : null;
  if (dispatch) {
    if (status === "accepted") {
      dispatch.status = "accepted";
    } else if (status === "diverted") {
      const nextIndex = dispatch.currentIndex + 1;
      if (nextIndex < dispatch.chain.length) {
        dispatch.currentIndex = nextIndex;
        const nextRequestId = createRequest(dispatch, nextIndex, record.hospitalName);
        dispatch.activeRequestId = nextRequestId;
        if (requests[nextRequestId].status === "accepted") dispatch.status = "accepted";
      } else {
        dispatch.status = "exhausted";
      }
    }
  }

  return res.json({ ok: true, requestId, status, dispatch: dispatch ?? null });
});

// --- Admin override endpoints ---

app.post("/api/admin/override", (req, res) => {
  const { hospitalId, status } = req.body ?? {};
  if (!["Open", "Saturation", "Diversion"].includes(status)) {
    return res.status(400).json({ error: "status must be Open, Saturation, or Diversion" });
  }
  hospitalOverrides[hospitalId] = status;
  return res.json({ ok: true, hospitalId, status });
});

app.delete("/api/admin/override/:hospitalId", (req, res) => {
  delete hospitalOverrides[req.params.hospitalId];
  return res.json({ ok: true, hospitalId: req.params.hospitalId });
});

app.get("/api/admin/overrides", (_req, res) => {
  return res.json({ overrides: hospitalOverrides });
});

app.listen(port, () => {
  console.log(`Vital-Route backend listening on http://localhost:${port}`);
});

// --- Routing pipeline ---

async function computeRoute(origin, specification, insurance) {
  const allNodes = await fetchHospitalsByDistance(origin.lat, origin.lng, 50);
  const normalizedSpecification = normalizeSpecification(specification);
  const normalizedInsurance = normalizeInsurance(insurance);
  const nodes = allNodes.slice(0, 25);
  const trafficResults = await getTravelMetrics(origin, nodes);

  const scored = nodes.map((node, index) => {
    const traffic = trafficResults[index];
    const availableBeds = Math.round(node.beds.inpatient_total - node.beds.inpatient_used);
    const waitMins = Math.round(10 + node.beds.inpatient_utilization * 0.5);
    const utilization = node.beds.inpatient_utilization / 100;
    const status = getEffectiveStatus(node.id, utilization);

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

  const ranked = [...scored].sort(
    (a, b) => scoreHospital(b, normalizedSpecification) - scoreHospital(a, normalizedSpecification)
  );

  let candidates = normalizedSpecification
    ? ranked.filter((node) => (node.centerTypes ?? []).includes(normalizedSpecification))
    : ranked;

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
    insuranceMatchFound:
      !normalizedInsurance ||
      candidates.some((node) => (node.acceptedInsurance ?? []).includes(normalizedInsurance)),
    model: "score = specialty x status x availableBeds / (ETA + waitMins)",
    closest,
    recommended,
    top3,
    candidates: activeRanking,
    provider: googleMapsApiKey ? "google" : "fallback",
    generatedAt: new Date().toISOString(),
  };
}

// --- Helper functions ---

function createRequest(dispatch, chainIndex, escalatedFromName) {
  const entry = dispatch.chain[chainIndex];
  const autoApproved = shouldAutoApprove(entry.hospitalId, entry);
  const requestId = randomUUID();
  requests[requestId] = {
    requestId,
    dispatchId: dispatch.dispatchId,
    chainIndex,
    hospitalId: entry.hospitalId,
    hospitalName: entry.hospitalName,
    patientSpec: dispatch.patientSpec,
    insurance: dispatch.insurance,
    etaMins: entry.etaMins,
    escalatedFrom: escalatedFromName ?? null,
    status: autoApproved ? "accepted" : "pending",
    autoApproved,
    requestedAt: new Date().toISOString(),
  };
  return requestId;
}

function shouldAutoApprove(hospitalId, nodeMetrics) {
  const override = hospitalOverrides[hospitalId];
  const utilization = nodeMetrics?.utilization ?? 0;
  const status = override ?? deriveStatus(utilization);
  return status === "Open"
    && (nodeMetrics?.availableBeds ?? 0) >= 5
    && (nodeMetrics?.waitMins ?? 999) <= 60;
}

function getEffectiveStatus(hospitalId, utilization) {
  return hospitalOverrides[hospitalId] ?? deriveStatus(utilization);
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
  return (specialty * status * node.availableBeds) / timeToTreatment;
}

function normalizeSpecification(input) {
  if (!input || typeof input !== "string") return null;
  const normalized = input.trim().toLowerCase();
  return ["stemi", "stroke", "trauma"].includes(normalized) ? normalized : null;
}

function normalizeInsurance(input) {
  if (!input || typeof input !== "string") return null;
  const normalized = input.trim();
  const valid = ["Medicare", "Medicaid", "Blue Cross", "Aetna", "United Healthcare", "Cigna", "Kaiser"];
  return valid.includes(normalized) ? normalized : null;
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
    return { distanceMiles, durationMins: Math.round(durationSource / 60) };
  });
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
