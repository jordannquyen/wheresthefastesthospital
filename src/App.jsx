import { useEffect, useMemo, useState } from "react";
import {
  Circle,
  Autocomplete,
  GoogleMap,
  InfoWindowF,
  MarkerF,
  Polyline,
  useJsApiLoader,
} from "@react-google-maps/api";
import {
  mockHospitalStatus,
  mockIncomingPatients,
  mockSpecialties,
} from "./mockHospitalData";

const centerLA = { lat: 34.0522, lng: -118.2437 };
const defaultZoom = 10.5;
const mapContainerStyle = { width: "100%", height: "100%" };
const mapsApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
const mapsLibraries = ["places"];
const rankLabels = ["1", "2", "3"];
const tabs = ["EMT", "Hospital"];
const severityOrder = {
  Critical: 0,
  High: 1,
  Moderate: 2,
  Low: 3,
};
const patientActionLabels = {
  accept: "Accepted",
  preparing: "Preparing",
  reroute: "Rerouted",
  arrived: "Arrived",
};
const overrideReasons = [
  "ER full",
  "CT scanner down",
  "Trauma unavailable",
  "Staffing shortage",
  "Other",
];

function App() {
  const [activeTab, setActiveTab] = useState("EMT");

  return (
    <main className="screen bg-grid text-slate-100">
      <section className="mx-auto grid h-full w-full max-w-[1580px] grid-rows-[auto_1fr] gap-4 p-4 lg:p-6">
        <header className="rounded-[28px] border border-slate-700/80 bg-slate-950/75 p-4 shadow-2xl shadow-black/40 backdrop-blur xl:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-cyan-300">
                ARISTA Connect The Dots | Los Angeles Region
              </p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight lg:text-4xl">
                Vital-Route: Healthcare Load Balancer
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-300 lg:text-base">
                EMT voice is summarized into routing intelligence for ambulances, while hospitals track inbound patients,
                readiness, and manual overrides in a single operations surface.
              </p>
            </div>

            <nav className="flex flex-wrap gap-2 rounded-2xl border border-slate-700/80 bg-slate-900/70 p-2">
              {tabs.map((tab) => {
                const active = activeTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                      active
                        ? "bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    {tab}
                  </button>
                );
              })}
            </nav>
          </div>
        </header>

        {activeTab === "EMT" ? <EMTDashboard /> : <HospitalDashboard />}
      </section>
    </main>
  );
}

function EMTDashboard() {
  const [nodes, setNodes] = useState([]);
  const [telemetry, setTelemetry] = useState({});
  const [origin, setOrigin] = useState(null);
  const [route, setRoute] = useState(null);
  const [pulseTick, setPulseTick] = useState(false);
  const [provider, setProvider] = useState("fallback");
  const [selectedHospitalId, setSelectedHospitalId] = useState(null);
  const [locationAddress, setLocationAddress] = useState("Santa Monica Pier, Los Angeles");
  const [resolvedAddress, setResolvedAddress] = useState("");
  const [locationError, setLocationError] = useState("");
  const [specification, setSpecification] = useState("");
  const [insurance, setInsurance] = useState("");
  const [addressAutocomplete, setAddressAutocomplete] = useState(null);

  const { isLoaded, loadError } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: mapsApiKey || "",
    libraries: mapsLibraries,
  });

  useEffect(() => {
    fetchNodes();
    fetchTelemetry();

    const telemetryInterval = setInterval(fetchTelemetry, 10_000);
    const pulseInterval = setInterval(() => setPulseTick((current) => !current), 900);

    return () => {
      clearInterval(telemetryInterval);
      clearInterval(pulseInterval);
    };
  }, []);

  async function fetchNodes() {
    const response = await fetch("/api/nodes");
    const data = await response.json();
    setNodes(data.nodes ?? []);
  }

  async function fetchTelemetry() {
    const response = await fetch("/api/telemetry");
    const data = await response.json();
    setTelemetry(data.nodes ?? {});
  }

  async function handleMapClick(event) {
    if (!event.latLng) {
      return;
    }

    const clickOrigin = {
      lat: Number(event.latLng.lat().toFixed(6)),
      lng: Number(event.latLng.lng().toFixed(6)),
    };

    setResolvedAddress("Map pin");
    setLocationError("");
    await requestRecommendations(clickOrigin);
  }

  async function requestRecommendations(inputOrigin) {
    setOrigin(inputOrigin);
    const response = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: inputOrigin,
        specification: specification || null,
        insurance: insurance || null,
      }),
    });

    const data = await response.json();
    setRoute(data);
    setProvider(data.provider ?? "fallback");

    if (data.specification && !data.specificationMatchFound) {
      setLocationError(`No ${data.specification.toUpperCase()} center match found, showing nearest-capacity fallback.`);
    }
  }

  const selectedHospital = nodes.find((node) => node.id === selectedHospitalId) ?? null;
  const selectedTelemetry = selectedHospital ? telemetry[selectedHospital.id] ?? null : null;

  async function handleLocationSubmit(event) {
    event.preventDefault();

    if (!locationAddress.trim()) {
      setLocationError("Enter an address to continue.");
      return;
    }

    try {
      setLocationError("");
      const geocodeResponse = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: locationAddress.trim() }),
      });

      const geocodeData = await geocodeResponse.json();
      if (!geocodeResponse.ok) {
        setLocationError(geocodeData.error ?? "Unable to resolve address.");
        return;
      }

      setResolvedAddress(geocodeData.formattedAddress ?? locationAddress.trim());
      await requestRecommendations(geocodeData.location);
    } catch (_error) {
      setLocationError("Unable to geocode this address right now.");
    }
  }

  async function handlePlaceChanged() {
    if (!addressAutocomplete) {
      return;
    }

    const first = addressAutocomplete.getPlace?.();
    const location = first?.geometry?.location;

    if (!location) {
      return;
    }

    const selectedOrigin = {
      lat: Number(location.lat().toFixed(6)),
      lng: Number(location.lng().toFixed(6)),
    };

    setLocationAddress(first.formatted_address ?? first.name ?? locationAddress);
    setResolvedAddress(first.formatted_address ?? first.name ?? "Selected from autocomplete");
    setLocationError("");
    await requestRecommendations(selectedOrigin);
  }

  if (!mapsApiKey) {
    return (
      <div className="mx-auto max-w-3xl rounded-2xl border border-cyan-400/40 bg-slate-900/90 p-8 shadow-2xl shadow-cyan-600/20">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-300">
          Vital-Route LA Demo
        </p>
        <h2 className="mt-2 text-3xl font-semibold">Google API key required</h2>
        <p className="mt-3 text-slate-300">
          Add `GOOGLE_MAPS_API_KEY` to your environment and restart the app to load the live Google Maps dashboard.
        </p>
        <p className="mt-3 text-sm text-slate-400">
          Backend telemetry and cost routing are still active at `/api/telemetry` and `/api/route`.
        </p>
      </div>
    );
  }

  if (loadError) {
    return <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-red-200">Failed to load Google Maps: {loadError.message}</div>;
  }

  return (
    <section className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
      <article className="relative min-h-[460px] overflow-hidden rounded-[28px] border border-slate-700 bg-slate-950/70 shadow-xl shadow-black/35">
        {isLoaded && (
          <GoogleMap
            mapContainerStyle={mapContainerStyle}
            center={centerLA}
            zoom={defaultZoom}
            options={mapOptions}
            onClick={handleMapClick}
          >
            {nodes.map((node) => {
              const nodeTelemetry = telemetry[node.id] ?? {};
              const utilization = Number(nodeTelemetry.utilization ?? 0.2);
              const color = getNodeColor(utilization);
              const isCongested = utilization >= 0.9;

              return (
                <Circle
                  key={`circle-${node.id}`}
                  center={{ lat: node.lat, lng: node.lng }}
                  radius={isCongested ? (pulseTick ? 1550 : 1150) : 960}
                  options={{
                    fillColor: color,
                    fillOpacity: isCongested ? 0.46 : 0.26,
                    strokeColor: color,
                    strokeOpacity: 0.85,
                    strokeWeight: isCongested ? 2.5 : 1.4,
                    clickable: true,
                  }}
                  onClick={() => setSelectedHospitalId(node.id)}
                />
              );
            })}

            {nodes.map((node) => {
              const utilization = Number(telemetry[node.id]?.utilization ?? 0.2);
              return (
                <MarkerF
                  key={`marker-${node.id}`}
                  position={{ lat: node.lat, lng: node.lng }}
                  title={`${node.name} (${Math.round(utilization * 100)}% utilized)`}
                  onClick={() => setSelectedHospitalId(node.id)}
                  icon={{
                    path: window.google.maps.SymbolPath.CIRCLE,
                    scale: utilization >= 0.9 && pulseTick ? 10 : 8,
                    fillColor: getNodeColor(utilization),
                    fillOpacity: 1,
                    strokeColor: "#e2e8f0",
                    strokeWeight: 1.2,
                  }}
                />
              );
            })}

            {origin && <MarkerF position={origin} title="Patient Origin" />}

            {origin && route?.closest && (
              <Polyline
                path={[origin, { lat: route.closest.lat, lng: route.closest.lng }]}
                options={{
                  strokeColor: "#94a3b8",
                  strokeOpacity: 0,
                  strokeWeight: 2,
                  icons: [
                    {
                      icon: {
                        path: "M 0,-1 0,1",
                        strokeOpacity: 1,
                        scale: 4,
                        strokeColor: "#94a3b8",
                      },
                      offset: "0",
                      repeat: "14px",
                    },
                  ],
                }}
              />
            )}

            {origin && route?.recommended && (
              <Polyline
                path={[origin, { lat: route.recommended.lat, lng: route.recommended.lng }]}
                options={{
                  strokeColor: "#38bdf8",
                  strokeOpacity: 0.95,
                  strokeWeight: 4,
                }}
              />
            )}

            {origin && (route?.top3 ?? []).slice(1).map((candidate) => (
              <Polyline
                key={`alt-${candidate.id}`}
                path={[origin, { lat: candidate.lat, lng: candidate.lng }]}
                options={{
                  strokeColor: "#22d3ee",
                  strokeOpacity: 0.6,
                  strokeWeight: 2,
                }}
              />
            ))}

            {selectedHospital && (
              <InfoWindowF
                position={{ lat: selectedHospital.lat, lng: selectedHospital.lng }}
                onCloseClick={() => setSelectedHospitalId(null)}
              >
                <div className="min-w-[220px] p-1 text-slate-900">
                  <p className="text-sm font-semibold">{selectedHospital.name}</p>
                  <p className="text-xs">Specialty: {selectedHospital.specialty}</p>
                  <p className="text-xs">Utilization: {Math.round(Number(selectedTelemetry?.utilization ?? 0) * 100)}%</p>
                  <p className="text-xs">Capacity (beds): {selectedTelemetry?.availableBeds ?? "--"}</p>
                  <p className="text-xs">Wait: {selectedTelemetry?.waitMins ?? "--"} min</p>
                </div>
              </InfoWindowF>
            )}
          </GoogleMap>
        )}

        <div className="pointer-events-none absolute bottom-3 right-3 max-w-[260px] rounded-xl border border-slate-600/90 bg-slate-950/85 p-3 backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-200">Legend</p>
          <ul className="mt-2 space-y-1.5 text-xs text-slate-300">
            <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-emerald-400"></span>Green: &lt;50% utilization</li>
            <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-amber-400"></span>Yellow: 50%-89% utilization</li>
            <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-red-500"></span>Red pulse: 90%+ utilization</li>
            <li><span className="mr-2 inline-block h-[2px] w-6 bg-sky-400 align-middle"></span>Top recommendation</li>
            <li><span className="mr-2 inline-block h-[2px] w-6 border-b border-dashed border-slate-400 align-middle"></span>Closest baseline</li>
          </ul>
        </div>
      </article>

      <aside className="grid min-h-0 grid-rows-[auto_auto_1fr] gap-4">
        <section className="rounded-[28px] border border-slate-700 bg-slate-950/70 p-4">
          <h2 className="text-lg font-semibold">Current Location</h2>
          <p className="mt-1 text-sm text-slate-300">Use address autofill or click the map, then compute top 3 hospitals by distance and capacity.</p>
          <form className="mt-3 grid grid-cols-1 gap-2" onSubmit={handleLocationSubmit}>
            {isLoaded ? (
              <Autocomplete
                onLoad={(autocomplete) => setAddressAutocomplete(autocomplete)}
                onPlacesChanged={handlePlaceChanged}
                options={{
                  fields: ["formatted_address", "geometry", "name"],
                  componentRestrictions: { country: "us" },
                }}
              >
                <input
                  type="text"
                  value={locationAddress}
                  onChange={(event) => setLocationAddress(event.target.value)}
                  className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
                  placeholder="Start typing an address in Los Angeles"
                />
              </Autocomplete>
            ) : (
              <input
                type="text"
                value={locationAddress}
                onChange={(event) => setLocationAddress(event.target.value)}
                className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
                placeholder="Loading autocomplete..."
              />
            )}
            <select
              value={specification}
              onChange={(event) => setSpecification(event.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="">Specification (optional)</option>
              <option value="stemi">STEMI</option>
              <option value="stroke">Stroke</option>
              <option value="trauma">Trauma</option>
            </select>
            <select
              value={insurance}
              onChange={(event) => setInsurance(event.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="">Insurance (optional)</option>
              <option value="Medicare">Medicare</option>
              <option value="Medicaid">Medicaid</option>
              <option value="Blue Cross">Blue Cross</option>
              <option value="Aetna">Aetna</option>
              <option value="United Healthcare">United Healthcare</option>
              <option value="Cigna">Cigna</option>
              <option value="Kaiser">Kaiser</option>
            </select>
            <button
              type="submit"
              className="rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
            >
              Get Top 3 Hospitals
            </button>
          </form>
          {resolvedAddress && (
            <p className="mt-2 text-xs text-cyan-300">Resolved: {resolvedAddress}</p>
          )}
          {locationError && (
            <p className="mt-2 text-xs text-red-300">{locationError}</p>
          )}
        </section>

        {selectedHospital && (
          <section className="rounded-[28px] border border-slate-700 bg-slate-950/70 p-4">
            <h2 className="text-lg font-semibold">Selected Hospital</h2>
            <div className="mt-2 space-y-1.5 text-sm text-slate-200">
              <p className="font-semibold text-slate-100">{selectedHospital.name}</p>
              <p>Specialty: {selectedHospital.specialty}</p>
              <p>Center Types: {formatCenterTypes(selectedHospital.centerTypes)}</p>
              <p>Insurance: {selectedHospital.acceptedInsurance?.join(", ") || "Not available"}</p>
              <p>Utilization: {Math.round(Number(selectedTelemetry?.utilization ?? 0) * 100)}%</p>
              <p>Available Beds: {selectedTelemetry?.availableBeds ?? "--"}</p>
              <p>Current Wait: {selectedTelemetry?.waitMins ?? "--"} min</p>
              <p>Distance from selected location: {route ? `${route?.candidates?.find((candidate) => candidate.id === selectedHospital.id)?.distanceMiles ?? "--"} mi` : "--"}</p>
              <p>Routing status: {route?.recommended?.id === selectedHospital.id ? "Recommended" : route?.closest?.id === selectedHospital.id ? "Closest (baseline)" : "Alternative"}</p>
            </div>
          </section>
        )}

        <section className="min-h-0 overflow-auto rounded-[28px] border border-slate-700 bg-slate-950/70 p-4">
          <h2 className="text-lg font-semibold">Top 3 Hospital Choices</h2>
          {!route && (
            <p className="mt-2 text-sm text-slate-300">Enter a current location to get ranked recommendations.</p>
          )}
          {route && (
            <div className="mt-2 space-y-3 text-sm">
              <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-2 text-slate-200">
                Model: <span className="font-mono text-cyan-300">{route.model}</span>
              </p>
              {route.specification && (
                <p className="rounded-lg border border-slate-700 bg-slate-900/60 p-2 text-slate-200">
                  Specification: <span className="font-mono text-cyan-300">{route.specification.toUpperCase()}</span>
                </p>
              )}
              <p>
                Closest: <span className="font-semibold text-slate-100">{route.closest.name}</span> ({route.closest.distanceMiles} mi, {route.closest.durationMins} min)
              </p>
              <div className="space-y-2 pt-1">
                {(route.top3 || []).map((candidate, index) => (
                  <div key={candidate.id} className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                    <p className="flex items-center gap-2 font-medium text-slate-100">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-cyan-500/20 text-sm font-bold text-cyan-300">{rankLabels[index]}</span>
                      {candidate.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-300">Distance {candidate.distanceMiles} mi | Capacity {candidate.availableBeds} beds | Util {Math.round(candidate.utilization * 100)}% | Wait {candidate.waitMins} min</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </aside>
    </section>
  );
}

function HospitalDashboard() {
  const [patients, setPatients] = useState(mockIncomingPatients);
  const [selectedPatientId, setSelectedPatientId] = useState(mockIncomingPatients[0]?.id ?? null);
  const [hospitalStatus, setHospitalStatus] = useState(mockHospitalStatus);
  const [specialties, setSpecialties] = useState(mockSpecialties);

  const selectedPatient = patients.find((patient) => patient.id === selectedPatientId) ?? sortedPatients(patients)[0] ?? null;
  const orderedPatients = useMemo(() => sortedPatients(patients), [patients]);
  const urgentIncomingCount = patients.filter((patient) => patient.routingStatus !== "Arrived").length;

  useEffect(() => {
    const interval = setInterval(() => {
      setPatients((currentPatients) =>
        currentPatients.map((patient) => {
          if (patient.routingStatus === "Arrived") {
            return patient;
          }

          const nextEta = Math.max(1, patient.etaMinutes - 1);
          const nextConfidence = Math.min(0.99, patient.confidence + 0.002);
          return {
            ...patient,
            etaMinutes: nextEta,
            confidence: Number(nextConfidence.toFixed(2)),
            lastUpdated: "Just now",
          };
        }),
      );
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  function updatePatientStatus(patientId, nextStatus) {
    setPatients((currentPatients) =>
      currentPatients.map((patient) =>
        patient.id === patientId
          ? {
              ...patient,
              routingStatus: nextStatus,
              lastUpdated: "Just now",
            }
          : patient,
      ),
    );
  }

  function handleStatusChange(nextStatus) {
    setHospitalStatus((currentStatus) => ({
      ...currentStatus,
      routingStatus: nextStatus,
      lastUpdated: "Just now",
    }));
  }

  function handleOverrideToggle() {
    setHospitalStatus((currentStatus) => ({
      ...currentStatus,
      manualOverrideActive: !currentStatus.manualOverrideActive,
      overrideReason: !currentStatus.manualOverrideActive ? currentStatus.overrideReason : "",
    }));
  }

  function handleOverrideReasonChange(nextReason) {
    setHospitalStatus((currentStatus) => ({
      ...currentStatus,
      overrideReason: nextReason,
    }));
  }

  function handleSpecialtyToggle(specialtyKey) {
    setSpecialties((currentSpecialties) =>
      currentSpecialties.map((specialty) =>
        specialty.key === specialtyKey
          ? {
              ...specialty,
              available: !specialty.available,
              source: "Manual",
            }
          : specialty,
      ),
    );
  }

  const capacityPercent = Math.round((hospitalStatus.availableBeds / hospitalStatus.totalBeds) * 100);

  return (
    <section className="grid min-h-0 grid-cols-1 gap-4 2xl:grid-cols-[1.45fr_0.95fr]">
      <div className="grid min-h-0 gap-4 xl:grid-cols-[1.4fr_0.9fr]">
        <section className="min-h-0 rounded-[28px] border border-slate-700/90 bg-slate-950/72 p-4 shadow-xl shadow-black/30">
          <div className="flex flex-col gap-3 border-b border-slate-800 pb-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-200">
                  Hospital Operations
                </span>
                <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-300">
                  {urgentIncomingCount} active arrivals
                </span>
              </div>
              <h2 className="mt-3 text-2xl font-semibold text-white">Incoming Patient Feed</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-300">
                Sorted by severity first, then ETA. Each card reflects AI-extracted patient context from EMT voice, transport progress, and required resources.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {["Critical", "High", "Moderate", "Low"].map((severity) => (
                <div key={severity} className="rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-center">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{severity}</p>
                  <p className="mt-1 text-lg font-semibold text-white">
                    {patients.filter((patient) => patient.severity === severity && patient.routingStatus !== "Arrived").length}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-3 overflow-auto pr-1 xl:max-h-[calc(100vh-250px)]">
            {orderedPatients.map((patient) => {
              const isSelected = patient.id === selectedPatient?.id;
              return (
                <button
                  key={patient.id}
                  type="button"
                  onClick={() => setSelectedPatientId(patient.id)}
                  className={`group rounded-[24px] border p-4 text-left transition ${
                    isSelected
                      ? "border-cyan-400/70 bg-cyan-400/8 shadow-lg shadow-cyan-900/20"
                      : "border-slate-800 bg-slate-900/55 hover:border-slate-600 hover:bg-slate-900/80"
                  }`}
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-slate-700 bg-slate-950/80 px-2.5 py-1 text-xs font-semibold text-slate-100">
                          {patient.unitNumber}
                        </span>
                        <SeverityBadge severity={patient.severity} />
                        <StatusBadge status={patient.routingStatus} />
                        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
                          {Math.round(patient.confidence * 100)}% confidence
                        </span>
                      </div>
                      <h3 className="mt-3 text-lg font-semibold text-white">{patient.chiefComplaint}</h3>
                      <p className="mt-2 text-sm text-slate-300">{patient.aiSummary}</p>
                    </div>

                    <div className="grid shrink-0 grid-cols-2 gap-2 sm:min-w-[240px]">
                      <MetricTile label="ETA" value={`${patient.etaMinutes} min`} accent="text-cyan-300" />
                      <MetricTile label="Location" value={patient.locationProgress} accent="text-slate-100" />
                      <MetricTile label="BP" value={patient.vitals.bloodPressure} accent="text-slate-100" />
                      <MetricTile label="SpO2" value={patient.vitals.oxygenSaturation} accent="text-slate-100" />
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-[1.15fr_0.85fr]">
                    <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">EMT Voice Intelligence</p>
                        <p className="text-xs text-slate-500">{patient.lastUpdated}</p>
                      </div>
                      <p className="mt-2 text-sm text-cyan-100">{patient.transcriptMode}</p>
                      <p className="mt-2 text-sm text-slate-300">“{patient.transcriptSnippet}”</p>
                    </div>

                    <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Specialties / Resources</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {patient.specialties.map((specialty) => (
                          <span
                            key={`${patient.id}-${specialty}`}
                            className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-200"
                          >
                            {specialty}
                          </span>
                        ))}
                      </div>
                      <p className="mt-3 text-sm text-slate-400">{patient.locationLabel}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <PatientDetailPanel patient={selectedPatient} onStatusChange={updatePatientStatus} />
      </div>

      <div className="grid min-h-0 gap-4">
        <section className="rounded-[28px] border border-slate-700/90 bg-slate-950/72 p-4 shadow-xl shadow-black/30">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-slate-400">Current Routing State</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Hospital Status Panel</h2>
            </div>
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ${routingBadgeClass(hospitalStatus.routingStatus)}`}>
              {hospitalStatus.routingStatus}
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <StatusCard title="ER Beds" value={`${hospitalStatus.availableBeds}/${hospitalStatus.totalBeds}`} subtext={`${capacityPercent}% available`} tone="cyan" />
            <StatusCard title="Current Wait" value={`${hospitalStatus.waitTimeMinutes} min`} subtext="Median ER wait" tone="amber" />
            <StatusCard title="ICU Availability" value={`${hospitalStatus.icuAvailability}`} subtext="Beds ready now" tone={hospitalStatus.icuAvailability > 0 ? "emerald" : "red"} />
            <StatusCard title="Trauma Bay" value={`${hospitalStatus.traumaBayAvailability}`} subtext="Immediate bays open" tone={hospitalStatus.traumaBayAvailability > 0 ? "emerald" : "red"} />
          </div>

          {hospitalStatus.manualOverrideActive && (
            <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-100">
              <p className="font-semibold uppercase tracking-wide">Manual Override Active</p>
              <p className="mt-1 text-red-200">{hospitalStatus.overrideReason || "Reason not specified yet."}</p>
            </div>
          )}
        </section>

        <section className="rounded-[28px] border border-slate-700/90 bg-slate-950/72 p-4 shadow-xl shadow-black/30">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-slate-400">Capacity Controls</p>
              <h2 className="mt-2 text-xl font-semibold text-white">Manual Override Controls</h2>
            </div>
            <label className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">
              <span>Manual</span>
              <button
                type="button"
                aria-pressed={hospitalStatus.manualOverrideActive}
                onClick={handleOverrideToggle}
                className={`relative h-6 w-11 rounded-full transition ${
                  hospitalStatus.manualOverrideActive ? "bg-red-500" : "bg-slate-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                    hospitalStatus.manualOverrideActive ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </label>
          </div>

          <div className="mt-4 grid gap-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {["Open", "Saturation", "Diversion"].map((status) => {
                const active = hospitalStatus.routingStatus === status;
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => handleStatusChange(status)}
                    className={`rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
                      active
                        ? `${routingBadgeClass(status)} border-transparent`
                        : "border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500"
                    }`}
                  >
                    {status}
                  </button>
                );
              })}
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-200">Override reason</label>
              <select
                value={hospitalStatus.overrideReason}
                onChange={(event) => handleOverrideReasonChange(event.target.value)}
                className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-3 py-3 text-sm text-slate-100"
              >
                <option value="">Select a reason</option>
                {overrideReasons.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-700/90 bg-slate-950/72 p-4 shadow-xl shadow-black/30">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-slate-400">Resource Readiness</p>
            <h2 className="mt-2 text-xl font-semibold text-white">Specialty Availability</h2>
          </div>

          <div className="mt-4 grid gap-3">
            {specialties.map((specialty) => (
              <div key={specialty.key} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-white">{specialty.label}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`rounded-full px-2.5 py-1 font-medium ${
                          specialty.available
                            ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                            : "border border-red-500/30 bg-red-500/10 text-red-200"
                        }`}
                      >
                        {specialty.available ? "Available" : "Unavailable"}
                      </span>
                      <span className="rounded-full border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-300">
                        {specialty.source}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleSpecialtyToggle(specialty.key)}
                    className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                      specialty.available
                        ? "bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25"
                        : "bg-red-500/15 text-red-100 hover:bg-red-500/25"
                    }`}
                  >
                    Toggle Manual Update
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function PatientDetailPanel({ patient, onStatusChange }) {
  if (!patient) {
    return (
      <section className="rounded-[28px] border border-slate-700/90 bg-slate-950/72 p-5">
        <p className="text-sm text-slate-300">Select an incoming patient to inspect details.</p>
      </section>
    );
  }

  return (
    <section className="min-h-0 overflow-auto rounded-[28px] border border-slate-700/90 bg-slate-950/72 p-5 shadow-xl shadow-black/30 xl:max-h-[calc(100vh-170px)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-200">
              {patient.unitNumber}
            </span>
            <SeverityBadge severity={patient.severity} />
            <StatusBadge status={patient.routingStatus} />
          </div>
          <h2 className="mt-3 text-2xl font-semibold text-white">{patient.chiefComplaint}</h2>
          <p className="mt-1 text-sm text-slate-400">Latest update {patient.lastUpdated} • {patient.demographics}</p>
        </div>
        <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-right">
          <p className="text-xs uppercase tracking-[0.18em] text-cyan-200">Arrival ETA</p>
          <p className="mt-1 text-3xl font-semibold text-white">{patient.etaMinutes} min</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <StatusCard title="Blood Pressure" value={patient.vitals.bloodPressure} subtext="mmHg" tone="red" />
        <StatusCard title="Heart Rate" value={`${patient.vitals.heartRate}`} subtext="bpm" tone="amber" />
        <StatusCard title="SpO2" value={patient.vitals.oxygenSaturation} subtext="oxygen saturation" tone="cyan" />
        <StatusCard title="Respiratory Rate" value={`${patient.vitals.respiratoryRate}`} subtext="breaths/min" tone="slate" />
      </div>

      <div className="mt-5 grid gap-4">
        <DetailBlock title="AI Summary" body={patient.aiSummary} />
        <DetailBlock title="Severity Reasoning" body={patient.severityReasoning} />

        <div className="grid gap-4 lg:grid-cols-2">
          <DetailBlock title="Chief Complaint" body={patient.chiefComplaint} />
          <DetailBlock title="Ambulance Location" body={`${patient.locationLabel} • ${patient.locationProgress}`} />
        </div>

        <div className="rounded-[24px] border border-slate-800 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-white">Specialty / Resource Needs</p>
            <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-100">
              {Math.round(patient.confidence * 100)}% AI confidence
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {patient.specialties.map((specialty) => (
              <span
                key={`${patient.id}-${specialty}-detail`}
                className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-200"
              >
                {specialty}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-[24px] border border-slate-800 bg-slate-900/70 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-white">Transcript Context</p>
            <span className="text-xs text-slate-500">{patient.transcriptMode}</span>
          </div>
          <p className="mt-3 rounded-2xl border border-slate-800 bg-slate-950/80 p-3 font-mono text-sm leading-6 text-slate-200">
            “{patient.transcriptSnippet}”
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {Object.entries(patientActionLabels).map(([actionKey, status]) => (
            <button
              key={actionKey}
              type="button"
              onClick={() => onStatusChange(patient.id, status)}
              className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                patient.routingStatus === status
                  ? "bg-cyan-400 text-slate-950"
                  : "border border-slate-700 bg-slate-900 text-slate-100 hover:border-cyan-400/40 hover:bg-slate-800"
              }`}
            >
              {buttonLabelForStatus(status)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function DetailBlock({ title, body }) {
  return (
    <div className="rounded-[24px] border border-slate-800 bg-slate-900/70 p-4">
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-300">{body}</p>
    </div>
  );
}

function MetricTile({ label, value, accent = "text-white" }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

function StatusCard({ title, value, subtext, tone = "slate" }) {
  return (
    <div className={`rounded-[24px] border p-4 ${toneClass(tone)}`}>
      <p className="text-xs uppercase tracking-[0.18em] text-slate-400">{title}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-sm text-slate-300">{subtext}</p>
    </div>
  );
}

function SeverityBadge({ severity }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${severityBadgeClass(severity)}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(status)}`}>
      {status}
    </span>
  );
}

function sortedPatients(patients) {
  return [...patients].sort((a, b) => {
    if (a.routingStatus === "Arrived" && b.routingStatus !== "Arrived") {
      return 1;
    }
    if (b.routingStatus === "Arrived" && a.routingStatus !== "Arrived") {
      return -1;
    }

    const severityDelta = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    return a.etaMinutes - b.etaMinutes;
  });
}

function buttonLabelForStatus(status) {
  switch (status) {
    case "Accepted":
      return "Accept patient";
    case "Preparing":
      return "Mark as preparing";
    case "Rerouted":
      return "Request reroute";
    case "Arrived":
      return "Mark arrived";
    default:
      return status;
  }
}

function getNodeColor(utilization) {
  if (utilization >= 0.9) {
    return "#ef4444";
  }
  if (utilization >= 0.5) {
    return "#f59e0b";
  }
  return "#34d399";
}

function formatCenterTypes(centerTypes = []) {
  if (centerTypes.length === 0) {
    return "General";
  }

  return centerTypes.map((type) => type.toUpperCase()).join(", ");
}

function severityBadgeClass(severity) {
  switch (severity) {
    case "Critical":
      return "border border-red-500/30 bg-red-500/10 text-red-100";
    case "High":
      return "border border-orange-400/30 bg-orange-400/10 text-orange-100";
    case "Moderate":
      return "border border-amber-400/30 bg-amber-400/10 text-amber-100";
    default:
      return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
  }
}

function statusBadgeClass(status) {
  switch (status) {
    case "Accepted":
      return "border border-cyan-400/30 bg-cyan-400/10 text-cyan-100";
    case "Preparing":
      return "border border-violet-400/30 bg-violet-400/10 text-violet-100";
    case "Rerouted":
      return "border border-amber-500/30 bg-amber-500/10 text-amber-100";
    case "Arrived":
      return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
    default:
      return "border border-slate-700 bg-slate-900 text-slate-200";
  }
}

function routingBadgeClass(status) {
  switch (status) {
    case "Open":
      return "border border-emerald-500/30 bg-emerald-500/15 text-emerald-100";
    case "Saturation":
      return "border border-amber-500/30 bg-amber-500/15 text-amber-100";
    default:
      return "border border-red-500/30 bg-red-500/15 text-red-100";
  }
}

function toneClass(tone) {
  switch (tone) {
    case "cyan":
      return "border-cyan-500/20 bg-cyan-500/10";
    case "amber":
      return "border-amber-500/20 bg-amber-500/10";
    case "emerald":
      return "border-emerald-500/20 bg-emerald-500/10";
    case "red":
      return "border-red-500/20 bg-red-500/10";
    default:
      return "border-slate-800 bg-slate-900/70";
  }
}

const mapOptions = {
  disableDefaultUI: true,
  clickableIcons: false,
  styles: [
    { elementType: "geometry", stylers: [{ color: "#0a111f" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#0a111f" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#9fb4d5" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#1a2a43" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#1d3c69" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#051326" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
  ],
};

export default App;
