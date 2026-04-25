import { useEffect, useRef, useState } from "react";
import {
  Circle,
  Autocomplete,
  GoogleMap,
  InfoWindowF,
  MarkerF,
  Polyline,
  useJsApiLoader,
} from "@react-google-maps/api";
import { useVoice } from "./hooks/useVoice.js";
import { extractPatient } from "./lib/extractPatient.js";

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
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [patientSummary, setPatientSummary] = useState(null);
  const voice = useVoice();
  const originRef = useRef(origin);

  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((data) => setVoiceEnabled(Boolean(data?.voice)))
      .catch(() => setVoiceEnabled(false));
  }, []);

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

  async function handleTalkToggle() {
    if (voice.isListening) {
      const transcript = await voice.stop();
      if (!transcript) {
        if (voice.error) {
          await voice.speak("Sorry, I didn't catch that. Try again.");
        }
        return;
      }

      const summary = extractPatient(transcript);
      setPatientSummary(summary);
      if (summary.specification) {
        setSpecification(summary.specification);
      }

      const reply = buildVoiceReply(summary, originRef.current);
      voice.speak(reply);

      if (originRef.current && summary.specification) {
        await requestRecommendations(originRef.current, summary.specification);
      }
    } else {
      setPatientSummary(null);
      await voice.start();
    }
  }

  async function requestRecommendations(inputOrigin, overrideSpecification) {
    setOrigin(inputOrigin);
    const effectiveSpecification = overrideSpecification ?? specification;
    const response = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: inputOrigin,
        specification: effectiveSpecification || null,
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
      <section className="mx-auto grid h-full w-full max-w-[1500px] grid-rows-[auto_1fr] gap-4 p-4 lg:p-6">
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

          <aside className="grid min-h-0 grid-rows-[auto_auto_auto_1fr] gap-4">
            <section className="rounded-2xl border border-slate-700 bg-slate-950/70 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Voice Intake</h2>
                <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${voiceEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                  {voiceEnabled ? "ElevenLabs ready" : "voice offline"}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-300">
                Tap the mic, describe the patient, then tap again to stop. Condition and vitals are extracted automatically.
              </p>
              <button
                type="button"
                onClick={handleTalkToggle}
                disabled={!voiceEnabled || voice.isProcessing}
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold transition ${
                  voice.isListening
                    ? "bg-red-500 text-white hover:bg-red-400"
                    : "bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                } ${(!voiceEnabled || voice.isProcessing) ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${voice.isListening ? "animate-pulse bg-white" : "bg-slate-950/60"}`}></span>
                {voice.isListening
                  ? "Listening — tap to stop"
                  : voice.isProcessing
                    ? "Transcribing…"
                    : voice.isSpeaking
                      ? "Speaking…"
                      : "Tap to talk"}
              </button>
              {voice.error && (
                <p className="mt-2 text-xs text-red-300">{voice.error}</p>
              )}
              {patientSummary && (
                <div className="mt-3 space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-200">
                  <p className="font-mono uppercase tracking-wide text-cyan-300">Patient summary</p>
                  {patientSummary.specification && (
                    <p>Suspected: <span className="font-semibold text-white">{patientSummary.specification.toUpperCase()}</span></p>
                  )}
                  {(patientSummary.age || patientSummary.sex) && (
                    <p>Demographics: {[patientSummary.age && `${patientSummary.age}y`, patientSummary.sex].filter(Boolean).join(", ")}</p>
                  )}
                  {(patientSummary.vitals.bp || patientSummary.vitals.hr || patientSummary.vitals.spo2) && (
                    <p>Vitals: {[
                      patientSummary.vitals.bp && `BP ${patientSummary.vitals.bp}`,
                      patientSummary.vitals.hr && `HR ${patientSummary.vitals.hr}`,
                      patientSummary.vitals.spo2 && `SpO₂ ${patientSummary.vitals.spo2}%`,
                    ].filter(Boolean).join(" · ")}</p>
                  )}
                  {patientSummary.transcript && (
                    <p className="mt-1 text-slate-400">"{patientSummary.transcript}"</p>
                  )}
                </div>
              )}
            </section>

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
      </section>
    </main>
  );
}

function buildVoiceReply(summary, hasOrigin) {
  const specLabels = { stemi: "STEMI", stroke: "stroke", trauma: "trauma" };
  const parts = [];

  if (summary.specification) {
    parts.push(`Heard ${specLabels[summary.specification]} symptoms.`);
  } else {
    parts.push("Got it.");
  }

  if (hasOrigin && summary.specification) {
    parts.push(`Routing to the closest ${specLabels[summary.specification]}-capable hospital now.`);
  } else if (!hasOrigin) {
    parts.push("Set the patient's location to compute the route.");
  } else {
    parts.push("Tell me the suspected condition or set a location to start routing.");
  }

  return parts.join(" ");
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
