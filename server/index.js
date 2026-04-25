import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { Client } from "@googlemaps/google-maps-services-js";
import { getNodes, getTelemetry, jitterTelemetry } from "./telemetry.js";

dotenv.config();

const requests = {};
const dispatches = {};
const hospitalOverrides = {}; // { [hospitalId]: "Open" | "Saturation" | "Diversion" }
// dispatch shape:
// { dispatchId, chain: [{hospitalId, hospitalName, etaMins}], currentIndex,
//   patientSpec, insurance, activeRequestId, status: "active"|"accepted"|"exhausted", createdAt }

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

app.post("/api/dispatch", (req, res) => {
  const { chain, patientSpec, insurance } = req.body ?? {};
  const knownIds = getNodes().map((n) => n.id);

  if (!Array.isArray(chain) || chain.length === 0) {
    return res.status(400).json({ error: "chain must be a non-empty array" });
  }
  if (chain.some((h) => !knownIds.includes(h.hospitalId))) {
    return res.status(400).json({ error: "all chain entries must have a valid hospitalId" });
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

  return res.json({ dispatchId, requestId, status: requests[requestId].status, autoApproved: requests[requestId].autoApproved });
});

app.get("/api/dispatch/:dispatchId", (req, res) => {
  const dispatch = dispatches[req.params.dispatchId];
  if (!dispatch) return res.status(404).json({ error: "dispatch not found" });

  const activeRequest = requests[dispatch.activeRequestId] ?? null;
  const chainWithStatus = dispatch.chain.map((entry, index) => {
    const req = Object.values(requests).find(
      (r) => r.dispatchId === dispatch.dispatchId && r.chainIndex === index
    );
    return { ...entry, requestStatus: req?.status ?? null, requestId: req?.requestId ?? null };
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
      } else {
        dispatch.status = "exhausted";
      }
    }
  }

  return res.json({ ok: true, requestId, status, dispatch: dispatch ?? null });
});

app.post("/api/admin/override", (req, res) => {
  const { hospitalId, status } = req.body ?? {};
  const knownIds = getNodes().map((n) => n.id);
  if (!knownIds.includes(hospitalId)) return res.status(400).json({ error: "invalid hospitalId" });
  if (!["Open", "Saturation", "Diversion"].includes(status)) return res.status(400).json({ error: "status must be Open, Saturation, or Diversion" });
  hospitalOverrides[hospitalId] = status;
  return res.json({ ok: true, hospitalId, status });
});

app.delete("/api/admin/override/:hospitalId", (req, res) => {
  delete hospitalOverrides[req.params.hospitalId];
  return res.json({ ok: true, hospitalId: req.params.hospitalId });
});

app.get("/api/admin/overrides", (_req, res) => {
  const telemetry = getTelemetry().nodes;
  const nodes = getNodes();
  const summary = nodes.map((node) => ({
    hospitalId: node.id,
    hospitalName: node.name,
    override: hospitalOverrides[node.id] ?? null,
    autoStatus: deriveStatus(telemetry[node.id]?.utilization ?? 0),
    effectiveStatus: getEffectiveStatus(node.id, telemetry[node.id]?.utilization ?? 0),
    utilization: telemetry[node.id]?.utilization ?? null,
    availableBeds: telemetry[node.id]?.availableBeds ?? null,
    waitMins: telemetry[node.id]?.waitMins ?? null,
  }));
  return res.json({ overrides: hospitalOverrides, hospitals: summary });
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

function createRequest(dispatch, chainIndex, escalatedFromName) {
  const entry = dispatch.chain[chainIndex];
  const autoApproved = shouldAutoApprove(entry.hospitalId);
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

function shouldAutoApprove(hospitalId) {
  const state = getTelemetry().nodes[hospitalId];
  if (!state) return false;
  const status = hospitalOverrides[hospitalId] ?? deriveStatus(state.utilization);
  return status === "Open" && state.availableBeds >= 5 && state.waitMins <= 60;
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
