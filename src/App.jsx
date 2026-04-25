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

const isAdminMode = new URLSearchParams(window.location.search).has("admin");
const centerGL = { lat: 20, lng: 0 };
const defaultZoom = 2;
const mapContainerStyle = { width: "100%", height: "100%" };
const mapsApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
const mapsLibraries = ["places"];
const rankLabels = ["1", "2", "3"];

function App() {
  const [nodes, setNodes] = useState([]);
  const [origin, setOrigin] = useState(null);
  const [route, setRoute] = useState(null);
  const [pulseTick, setPulseTick] = useState(false);
  const [provider, setProvider] = useState("fallback");
  const [selectedHospitalId, setSelectedHospitalId] = useState(null);
  const [locationAddress, setLocationAddress] = useState("");
  const [resolvedAddress, setResolvedAddress] = useState("");
  const [locationError, setLocationError] = useState("");
  const [specification, setSpecification] = useState("");
  const [insurance, setInsurance] = useState("");
  const [addressAutocomplete, setAddressAutocomplete] = useState(null);
  const [activeTab, setActiveTab] = useState("emt");
  const [hospitalRequests, setHospitalRequests] = useState([]);
  const [sentRequests, setSentRequests] = useState({}); // { [hospitalId]: requestId }
  const [selectedHospitalFilter, setSelectedHospitalFilter] = useState("");
  const [mapCenter, setMapCenter] = useState(centerGL);
  const [mapZoom, setMapZoom] = useState(defaultZoom);
  const [dispatch, setDispatch] = useState(null);
  const [adminHospitals, setAdminHospitals] = useState([]);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [patientSummary, setPatientSummary] = useState(null);
  const addressInputRef = useRef(null);
  const mapRef = useRef(null);
  const originRef = useRef(origin);
  const voice = useVoice();

  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((data) => setVoiceEnabled(Boolean(data?.voice)))
      .catch(() => setVoiceEnabled(false));
  }, []);

  // Keep the (uncontrolled) autocomplete input in sync with locationAddress
  // so voice-resolved or programmatically set addresses appear in the field.
  useEffect(() => {
    if (addressInputRef.current && addressInputRef.current.value !== locationAddress) {
      addressInputRef.current.value = locationAddress ?? "";
    }
  }, [locationAddress]);

  const { isLoaded, loadError } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: mapsApiKey || "",
    libraries: mapsLibraries,
  });

  useEffect(() => {
    const pulseInterval = setInterval(() => setPulseTick((c) => !c), 900);
    return () => clearInterval(pulseInterval);
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setResolvedAddress("Current location");
      reverseGeocodeToField(loc);
      await fetchHospitalsByCoords(loc.lat, loc.lng);
      await requestRecommendations(loc);
    });
  }, [isLoaded]);

  function reverseGeocodeToField(loc) {
    if (!isLoaded || !window.google?.maps?.Geocoder) return;
    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ location: loc }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const formatted = results[0].formatted_address;
        setLocationAddress(formatted);
        setResolvedAddress(formatted);
      }
    });
  }

  // Poll hospital requests while on hospital tab
  useEffect(() => {
    if (activeTab !== "hospital") return;
    fetchHospitalRequests();
    const iv = setInterval(fetchHospitalRequests, 3500);
    return () => clearInterval(iv);
  }, [activeTab, selectedHospitalFilter]);

  // Poll dispatch status while active
  useEffect(() => {
    if (!dispatch?.dispatchId || dispatch.status !== "active") return;
    const iv = setInterval(async () => {
      const res = await fetch(`/api/dispatch/${dispatch.dispatchId}`);
      const data = await res.json();
      if (res.ok) setDispatch(data);
    }, 3000);
    return () => clearInterval(iv);
  }, [dispatch?.dispatchId, dispatch?.status]);

  // Populate admin hospitals from nodes
  useEffect(() => {
    if (nodes.length === 0) return;
    fetch("/api/admin/overrides")
      .then((r) => r.json())
      .then((data) => {
        setAdminHospitals(
          nodes.map((n) => ({ hospitalId: n.id, hospitalName: n.name, override: data.overrides?.[n.id] ?? null }))
        );
      })
      .catch(() => {
        setAdminHospitals(nodes.map((n) => ({ hospitalId: n.id, hospitalName: n.name, override: null })));
      });
  }, [nodes]);

  async function fetchHospitalsByCoords(lat, lng) {
    try {
      const res = await fetch("/api/hospitals-by-coords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      const data = await res.json();
      if (res.ok) {
        setNodes(data.nodes ?? []);
        setMapCenter({ lat, lng });
        setMapZoom(10.5);
        if (mapRef.current) {
          mapRef.current.panTo({ lat, lng });
          mapRef.current.setZoom(10.5);
        }
      }
    } catch (err) {
      console.error(err);
      setLocationError("Unable to fetch hospitals for this location");
    }
  }

  async function fetchHospitalRequests() {
    const params = selectedHospitalFilter ? `?hospitalId=${selectedHospitalFilter}` : "";
    const res = await fetch(`/api/requests${params}`);
    const data = await res.json();
    setHospitalRequests(data.requests ?? []);
  }

  async function handleRequest(candidate) {
    const res = await fetch("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: [{
          hospitalId: candidate.id,
          hospitalName: candidate.name,
          etaMins: candidate.durationMins,
          utilization: candidate.utilization,
          availableBeds: candidate.availableBeds,
          waitMins: candidate.waitMins,
        }],
        patientSpec: specification || null,
        insurance: insurance || null,
      }),
    });
    const data = await res.json();
    if (res.ok) setSentRequests((prev) => ({ ...prev, [candidate.id]: data.requestId }));
  }

  async function handleDispatch() {
    if (!route?.top3?.length) return;
    const chain = route.top3.map((c) => ({
      hospitalId: c.id,
      hospitalName: c.name,
      etaMins: c.durationMins,
      utilization: c.utilization,
      availableBeds: c.availableBeds,
      waitMins: c.waitMins,
    }));
    const res = await fetch("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain, patientSpec: specification || null, insurance: insurance || null }),
    });
    const data = await res.json();
    if (res.ok) {
      const pollRes = await fetch(`/api/dispatch/${data.dispatchId}`);
      const pollData = await pollRes.json();
      if (pollRes.ok) setDispatch(pollData);
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

  async function handleAdminOverride(hospitalId, status) {
    if (!status) {
      await fetch(`/api/admin/override/${hospitalId}`, { method: "DELETE" });
    } else {
      await fetch("/api/admin/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hospitalId, status }),
      });
    }
    const res = await fetch("/api/admin/overrides");
    const data = await res.json();
    setAdminHospitals(
      nodes.map((n) => ({ hospitalId: n.id, hospitalName: n.name, override: data.overrides?.[n.id] ?? null }))
    );
  }

  async function handleMapClick(event) {
    if (!event.latLng) return;
    const clickOrigin = {
      lat: Number(event.latLng.lat().toFixed(6)),
      lng: Number(event.latLng.lng().toFixed(6)),
    };
    setResolvedAddress("Map pin");
    setLocationError("");
    await fetchHospitalsByCoords(clickOrigin.lat, clickOrigin.lng);
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
      if (summary.specification) setSpecification(summary.specification);
      if (summary.insurance) setInsurance(summary.insurance);

      let geocoded = null;
      let resolvedOrigin = originRef.current;
      if (summary.location?.phrase) {
        geocoded = await geocodeVoiceLocation(summary.location.phrase);
        if (geocoded) {
          resolvedOrigin = geocoded.location;
          setLocationAddress(geocoded.formattedAddress);
          setResolvedAddress(geocoded.formattedAddress);
          setLocationError("");
          await fetchHospitalsByCoords(resolvedOrigin.lat, resolvedOrigin.lng);
        }
      }

      const reply = buildVoiceReply(summary, resolvedOrigin, geocoded);
      voice.speak(reply);

      if (resolvedOrigin && (summary.specification || geocoded)) {
        await requestRecommendations(resolvedOrigin, {
          specification: summary.specification,
          insurance: summary.insurance,
        });
      }
    } else {
      setPatientSummary(null);
      await voice.start();
    }
  }

  async function geocodeVoiceLocation(phrase) {
    try {
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: phrase }),
      });
      const data = await res.json();
      if (!res.ok || !data.location) return null;
      return {
        formattedAddress: data.formattedAddress ?? phrase,
        location: data.location,
      };
    } catch (_err) {
      return null;
    }
  }

  async function requestRecommendations(inputOrigin, overrides = {}) {
    setOrigin(inputOrigin);
    setSentRequests({});
    setDispatch(null);
    const effectiveSpecification = overrides.specification ?? specification;
    const effectiveInsurance = overrides.insurance ?? insurance;
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: inputOrigin,
        specification: effectiveSpecification || null,
        insurance: effectiveInsurance || null,
      }),
    });
    const data = await res.json();
    setRoute(data);
    setProvider(data.provider ?? "fallback");
    if (data.specification && !data.specificationMatchFound) {
      setLocationError(
        `No ${data.specification.toUpperCase()} center match found, showing nearest-capacity fallback.`,
      );
    }
  }

  const selectedHospital =
    route?.candidates?.find((c) => c.id === selectedHospitalId) ??
    nodes.find((n) => n.id === selectedHospitalId) ??
    null;
  const selectedStats = getHospitalStats(selectedHospital);

  async function handleLocationSubmit(event) {
    event.preventDefault();
    const addressValue = addressInputRef.current?.value?.trim() || locationAddress.trim();
    if (!addressValue) { setLocationError("Enter an address to continue."); return; }

    // Use Places Autocomplete geometry if available — avoids backend geocoder
    if (addressAutocomplete) {
      const place = addressAutocomplete.getPlace?.();
      if (place?.geometry) {
        const loc = place.geometry.location;
        const selectedOrigin = {
          lat: Number(loc.lat().toFixed(6)),
          lng: Number(loc.lng().toFixed(6)),
        };
        const displayAddress = place.formatted_address || place.name || addressValue;
        setLocationAddress(displayAddress);
        setResolvedAddress(displayAddress);
        setLocationError("");
        await fetchHospitalsByCoords(selectedOrigin.lat, selectedOrigin.lng);
        await requestRecommendations(selectedOrigin);
        return;
      }
    }

    // Fallback: backend geocoder
    try {
      setLocationError("");
      const geoRes = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addressValue }),
      });
      const geoData = await geoRes.json();
      if (!geoRes.ok) { setLocationError(geoData.error ?? "Unable to resolve address."); return; }
      setLocationAddress(geoData.formattedAddress ?? addressValue);
      setResolvedAddress(geoData.formattedAddress ?? addressValue);
      await fetchHospitalsByCoords(geoData.location.lat, geoData.location.lng);
      await requestRecommendations(geoData.location);
    } catch (_) {
      setLocationError("Unable to geocode this address right now.");
    }
  }

  async function handlePlaceChanged() {
    if (!addressAutocomplete) return;
    const place = addressAutocomplete.getPlace?.();
    if (!place?.geometry) return;
    const loc = place.geometry.location;
    const selectedOrigin = {
      lat: Number(loc.lat().toFixed(6)),
      lng: Number(loc.lng().toFixed(6)),
    };
    setLocationAddress(place.formatted_address || place.name || "");
    setResolvedAddress(place.formatted_address || place.name || "");
    setLocationError("");
    await fetchHospitalsByCoords(selectedOrigin.lat, selectedOrigin.lng);
    await requestRecommendations(selectedOrigin);
  }

  if (!mapsApiKey) {
    return (
      <main className="screen bg-grid text-slate-100">
        <div className="mx-auto max-w-3xl rounded-md border border-cyan-400/40 bg-slate-900/90 p-8 shadow-2xl shadow-cyan-600/20">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-300">wtf-hospital</p>
          <h1 className="mt-2 text-3xl font-semibold">Google API key required</h1>
          <p className="mt-3 text-slate-300">Add GOOGLE_MAPS_API_KEY to your .env and restart.</p>
        </div>
      </main>
    );
  }

  if (loadError) {
    return <main className="screen bg-grid p-8 text-red-300">Failed to load Google Maps: {loadError.message}</main>;
  }

  const tabs = ["emt", "hospital", ...(isAdminMode ? ["admin"] : [])];

  return (
    <main className="screen bg-grid text-slate-100">
      <section className="mx-auto grid h-full w-full max-w-[1500px] grid-rows-[auto_auto_1fr] gap-4 p-4 lg:p-6">
        <header className="rounded-xl border border-slate-700 bg-slate-950/70 p-4 shadow-xl shadow-black/40 backdrop-blur">
          <h1 className="text-3xl font-semibold tracking-tight lg:text-4xl">wtf-hospital</h1>
          <p className="mt-1 text-sm text-slate-300">a tool for emts to optimize saving lives</p>
        </header>

        <nav className="flex gap-1 rounded-xl border border-slate-700 bg-slate-950/70 p-1">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                activeTab === tab ? "bg-cyan-500 text-slate-950" : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              {tab === "emt" ? "EMT View" : tab === "hospital" ? "Hospital View" : "Admin"}
            </button>
          ))}
        </nav>

        {activeTab === "emt" && (
          <section className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
            <article className="relative min-h-[420px] overflow-hidden rounded-xl border border-slate-700 bg-slate-950/70 shadow-xl shadow-black/35">
              {isLoaded && (
                <GoogleMap
                  mapContainerStyle={mapContainerStyle}
                  center={mapCenter}
                  zoom={mapZoom}
                  options={mapOptions}
                  onLoad={(map) => { mapRef.current = map; }}
                  onClick={handleMapClick}
                >
                  {nodes.map((node) => {
                    const util = nodeUtilization(node);
                    const color = getNodeColor(util);
                    const congested = util >= 0.9;
                    return (
                      <Circle
                        key={`circle-${node.id}`}
                        center={{ lat: node.lat, lng: node.lng }}
                        radius={congested ? 1350 : 960}
                        options={{
                          fillColor: color,
                          fillOpacity: congested ? 0.46 : 0.26,
                          strokeColor: color,
                          strokeOpacity: 0.85,
                          strokeWeight: congested ? 2.5 : 1.4,
                          clickable: true,
                        }}
                        onClick={() => setSelectedHospitalId(node.id)}
                      />
                    );
                  })}

                  {nodes.map((node) => {
                    const util = nodeUtilization(node);
                    return (
                      <MarkerF
                        key={`marker-${node.id}`}
                        position={{ lat: node.lat, lng: node.lng }}
                        title={`${node.name} (${Math.round(util * 100)}% utilized)`}
                        onClick={() => setSelectedHospitalId(node.id)}
                        icon={{
                          path: window.google.maps.SymbolPath.CIRCLE,
                          scale: 8,
                          fillColor: getNodeColor(util),
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
                        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 4, strokeColor: "#94a3b8" }, offset: "0", repeat: "14px" }],
                      }}
                    />
                  )}

                  {origin && route?.recommended && (
                    <Polyline
                      path={[origin, { lat: route.recommended.lat, lng: route.recommended.lng }]}
                      options={{ strokeColor: "#38bdf8", strokeOpacity: 0.95, strokeWeight: 4 }}
                    />
                  )}

                  {origin && (route?.top3 ?? []).slice(1).map((c) => (
                    <Polyline
                      key={`alt-${c.id}`}
                      path={[origin, { lat: c.lat, lng: c.lng }]}
                      options={{ strokeColor: "#22d3ee", strokeOpacity: 0.6, strokeWeight: 2 }}
                    />
                  ))}

                  {selectedHospital && (
                    <InfoWindowF
                      position={{ lat: selectedHospital.lat, lng: selectedHospital.lng }}
                      onCloseClick={() => setSelectedHospitalId(null)}
                    >
                      <div className="min-w-[200px] p-1 text-slate-900">
                        <p className="text-sm font-semibold">{selectedHospital.name}</p>
                        <p className="text-xs">{selectedHospital.address}, {selectedHospital.city}</p>
                        {selectedHospital.status && <p className="text-xs font-semibold">Status: {selectedHospital.status}</p>}
                        <p className="mt-1 text-xs">Inpatient util: {Math.round(selectedStats.utilization * 100)}%</p>
                        <p className="text-xs">Available beds: {selectedStats.availableBeds}</p>
                        <p className="text-xs">ICU util: {selectedStats.icuUtilization}%</p>
                        <p className="text-xs">Est. wait: {selectedStats.waitMins} min</p>
                        {selectedHospital.distanceMiles != null && (
                          <p className="text-xs">Drive: {selectedHospital.distanceMiles} mi / {selectedHospital.durationMins} min</p>
                        )}
                      </div>
                    </InfoWindowF>
                  )}
                </GoogleMap>
              )}

              <div className="pointer-events-none absolute bottom-3 right-3 max-w-[240px] rounded-lg border border-slate-600/90 bg-slate-950/85 p-3 backdrop-blur">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-200">Legend</p>
                <ul className="mt-2 space-y-1.5 text-xs text-slate-300">
                  <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" />Green: &lt;50% util</li>
                  <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />Yellow: 50-89% util</li>
                  <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-red-500" />Red pulse: 90%+ util</li>
                  <li><span className="mr-2 inline-block h-[2px] w-6 bg-sky-400 align-middle" />Top recommendation</li>
                  <li><span className="mr-2 inline-block h-[2px] w-6 border-b border-dashed border-slate-400 align-middle" />Closest baseline</li>
                </ul>
              </div>
            </article>

            <aside className="grid min-h-0 grid-rows-[auto_auto_auto_1fr] gap-4">
              <section className="rounded-xl border border-slate-700 bg-slate-950/70 p-4">
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
                    {patientSummary.insurance && (
                      <p>Insurance: <span className="font-semibold text-white">{patientSummary.insurance}</span></p>
                    )}
                    {patientSummary.location?.phrase && (
                      <p>Location heard: <span className="font-semibold text-white">{patientSummary.location.phrase}</span></p>
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

              <section className="rounded-xl border border-slate-700 bg-slate-950/70 p-4">
                <h2 className="text-lg font-semibold">Current Location</h2>
                <p className="mt-1 text-sm text-slate-300">Use address autofill or click the map, then compute top 3 hospitals.</p>
                <form className="mt-3 grid grid-cols-1 gap-2" onSubmit={handleLocationSubmit}>
                  {isLoaded ? (
                    <Autocomplete
                      onLoad={(ac) => setAddressAutocomplete(ac)}
                      onPlacesChanged={handlePlaceChanged}
                      options={{ fields: ["formatted_address", "geometry", "name"], componentRestrictions: { country: "us" } }}
                    >
                      <input
                        ref={addressInputRef}
                        type="text"
                        onChange={(e) => setLocationAddress(e.target.value)}
                        className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
                        placeholder="Start typing an address"
                      />
                    </Autocomplete>
                  ) : (
                    <input
                      type="text"
                      value={locationAddress}
                      onChange={(e) => setLocationAddress(e.target.value)}
                      className="rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
                      placeholder="Loading autocomplete..."
                    />
                  )}
                  <select value={specification} onChange={(e) => setSpecification(e.target.value)} className="rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm">
                    <option value="">Specification (optional)</option>
                    <option value="stemi">STEMI</option>
                    <option value="stroke">Stroke</option>
                    <option value="trauma">Trauma</option>
                  </select>
                  <select value={insurance} onChange={(e) => setInsurance(e.target.value)} className="rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm">
                    <option value="">Insurance (optional)</option>
                    <option value="Medicare">Medicare</option>
                    <option value="Medicaid">Medicaid</option>
                    <option value="Blue Cross">Blue Cross</option>
                    <option value="Aetna">Aetna</option>
                    <option value="United Healthcare">United Healthcare</option>
                    <option value="Cigna">Cigna</option>
                    <option value="Kaiser">Kaiser</option>
                  </select>
                  <button type="submit" className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400">
                    Get Top 3 Hospitals
                  </button>
                </form>
                {resolvedAddress && <p className="mt-2 text-xs text-cyan-300">Resolved: {resolvedAddress}</p>}
                {locationError && <p className="mt-2 text-xs text-red-300">{locationError}</p>}
              </section>

              {selectedHospital && (
                <section className="rounded-xl border border-slate-700 bg-slate-950/70 p-4">
                  <h2 className="text-lg font-semibold">Selected Hospital</h2>
                  <div className="mt-2 space-y-1.5 text-sm text-slate-200">
                    <p className="font-semibold text-slate-100">{selectedHospital.name}</p>
                    <p className="text-slate-400">{selectedHospital.address}, {selectedHospital.city}, {selectedHospital.state} {selectedHospital.zip}</p>
                    {selectedHospital.status && (
                      <p>Status: <span className={selectedHospital.status === "Open" ? "text-emerald-300" : selectedHospital.status === "Saturation" ? "text-amber-300" : "text-red-300"}>{selectedHospital.status}</span></p>
                    )}
                    <p>Inpatient util: {Math.round(selectedStats.utilization * 100)}%</p>
                    <p>Inpatient beds: {selectedStats.availableBeds} avail / {selectedHospital.beds?.inpatient_total} total</p>
                    <p>ICU util: {selectedStats.icuUtilization}%</p>
                    <p>ICU beds: {selectedStats.icuAvailable} avail / {selectedHospital.beds?.icu_total} total</p>
                    <p>Est. wait: {selectedStats.waitMins} min</p>
                    {selectedHospital.distanceMiles != null && (
                      <p>Distance: {selectedHospital.distanceMiles} mi ({selectedHospital.durationMins} min drive)</p>
                    )}
                    <p>Routing: {route?.recommended?.id === selectedHospital.id ? "Recommended" : route?.closest?.id === selectedHospital.id ? "Closest (baseline)" : "Alternative"}</p>
                    {selectedHospital.collectionDate && (
                      <p className="text-xs text-slate-400">Data as of: {new Date(selectedHospital.collectionDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</p>
                    )}
                  </div>
                </section>
              )}

              <section className="min-h-0 overflow-auto rounded-xl border border-slate-700 bg-slate-950/70 p-4">
                <h2 className="text-lg font-semibold">Top 3 Hospital Choices</h2>
                {!route && <p className="mt-2 text-sm text-slate-300">Enter a location to get ranked recommendations.</p>}
                {route && (
                  <div className="mt-2 space-y-3 text-sm">
                    <p className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-slate-200">
                      Model: <span className="font-mono text-cyan-300">{route.model}</span>
                    </p>
                    {route.specification && (
                      <p className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-slate-200">
                        Spec: <span className="font-mono text-cyan-300">{route.specification.toUpperCase()}</span>
                      </p>
                    )}
                    {route.closest && <p>Closest: <span className="font-semibold text-slate-100">{route.closest.name}</span> ({route.closest.distanceMiles} mi, {route.closest.durationMins} min)</p>}
                    <div className="space-y-2 pt-1">
                      {(route.top3 || []).map((candidate, index) => (
                        <div key={candidate.id} className="rounded-md border border-slate-700 bg-slate-900/60 p-2">
                          <p className="flex items-center gap-2 font-medium text-slate-100">
                            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-cyan-500/20 text-sm font-bold text-cyan-300">{rankLabels[index]}</span>
                            <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: getNodeColor(candidate.utilization) }} />
                            {candidate.name}
                            {index === 0 && dispatch?.activeRequest?.autoApproved && (
                              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">Auto-Accepted</span>
                            )}
                            {index === 0 && dispatch?.activeRequest?.escalatedFrom && (
                              <span className="rounded-full border border-orange-400/40 bg-orange-400/15 px-2 py-0.5 text-xs font-semibold text-orange-300">Rerouted from {dispatch.activeRequest.escalatedFrom}</span>
                            )}
                          </p>
                          <p className="mt-1 text-xs text-slate-300">
                            {candidate.distanceMiles} mi | {candidate.availableBeds} beds avail | {Math.round(candidate.utilization * 100)}% util | {candidate.waitMins} min wait
                          </p>
                        </div>
                      ))}
                    </div>

                    {!dispatch ? (
                      <button
                        type="button"
                        onClick={handleDispatch}
                        className="mt-2 w-full rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
                      >
                        Dispatch Patient to #1 Recommended
                      </button>
                    ) : (
                      <div className={`mt-2 rounded-md border p-3 text-sm ${dispatchPanelClass(dispatch.status)}`}>
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

        {activeTab === "admin" && isAdminMode && (
          <AdminView hospitals={adminHospitals} onOverride={handleAdminOverride} />
        )}
      </section>
    </main>
  );
}

function buildVoiceReply(summary, resolvedOrigin, geocoded) {
  const specLabels = { stemi: "STEMI", stroke: "stroke", trauma: "trauma" };
  const parts = [];

  if (summary.specification) {
    parts.push(`Heard ${specLabels[summary.specification]} symptoms.`);
  } else {
    parts.push("Got it.");
  }

  if (summary.insurance) {
    parts.push(`Insurance noted as ${summary.insurance}.`);
  }

  if (geocoded) {
    parts.push(`Pinned location at ${geocoded.formattedAddress}.`);
  } else if (summary.location?.phrase && !geocoded) {
    parts.push(`I couldn't pin "${summary.location.phrase}" on the map. Confirm the address.`);
  }

  if (resolvedOrigin && summary.specification) {
    parts.push(`Routing to the closest ${specLabels[summary.specification]}-capable hospital now.`);
  } else if (resolvedOrigin) {
    parts.push("Computing the route now.");
  } else {
    parts.push("Set the patient's location to compute the route.");
  }

  return parts.join(" ");
}

function AdminView({ hospitals, onOverride }) {
  const statusOptions = ["Open", "Saturation", "Diversion"];
  return (
    <section className="min-h-0 overflow-auto">
      <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-4">
        <p className="text-sm font-semibold text-amber-200">Demo Admin — Hospital Status Overrides</p>
        <p className="mt-1 text-xs text-amber-300/70">Force hospital status to test the diversion chain. Overrides block auto-approve so requests come in as pending.</p>
      </div>
      {hospitals.length === 0 && (
        <p className="text-sm text-slate-400">Search for a location on the EMT tab first to load hospitals.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {hospitals.map((h) => (
          <div key={h.hospitalId} className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
            <p className="font-semibold text-slate-100">{h.hospitalName ?? h.hospitalId}</p>
            <div className="mt-1 flex items-center gap-2 text-xs">
              {h.override && (
                <span className={`rounded-full px-2 py-0.5 font-semibold ${statusBadgeColor(h.override)}`}>
                  Override: {h.override}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {statusOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onOverride(h.hospitalId, h.override === s ? null : s)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                    h.override === s
                      ? statusBadgeColor(s)
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

function HospitalView({ nodes, requests, onAccept, onDivert, selectedHospitalFilter, onFilterChange }) {
  return (
    <section className="grid min-h-0 grid-rows-[auto_1fr] gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950/70 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Incoming Patient Requests</h2>
          <p className="mt-1 text-sm text-slate-300">EMT notifications routed to this hospital. Auto-approved when capacity is healthy.</p>
        </div>
        <select value={selectedHospitalFilter} onChange={(e) => onFilterChange(e.target.value)} className="rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100">
          <option value="">All hospitals</option>
          {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </div>
      <div className="min-h-0 overflow-auto">
        {requests.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-slate-700 bg-slate-950/70">
            <p className="text-sm text-slate-400">No incoming requests{selectedHospitalFilter ? " for this hospital" : ""}.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {requests.map((req) => (
              <div key={req.requestId} className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {req.patientSpec && <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold uppercase text-cyan-200">{req.patientSpec}</span>}
                  {req.escalatedFrom && <span className="rounded-full border border-orange-400/30 bg-orange-400/10 px-2.5 py-1 text-xs font-semibold text-orange-200">Rerouted from {req.escalatedFrom}</span>}
                  {req.autoApproved && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">Auto-Approved</span>}
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${requestStatusClass(req.status)}`}>{req.status.charAt(0).toUpperCase() + req.status.slice(1)}</span>
                </div>
                <p className="mt-3 font-semibold text-slate-100">{req.hospitalName}</p>
                <div className="mt-2 space-y-1 text-sm text-slate-300">
                  <p>ETA: <span className="text-slate-100">{req.etaMins != null ? `${req.etaMins} min` : "--"}</span></p>
                  {req.insurance && <p>Insurance: <span className="text-slate-100">{req.insurance}</span></p>}
                  <p className="font-mono text-xs text-slate-500">{new Date(req.requestedAt).toLocaleTimeString()}</p>
                </div>
                {req.status === "pending" && (
                  <div className="mt-4 flex gap-2">
                    <button type="button" onClick={() => onAccept(req.requestId)} className="flex-1 rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/30">Accept</button>
                    <button type="button" onClick={() => onDivert(req.requestId)} className="flex-1 rounded-md bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/30">Divert</button>
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

function nodeUtilization(node) {
  return node.beds?.inpatient_utilization != null ? node.beds.inpatient_utilization / 100 : 0.2;
}

function getHospitalStats(hospital) {
  if (!hospital) return { utilization: 0, availableBeds: "--", icuUtilization: "--", icuAvailable: "--", waitMins: "--" };
  const b = hospital.beds ?? {};
  return {
    utilization: hospital.utilization ?? (b.inpatient_utilization != null ? b.inpatient_utilization / 100 : 0),
    availableBeds: hospital.availableBeds ?? Math.round((b.inpatient_total ?? 0) - (b.inpatient_used ?? 0)),
    icuUtilization: b.icu_utilization ?? "--",
    icuAvailable: Math.round((b.icu_total ?? 0) - (b.icu_used ?? 0)),
    waitMins: hospital.waitMins ?? Math.round(10 + (b.inpatient_utilization ?? 0) * 0.5),
  };
}

function dispatchPanelClass(status) {
  if (status === "accepted") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (status === "exhausted") return "border-red-500/40 bg-red-500/10 text-red-200";
  return "border-cyan-500/40 bg-cyan-500/10 text-cyan-200";
}

function requestStatusClass(status) {
  if (status === "accepted") return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "diverted") return "border border-red-500/30 bg-red-500/10 text-red-200";
  return "border border-amber-500/30 bg-amber-500/10 text-amber-200";
}

function statusBadgeColor(status) {
  switch (status) {
    case "Open": return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "Saturation": return "border border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "Diversion": return "border border-red-500/30 bg-red-500/10 text-red-200";
    default: return "border border-slate-700 bg-slate-800 text-slate-300";
  }
}

function getNodeColor(utilization) {
  if (utilization >= 0.9) return "#ef4444";
  if (utilization >= 0.5) return "#f59e0b";
  return "#34d399";
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
