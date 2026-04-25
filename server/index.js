import { Readable } from "node:stream";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { Client } from "@googlemaps/google-maps-services-js";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { MongoClient } from "mongodb";

dotenv.config();

const requests = {};
const dispatches = {};
const hospitalOverrides = {}; // { [hospitalId]: "Open" | "Saturation" | "Diversion" }

const app = express();
const googleMapsClient = new Client({});
const port = Number(process.env.PORT || 8787);
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenlabs = elevenLabsApiKey
  ? new ElevenLabsClient({ apiKey: elevenLabsApiKey })
  : null;
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});
const defaultVoiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME;

let mongoClient = null;
let patientsCollection = null;

app.use(cors());
app.use(express.json());

function getPatientsCollectionOrNull() {
  return patientsCollection;
}

async function initializeMongo() {
  if (!mongoUri || !mongoDbName) {
    console.warn("MongoDB is not configured. Set MONGODB_URI and MONGODB_DB_NAME to enable patient persistence.");
    return;
  }

  mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  const db = mongoClient.db(mongoDbName);
  patientsCollection = db.collection("patients");

  await patientsCollection.createIndexes([
    { key: { patientId: 1 }, unique: true },
    { key: { status: 1 } },
    { key: { specification: 1 } },
    { key: { createdAt: -1 } },
  ]);

  console.log(`Connected to MongoDB Atlas database: ${mongoDbName}`);
}

function normalizePatientInput(body, { allowPartial = false } = {}) {
  const next = {};

  if (body.name !== undefined || !allowPartial) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return { error: "name is required and must be a non-empty string" };
    }
    next.name = body.name.trim();
  }

  if (body.age !== undefined || !allowPartial) {
    if (typeof body.age !== "number" || !Number.isFinite(body.age) || body.age < 0) {
      return { error: "age is required and must be a non-negative number" };
    }
    next.age = Math.floor(body.age);
  }

  if (body.specification !== undefined || !allowPartial) {
    if (typeof body.specification !== "string" || !body.specification.trim()) {
      return { error: "specification is required and must be a non-empty string" };
    }
    next.specification = body.specification.trim().toLowerCase();
  }

  if (body.location !== undefined || !allowPartial) {
    if (
      !body.location
      || typeof body.location !== "object"
      || typeof body.location.lat !== "number"
      || typeof body.location.lng !== "number"
    ) {
      return { error: "location is required and must contain numeric lat and lng" };
    }
    next.location = {
      lat: body.location.lat,
      lng: body.location.lng,
    };
  }

  if (body.status !== undefined || !allowPartial) {
    if (typeof body.status !== "string" || !body.status.trim()) {
      return { error: "status is required and must be a non-empty string" };
    }
    next.status = body.status.trim();
  }

  return { value: next };
}

const ACRONYMS = new Set([
  "LA", "UCLA", "USC", "UCSD", "UCSF", "UC", "ER", "ICU",
  "VA", "US", "USA", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI",
]);

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w+/g, (word) => {
    const upper = word.toUpperCase();
    return ACRONYMS.has(upper) ? upper : word.charAt(0).toUpperCase() + word.slice(1);
  });
}

function deduplicateByLatestWeek(rawRecords) {
  const seen = new Map();
  for (const h of rawRecords) {
    if (!seen.has(h.hospital_pk) || h.collection_week > seen.get(h.hospital_pk).collection_week) {
      seen.set(h.hospital_pk, h);
    }
  }
  return [...seen.values()];
}

// Socrata uses -999999 as a sentinel for unreported values; treat those (and any negative) as 0.
function parseBedCount(val) {
  const n = parseFloat(val);
  return isFinite(n) && n >= 0 ? n : 0;
}

function mapSocrataBeds(h) {
  const inpatientTotal = parseBedCount(h.inpatient_beds_7_day_avg);
  const inpatientUsed = Math.min(parseBedCount(h.inpatient_beds_used_7_day_avg), inpatientTotal || Infinity);
  const icuTotal = parseBedCount(h.total_staffed_adult_icu_beds_7_day_avg);
  const icuUsed = Math.min(parseBedCount(h.staffed_adult_icu_bed_occupancy_7_day_avg), icuTotal || Infinity);
  return {
    inpatient_total: inpatientTotal,
    inpatient_used: inpatientUsed,
    inpatient_utilization: inpatientTotal > 0 ? Math.round((inpatientUsed / inpatientTotal) * 100) : 0,
    icu_total: icuTotal,
    icu_used: icuUsed,
    icu_utilization: icuTotal > 0 ? Math.round((icuUsed / icuTotal) * 100) : 0,
  };
}

// --- NPI Registry integration ---

// hospital_pk → { npiResult: object|null, ts: number }
const npiCache = new Map();
const NPI_CACHE_TTL = 86_400_000; // 24h — NPI data changes rarely

async function fetchNpiData(hospitalName, city, state) {
  try {
    const url = new URL("https://npiregistry.cms.hhs.gov/api/");
    url.searchParams.set("version", "2.1");
    url.searchParams.set("enumeration_type", "NPI-2");
    // Use first 4 words to avoid exact-match failures on long names
    url.searchParams.set("organization_name", hospitalName.split(" ").slice(0, 4).join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("limit", "5");

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const json = await res.json();
    const results = json.results ?? [];
    // Prefer a result whose address matches the hospital city
    return (
      results.find((r) =>
        r.addresses?.some((a) => a.city?.toUpperCase() === city?.toUpperCase())
      ) ?? results[0] ?? null
    );
  } catch {
    return null;
  }
}

async function fetchAndCacheNpi(h) {
  const cached = npiCache.get(h.hospital_pk);
  if (cached && Date.now() - cached.ts < NPI_CACHE_TTL) return;
  const npiResult = await fetchNpiData(h.hospital_name, h.city, h.state);
  npiCache.set(h.hospital_pk, { npiResult, ts: Date.now() });
}

// Infer accepted insurances from CMS certification number, hospital subtype, and NPI taxonomy codes.
// STEMI/stroke/trauma center designation requires state EMS / Joint Commission certification databases
// not available from NPPES — those centerTypes remain unpopulated until a richer source is integrated.
function inferInsurance(h) {
  const name = (h.hospital_name ?? "").toUpperCase();

  // Kaiser operates a closed network — patients with Kaiser insurance must use these facilities.
  // Kaiser hospitals also participate in Medicare/Medicaid, so they carry both tags.
  if (name.includes("KAISER")) return ["Kaiser", "Government"];

  // CCN presence means CMS-certified → accepts Medicare and Medicaid.
  // This is the only commercially verifiable insurance fact from public data.
  if (h.ccn) return ["Government"];

  return [];
}

async function fetchHospitalsByDistance(lat, lng, radiusMiles = 50) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (distanceCache.key === key && Date.now() - distanceCache.ts < DISTANCE_CACHE_TTL) {
    return distanceCache.result;
  }
  try {
    const socrataUrl = new URL("https://healthdata.gov/resource/anag-cw7u.json");
    socrataUrl.searchParams.set("$limit", 1000);
    socrataUrl.searchParams.set("state", "CA");
    socrataUrl.searchParams.set("$order", "collection_week DESC");

    const response = await fetch(socrataUrl.toString(), { timeout: 5000 });
    if (!response.ok) throw new Error(`Socrata API returned ${response.status}`);

    const raw = await response.json();
    const deduplicated = deduplicateByLatestWeek(raw.filter((h) => h.geocoded_hospital_address));

    // Filter to in-range hospitals with valid bed data before NPI enrichment
    const inRange = deduplicated.filter((h) => {
      const coords = h.geocoded_hospital_address?.coordinates;
      if (!coords) return false;
      const beds = mapSocrataBeds(h);
      if (beds.inpatient_total === 0) return false;
      return haversineMiles(lat, lng, coords[1], coords[0]) <= radiusMiles;
    });

    // Fetch NPI data for any hospitals not yet in cache (parallel, best-effort)
    await Promise.allSettled(inRange.map((h) => fetchAndCacheNpi(h)));

    const result = inRange
      .map((h) => {
        const coords = h.geocoded_hospital_address.coordinates;
        const hospitalLat = coords[1];
        const hospitalLng = coords[0];
        const npiResult = npiCache.get(h.hospital_pk)?.npiResult ?? null;
        return {
          id: h.hospital_pk,
          name: toTitleCase(h.hospital_name),
          lat: hospitalLat,
          lng: hospitalLng,
          address: h.address,
          city: h.city,
          state: h.state,
          zip: h.zip,
          distance: Number(haversineMiles(lat, lng, hospitalLat, hospitalLng).toFixed(2)),
          beds: mapSocrataBeds(h),
          acceptedInsurance: inferInsurance(h),
          collectionDate: h.collection_week,
        };
      })
      .sort((a, b) => a.distance - b.distance);

    distanceCache = { key, result, ts: Date.now() };
    return result;
  } catch (error) {
    console.error("Failed to fetch hospitals by distance:", error);
    return distanceCache.result;
  }
}

let distanceCache = { key: null, result: [], ts: 0 };
const DISTANCE_CACHE_TTL = 60000;

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
    const valid = deduplicateByLatestWeek(
      raw.filter((h) => h.geocoded_hospital_address && mapSocrataBeds(h).inpatient_total > 0)
    );

    await Promise.allSettled(valid.map((h) => fetchAndCacheNpi(h)));

    cachedHospitals = valid.map((h) => {
      const coords = h.geocoded_hospital_address.coordinates;
      const npiResult = npiCache.get(h.hospital_pk)?.npiResult ?? null;
      return {
        id: h.hospital_pk,
        name: toTitleCase(h.hospital_name),
        lat: coords[1],
        lng: coords[0],
        address: h.address,
        city: h.city,
        state: h.state,
        zip: h.zip,
        beds: mapSocrataBeds(h),
        acceptedInsurance: inferInsurance(h),
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
  res.json({
    ok: true,
    provider: googleMapsApiKey ? "google" : "fallback",
    voice: Boolean(elevenlabs),
    mongo: getPatientsCollectionOrNull() ? "connected" : "not-configured",
  });
});

// --- Patient endpoints ---

app.post("/api/patients", async (req, res) => {
  const collection = getPatientsCollectionOrNull();
  if (!collection) {
    return res.status(503).json({ error: "MongoDB is not configured. Set MONGODB_URI and MONGODB_DB_NAME." });
  }

  const normalized = normalizePatientInput(req.body ?? {}, { allowPartial: false });
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const now = new Date().toISOString();
  const patient = {
    patientId: randomUUID(),
    ...normalized.value,
    createdAt: now,
    updatedAt: now,
  };

  await collection.insertOne(patient);
  const { _id, ...safePatient } = patient;
  return res.status(201).json({ patient: safePatient });
});

app.get("/api/patients", async (req, res) => {
  const collection = getPatientsCollectionOrNull();
  if (!collection) {
    return res.status(503).json({ error: "MongoDB is not configured. Set MONGODB_URI and MONGODB_DB_NAME." });
  }

  const { status, specification } = req.query;
  const filter = {};
  if (typeof status === "string" && status.trim()) filter.status = status.trim();
  if (typeof specification === "string" && specification.trim()) {
    filter.specification = specification.trim().toLowerCase();
  }

  const patients = await collection
    .find(filter, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();

  return res.json({ patients, count: patients.length });
});

app.get("/api/patients/:patientId", async (req, res) => {
  const collection = getPatientsCollectionOrNull();
  if (!collection) {
    return res.status(503).json({ error: "MongoDB is not configured. Set MONGODB_URI and MONGODB_DB_NAME." });
  }

  const patient = await collection.findOne(
    { patientId: req.params.patientId },
    { projection: { _id: 0 } }
  );
  if (!patient) return res.status(404).json({ error: "patient not found" });
  return res.json({ patient });
});

app.patch("/api/patients/:patientId", async (req, res) => {
  const collection = getPatientsCollectionOrNull();
  if (!collection) {
    return res.status(503).json({ error: "MongoDB is not configured. Set MONGODB_URI and MONGODB_DB_NAME." });
  }

  const normalized = normalizePatientInput(req.body ?? {}, { allowPartial: true });
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  if (Object.keys(normalized.value).length === 0) {
    return res.status(400).json({ error: "No updatable patient fields were provided" });
  }

  const updates = { ...normalized.value, updatedAt: new Date().toISOString() };
  const result = await collection.findOneAndUpdate(
    { patientId: req.params.patientId },
    { $set: updates },
    { returnDocument: "after", projection: { _id: 0 } }
  );

  if (!result) return res.status(404).json({ error: "patient not found" });
  return res.json({ patient: result });
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
        const beds = mapSocrataBeds(h);
        return {
          id: h.hospital_pk,
          name: toTitleCase(h.hospital_name),
          address: h.address,
          city: h.city,
          state: h.state,
          zip: h.zip,
          location: coords ? { lat: coords[1], lng: coords[0] } : null,
          beds,
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
  const { origin, insurance } = req.body ?? {};
  if (!origin || typeof origin.lat !== "number" || typeof origin.lng !== "number") {
    return res.status(400).json({ error: "origin.lat and origin.lng are required numeric fields" });
  }
  try {
    const routeResult = await computeRoute(origin, insurance);
    res.json(routeResult);
  } catch (error) {
    console.error("Routing error", error);
    res.status(500).json({ error: "Failed to compute route" });
  }
});

app.post("/api/stt", uploadAudio.single("audio"), async (req, res) => {
  if (!elevenlabs) {
    return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "audio file is required" });
  }

  try {
    const audioBlob = new Blob([req.file.buffer], {
      type: req.file.mimetype || "audio/webm",
    });
    const result = await elevenlabs.speechToText.convert({
      file: audioBlob,
      modelId: "scribe_v2",
      languageCode: "eng",
      tagAudioEvents: false,
    });
    return res.json({ transcript: result.text ?? "" });
  } catch (error) {
    console.error("STT error", error);
    return res.status(500).json({ error: "Failed to transcribe audio" });
  }
});

app.post("/api/tts", async (req, res) => {
  if (!elevenlabs) {
    return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
  }

  const { text, voiceId } = req.body ?? {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text is required" });
  }

  try {
    const audioStream = await elevenlabs.textToSpeech.stream(voiceId || defaultVoiceId, {
      text,
      modelId: "eleven_flash_v2_5",
      outputFormat: "mp3_44100_128",
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(audioStream).pipe(res);
  } catch (error) {
    console.error("TTS error", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to synthesize speech" });
    } else {
      res.end();
    }
  }
});

// --- Dispatch endpoints ---

app.post("/api/dispatch", (req, res) => {
  const { chain, insurance } = req.body ?? {};
  if (!Array.isArray(chain) || chain.length === 0) {
    return res.status(400).json({ error: "chain must be a non-empty array" });
  }

  const dispatchId = randomUUID();
  const dispatch = {
    dispatchId,
    chain,
    currentIndex: 0,
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
    return { ...entry, requestStatus: r?.status ?? null, requestId: r?.requestId ?? null, autoApproved: r?.autoApproved ?? false };
  });

  return res.json({
    dispatchId: dispatch.dispatchId,
    status: dispatch.status,
    currentIndex: dispatch.currentIndex,
    currentHospital: dispatch.chain[dispatch.currentIndex] ?? null,
    activeRequest,
    chain: chainWithStatus,
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

initializeMongo()
  .then(() => {
    app.listen(port, () => {
      console.log(`Vital-Route backend listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize MongoDB", error);
    process.exit(1);
  });

// --- Routing pipeline ---

async function computeRoute(origin, insurance) {
  const allNodes = await fetchHospitalsByDistance(origin.lat, origin.lng, 50);
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

  const ranked = [...scored].sort((a, b) => scoreHospital(b) - scoreHospital(a));

  let candidates = ranked;
  const insurancePool = normalizedInsurance
    ? ranked.filter((node) => (node.acceptedInsurance ?? []).includes(normalizedInsurance))
    : ranked;
  if (insurancePool.length > 0) candidates = insurancePool;

  const insuranceMatchFound = !normalizedInsurance || insurancePool.length > 0;

  const top3 = candidates.slice(0, 3);
  const closest = [...scored].sort((a, b) => a.distanceMiles - b.distanceMiles)[0];
  const recommended = top3[0] ?? closest;

  return {
    origin,
    insurance: normalizedInsurance,
    insuranceMatchFound,
    model: "score = status / (ETA² + waitMins)",
    closest,
    recommended,
    top3,
    candidates,
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
  // Only auto-accept green-level hospitals (<50% util). Respect explicit "Open" admin overrides.
  const isGreen = override === "Open" || (!override && utilization < 0.5);
  return isGreen
    && (nodeMetrics?.availableBeds ?? 0) >= 5
    && (nodeMetrics?.waitMins ?? 999) <= 60;
}

function getEffectiveStatus(hospitalId, utilization) {
  return hospitalOverrides[hospitalId] ?? deriveStatus(utilization);
}

function deriveStatus(utilization) {
  if (utilization >= 0.97) return "Diversion";
  if (utilization >= 0.80) return "Saturation";
  return "Open";
}

function scoreHospital(node) {
  const STATUS_MULTIPLIER = { Open: 1.0, Saturation: 0.5, Diversion: 0 };
  const eta = node.durationMins || 1;
  const waitMins = node.waitMins || 1;
  const status = STATUS_MULTIPLIER[node.status] ?? 1.0;
  // ETA² dominates: 2× farther → 4× penalty. Status (which encodes bed availability
  // via utilization) breaks ties. waitMins is the final tiebreaker.
  return status / (eta ** 2 + waitMins);
}

function normalizeInsurance(input) {
  if (!input || typeof input !== "string") return null;
  const normalized = input.trim();
  return ["Government", "Kaiser"].includes(normalized) ? normalized : null;
}

async function getTravelMetrics(origin, nodes) {
  if (nodes.length === 0) return [];
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

