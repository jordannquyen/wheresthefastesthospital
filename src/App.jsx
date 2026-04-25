import { useEffect, useState } from "react";
import {
  Circle,
  Autocomplete,
  GoogleMap,
  InfoWindowF,
  MarkerF,
  Polyline,
  useJsApiLoader,
} from "@react-google-maps/api";

const isAdminMode = new URLSearchParams(window.location.search).has("admin");
const centerLA = { lat: 34.0522, lng: -118.2437 };
const defaultZoom = 10.5;
const mapContainerStyle = { width: "100%", height: "100%" };
const mapsApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
const mapsLibraries = ["places"];
const rankLabels = ["1", "2", "3"];

function App() {
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
  const [activeTab, setActiveTab] = useState("emt");
  const [hospitalRequests, setHospitalRequests] = useState([]);
  const [selectedHospitalFilter, setSelectedHospitalFilter] = useState("");
  const [dispatch, setDispatch] = useState(null);
  const [adminHospitals, setAdminHospitals] = useState([]);

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

  useEffect(() => {
    if (activeTab !== "hospital") return;

    fetchHospitalRequests();
    const interval = setInterval(fetchHospitalRequests, 3500);
    return () => clearInterval(interval);
  }, [activeTab, selectedHospitalFilter]);

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

  useEffect(() => {
    if (activeTab !== "admin") return;
    fetchAdminOverrides();
    const interval = setInterval(fetchAdminOverrides, 4000);
    return () => clearInterval(interval);
  }, [activeTab]);

  async function fetchAdminOverrides() {
    const res = await fetch("/api/admin/overrides");
    const data = await res.json();
    setAdminHospitals(data.hospitals ?? []);
  }

  async function handleAdminOverride(hospitalId, status) {
    if (status === null) {
      await fetch(`/api/admin/override/${hospitalId}`, { method: "DELETE" });
    } else {
      await fetch("/api/admin/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hospitalId, status }),
      });
    }
    fetchAdminOverrides();
  }

  useEffect(() => {
    if (!dispatch?.dispatchId || dispatch.status !== "active") return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/dispatch/${dispatch.dispatchId}`);
      const data = await res.json();
      setDispatch(data);
    }, 3000);
    return () => clearInterval(interval);
  }, [dispatch?.dispatchId, dispatch?.status]);

  async function fetchHospitalRequests() {
    const params = selectedHospitalFilter ? `?hospitalId=${selectedHospitalFilter}` : "";
    const response = await fetch(`/api/requests${params}`);
    const data = await response.json();
    setHospitalRequests(data.requests ?? []);
  }

  async function handleDispatch() {
    if (!route?.top3?.length) return;
    const chain = route.top3.map((h) => ({
      hospitalId: h.id,
      hospitalName: h.name,
      etaMins: h.durationMins,
    }));
    const response = await fetch("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain,
        patientSpec: specification || null,
        insurance: insurance || null,
      }),
    });
    const data = await response.json();
    if (response.ok) {
      const res = await fetch(`/api/dispatch/${data.dispatchId}`);
      setDispatch(await res.json());
    }
  }

  async function handleRequestAction(requestId, status) {
    await fetch(`/api/requests/${requestId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    fetchHospitalRequests();
  }

  async function handleMapClick(event) {
    if (!event.latLng) return;
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
    setDispatch(null);
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
    if (!addressAutocomplete) return;

    const first = addressAutocomplete.getPlace?.();
    const location = first?.geometry?.location;

    if (!location) return;

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
      <main className="screen bg-grid text-slate-100">
        <div className="mx-auto max-w-3xl rounded-2xl border border-cyan-400/40 bg-slate-900/90 p-8 shadow-2xl shadow-cyan-600/20">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-300">
            Vital-Route LA Demo
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Google API key required</h1>
          <p className="mt-3 text-slate-300">
            Add GOOGLE_MAPS_API_KEY to your environment and restart the app to load the live Google Maps dashboard.
          </p>
          <p className="mt-3 text-sm text-slate-400">
            Backend telemetry and cost routing are still active at /api/telemetry and /api/route.
          </p>
        </div>
      </main>
    );
  }

  if (loadError) {
    return <main className="screen bg-grid p-8 text-red-300">Failed to load Google Maps: {loadError.message}</main>;
  }

  return (
    <main className="screen bg-grid text-slate-100">
      <section className="mx-auto grid h-full w-full max-w-[1500px] grid-rows-[auto_auto_1fr] gap-4 p-4 lg:p-6">
        <header className="rounded-2xl border border-slate-700 bg-slate-950/70 p-4 shadow-xl shadow-black/40 backdrop-blur">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-cyan-300">ARISTA Connect The Dots | Los Angeles Region</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight lg:text-4xl">Vital-Route: Healthcare Load Balancer</h1>
              <p className="mt-2 text-sm text-slate-300 lg:text-base">Click any point in Los Angeles to route a patient packet by minimum cost, not nearest hospital.</p>
            </div>
            <div className="rounded-xl border border-cyan-400/50 bg-slate-950/80 px-4 py-3">
              <p className="font-mono text-xs uppercase tracking-wide text-slate-300">Routing Provider</p>
              <p className="text-2xl text-cyan-300">{provider.toUpperCase()}</p>
            </div>
          </div>
        </header>

        <nav className="flex gap-2 rounded-2xl border border-slate-700 bg-slate-950/70 p-2">
          {["emt", "hospital", ...(isAdminMode ? ["admin"] : [])].map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`rounded-xl px-5 py-2 text-sm font-semibold transition ${
                activeTab === tab
                  ? tab === "admin" ? "bg-amber-500 text-slate-950" : "bg-cyan-500 text-slate-950"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {tab === "emt" ? "EMT Dashboard" : tab === "hospital" ? "Hospital View" : "Admin"}
            </button>
          ))}
        </nav>

        {activeTab === "emt" && (
          <section className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
            <article className="relative min-h-[420px] overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/70 shadow-xl shadow-black/35">
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
              <section className="rounded-2xl border border-slate-700 bg-slate-950/70 p-4">
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
                <section className="rounded-2xl border border-slate-700 bg-slate-950/70 p-4">
                  <h2 className="text-lg font-semibold">Selected Hospital</h2>
                  <div className="mt-2 space-y-1.5 text-sm text-slate-200">
                    <p className="font-semibold text-slate-100">{selectedHospital.name}</p>
                    <p>Specialty: {selectedHospital.specialty}</p>
                    <p>Center Types: {formatCenterTypes(selectedHospital.centerTypes)}</p>
                    <p>Insurance: {selectedHospital.acceptedInsurance?.join(", ") || "Not available"}</p>
                    <p>Utilization: {Math.round(Number(selectedTelemetry?.utilization ?? 0) * 100)}%</p>
                    <p>Available Beds: {selectedTelemetry?.availableBeds ?? "--"}</p>
                    <p>Current Wait: {selectedTelemetry?.waitMins ?? "--"} min</p>
                    <p>Distance from selected location: {route ? `${route.candidates.find((candidate) => candidate.id === selectedHospital.id)?.distanceMiles ?? "--"} mi` : "--"}</p>
                    <p>Routing status: {route?.recommended?.id === selectedHospital.id ? "Recommended" : route?.closest?.id === selectedHospital.id ? "Closest (baseline)" : "Alternative"}</p>
                  </div>
                </section>
              )}

              <section className="min-h-0 overflow-auto rounded-2xl border border-slate-700 bg-slate-950/70 p-4">
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
                      {(route.top3 || []).map((candidate, index) => {
                        const chainEntry = dispatch?.chain?.[index];
                        const isActive = dispatch?.currentIndex === index;
                        const wasDispatched = !!chainEntry?.requestStatus;
                        return (
                          <div
                            key={candidate.id}
                            className={`rounded-lg border p-2 ${isActive ? "border-cyan-500/60 bg-cyan-500/10" : "border-slate-700 bg-slate-900/60"}`}
                          >
                            <p className="flex items-center gap-2 font-medium text-slate-100">
                              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-cyan-500/20 text-sm font-bold text-cyan-300">{rankLabels[index]}</span>
                              {candidate.name}
                              {wasDispatched && (
                                <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${dispatchStatusClass(chainEntry.requestStatus)}`}>
                                  {chainEntry.requestStatus}
                                </span>
                              )}
                            </p>
                            <p className="mt-1 text-xs text-slate-300">
                              Distance {candidate.distanceMiles} mi | Capacity {candidate.availableBeds} beds | Util {Math.round(candidate.utilization * 100)}% | Wait {candidate.waitMins} min
                            </p>
                          </div>
                        );
                      })}
                    </div>

                  {!dispatch ? (
                    <button
                      type="button"
                      onClick={handleDispatch}
                      className="mt-2 w-full rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
                    >
                      Dispatch Patient to #{1} Recommended
                    </button>
                  ) : (
                    <div className={`mt-2 rounded-lg border p-3 text-sm ${dispatchPanelClass(dispatch.status)}`}>
                      {dispatch.status === "active" && (
                        <>
                          <p className="font-semibold">Dispatched → {dispatch.currentHospital?.hospitalName}</p>
                          <p className="mt-1 text-xs opacity-80">
                            {dispatch.activeRequest?.autoApproved
                              ? "Auto-approved — en route"
                              : dispatch.activeRequest?.status === "pending"
                              ? "Awaiting hospital confirmation..."
                              : dispatch.activeRequest?.status}
                          </p>
                        </>
                      )}
                      {dispatch.status === "accepted" && (
                        <p className="font-semibold">Confirmed — heading to {dispatch.currentHospital?.hospitalName}</p>
                      )}
                      {dispatch.status === "exhausted" && (
                        <p className="font-semibold">All hospitals diverted — contact dispatch</p>
                      )}
                    </div>
                  )}
                  </div>
                )}
              </section>
            </aside>
          </section>
        )}

        {activeTab === "admin" && isAdminMode && (
          <AdminView hospitals={adminHospitals} onOverride={handleAdminOverride} />
        )}

        {activeTab === "hospital" && (
          <HospitalView
            nodes={nodes}
            requests={hospitalRequests}
            onAccept={(id) => handleRequestAction(id, "accepted")}
            onDivert={(id) => handleRequestAction(id, "diverted")}
            selectedHospitalFilter={selectedHospitalFilter}
            onFilterChange={setSelectedHospitalFilter}
          />
        )}
      </section>
    </main>
  );
}

function AdminView({ hospitals, onOverride }) {
  const statusOptions = ["Open", "Saturation", "Diversion"];
  return (
    <section className="min-h-0 overflow-auto">
      <div className="mb-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
        <p className="text-sm font-semibold text-amber-200">Demo Admin — Hospital Status Overrides</p>
        <p className="mt-1 text-xs text-amber-300/70">Force hospital status to test the diversion chain. Overrides block auto-approve so requests come in as pending and can be manually diverted.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {hospitals.map((h) => (
          <div key={h.hospitalId} className="rounded-[28px] border border-slate-700 bg-slate-900/60 p-4">
            <p className="font-semibold text-slate-100">{h.hospitalName}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
              <span>Util {Math.round((h.utilization ?? 0) * 100)}%</span>
              <span>{h.availableBeds ?? "--"} beds</span>
              <span>{h.waitMins ?? "--"} min wait</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs">
              <span className="text-slate-400">Auto:</span>
              <span className={`rounded-full px-2 py-0.5 font-semibold ${statusBadgeColor(h.autoStatus)}`}>{h.autoStatus}</span>
              {h.override && (
                <>
                  <span className="text-slate-500">→ Override:</span>
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${statusBadgeColor(h.override)}`}>{h.override}</span>
                </>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {statusOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onOverride(h.hospitalId, h.override === s ? null : s)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    h.override === s
                      ? `${statusBadgeColor(s)} opacity-100`
                      : "border border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"
                  }`}
                >
                  {h.override === s ? `${s} ✓` : s}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function statusBadgeColor(status) {
  switch (status) {
    case "Open": return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "Saturation": return "border border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "Diversion": return "border border-red-500/30 bg-red-500/10 text-red-200";
    default: return "border border-slate-700 bg-slate-800 text-slate-300";
  }
}

function HospitalView({ nodes, requests, onAccept, onDivert, selectedHospitalFilter, onFilterChange }) {
  return (
    <section className="grid min-h-0 grid-rows-[auto_1fr] gap-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-950/70 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Incoming Patient Requests</h2>
          <p className="mt-1 text-sm text-slate-300">EMT notifications routed to this hospital. Auto-approved when capacity is healthy.</p>
        </div>
        <select
          value={selectedHospitalFilter}
          onChange={(e) => onFilterChange(e.target.value)}
          className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100"
        >
          <option value="">All hospitals</option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>{node.name}</option>
          ))}
        </select>
      </div>

      <div className="min-h-0 overflow-auto">
        {requests.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-2xl border border-slate-700 bg-slate-950/70">
            <p className="text-sm text-slate-400">No incoming requests{selectedHospitalFilter ? " for this hospital" : ""}.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {requests.map((req) => (
              <div
                key={req.requestId}
                className="rounded-[28px] border border-slate-700 bg-slate-900/60 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {req.patientSpec && (
                    <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold uppercase text-cyan-200">
                      {req.patientSpec}
                    </span>
                  )}
                  {req.escalatedFrom && (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
                      Rerouted from {req.escalatedFrom}
                    </span>
                  )}
                  {req.autoApproved && (
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">
                      Auto-Approved
                    </span>
                  )}
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${requestStatusClass(req.status)}`}>
                    {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
                  </span>
                </div>

                <p className="mt-3 font-semibold text-slate-100">{req.hospitalName}</p>
                <div className="mt-2 space-y-1 text-sm text-slate-300">
                  <p>ETA: <span className="text-slate-100">{req.etaMins != null ? `${req.etaMins} min` : "--"}</span></p>
                  {req.insurance && <p>Insurance: <span className="text-slate-100">{req.insurance}</span></p>}
                  <p className="font-mono text-xs text-slate-500">{new Date(req.requestedAt).toLocaleTimeString()}</p>
                </div>

                {req.status === "pending" && (
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onAccept(req.requestId)}
                      className="flex-1 rounded-xl bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/30"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => onDivert(req.requestId)}
                      className="flex-1 rounded-xl bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/30"
                    >
                      Divert
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function dispatchStatusClass(status) {
  switch (status) {
    case "accepted": return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "diverted": return "border border-red-500/30 bg-red-500/10 text-red-200";
    case "pending": return "border border-amber-500/30 bg-amber-500/10 text-amber-200";
    default: return "border border-slate-700 bg-slate-900 text-slate-300";
  }
}

function dispatchPanelClass(status) {
  switch (status) {
    case "accepted": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-100";
    case "exhausted": return "border-red-500/40 bg-red-500/10 text-red-100";
    default: return "border-cyan-500/40 bg-cyan-500/10 text-cyan-100";
  }
}

function requestStatusClass(status) {
  switch (status) {
    case "accepted": return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "diverted": return "border border-red-500/30 bg-red-500/10 text-red-200";
    default: return "border border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
}

function getNodeColor(utilization) {
  if (utilization >= 0.9) return "#ef4444";
  if (utilization >= 0.5) return "#f59e0b";
  return "#34d399";
}

function formatCenterTypes(centerTypes = []) {
  if (centerTypes.length === 0) return "General";
  return centerTypes.map((type) => type.toUpperCase()).join(", ");
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
