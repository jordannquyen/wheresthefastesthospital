import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { Client } from "@googlemaps/google-maps-services-js";
import { getNodes, getTelemetry, jitterTelemetry } from "./telemetry.js";

dotenv.config();

const requests = {};

const app = express();
const googleMapsClient = new Client({});
const port = Number(process.env.PORT || 8787);
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: googleMapsApiKey ? "google" : "fallback" });
});

app.get("/api/nodes", (_req, res) => {
  res.json({ nodes: getNodes() });
});

app.get("/api/telemetry", (_req, res) => {
  res.json(getTelemetry());
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

app.post("/api/requests", (req, res) => {
  const { hospitalId, hospitalName, patientSpec, insurance, etaMins } = req.body ?? {};
  const knownIds = getNodes().map((n) => n.id);
  if (!hospitalId || !knownIds.includes(hospitalId)) {
    return res.status(400).json({ error: "valid hospitalId is required" });
  }

  const autoApproved = shouldAutoApprove(hospitalId);
  const requestId = randomUUID();
  requests[requestId] = {
    requestId,
    hospitalId,
    hospitalName: hospitalName ?? hospitalId,
    patientSpec: patientSpec ?? null,
    insurance: insurance ?? null,
    etaMins: etaMins ?? null,
    status: autoApproved ? "accepted" : "pending",
    autoApproved,
    requestedAt: new Date().toISOString(),
  };

  return res.json({ requestId, status: requests[requestId].status, autoApproved });
});

app.get("/api/requests", (req, res) => {
  const { hospitalId } = req.query;
  let list = Object.values(requests);
  if (hospitalId) {
    list = list.filter((r) => r.hospitalId === hospitalId);
  }
  list.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  res.json({ requests: list });
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
  return res.json({ ok: true, requestId, status });
});

setInterval(() => {
  jitterTelemetry();
}, 10_000);

app.listen(port, () => {
  console.log(`Vital-Route backend listening on http://localhost:${port}`);
});

async function computeRoute(origin, specification, insurance) {
  const nodes = getNodes();
  const telemetry = getTelemetry().nodes;
  const normalizedSpecification = normalizeSpecification(specification);
  const normalizedInsurance = normalizeInsurance(insurance);

  const trafficResults = await getTravelMetrics(origin, nodes);

  const scored = nodes.map((node, index) => {
    const state = telemetry[node.id];
    const traffic = trafficResults[index];
    const status = deriveStatus(state.utilization);

    return {
      ...node,
      waitMins: state.waitMins,
      utilization: state.utilization,
      availableBeds: state.availableBeds,
      distanceMiles: traffic.distanceMiles,
      durationMins: traffic.durationMins,
      status,
    };
  });

  const ranked = [...scored]
    .map((node) => ({
      ...node,
      score: scoreHospital(node, normalizedSpecification),
    }))
    .sort((a, b) => b.score - a.score);

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
