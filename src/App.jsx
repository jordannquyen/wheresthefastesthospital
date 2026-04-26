import { useEffect, useRef, useState } from "react";
import {
  Autocomplete,
  Circle,
  GoogleMap,
  InfoWindowF,
  MarkerF,
  Polyline,
  useJsApiLoader,
} from "@react-google-maps/api";
import { useVoice } from "./hooks/useVoice.js";
import { extractPatient } from "./lib/extractPatient.js";
import { apiFetch } from "./lib/api.js";
import { useAuth } from "./lib/auth.jsx";
import { LoginScreen } from "./components/LoginScreen.jsx";
import { RoleMismatchScreen } from "./components/RoleMismatchScreen.jsx";
import logo from "./assets/logo_nobkg.png";

const isAdminMode = new URLSearchParams(window.location.search).has("admin");
const appPath = window.location.pathname.replace(/\/$/, "") || "/";
const isHospitalPage = appPath === "/hospital";
const isEmtPage = appPath === "/emt";
const isLoginPage = appPath === "/login";
const isLandingPage = appPath === "/" && !isAdminMode;
const pageRole = isAdminMode ? "admin" : isHospitalPage ? "hospital" : isEmtPage ? "emt" : null;
const centerGL = { lat: 34.0522, lng: -118.2437 };
const defaultZoom = 11;
const mapContainerStyle = { width: "100%", height: "100%" };
const mapsApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
const mapsLibraries = ["places"];
const rankLabels = ["1", "2", "3"];

function buildPickedOverDiff(a, b) {
  if (!a || !b) return "";
  const parts = [];

  if (a.durationMins != null && b.durationMins != null && b.durationMins > 0) {
    const pct = Math.round(((b.durationMins - a.durationMins) / b.durationMins) * 100);
    if (pct >= 10) parts.push(`${pct}% lower ETA`);
  }

  if (a.availableBeds != null && b.availableBeds != null) {
    const delta = a.availableBeds - b.availableBeds;
    if (delta >= 3) parts.push(`${delta} more open beds`);
  }

  return parts.join(", ");
}

function App() {
  if (isLandingPage) return <LandingPage />;
  if (isLoginPage) return <LoginRoute />;
  return <AuthGate />;
}

function AuthGate() {
  const { user, loading: authLoading } = useAuth();
  if (authLoading) return <FullscreenSpinner />;
  if (!user) return <LoginScreen pageRole={pageRole ?? "emt"} />;
  if (user.role !== pageRole) return <RoleMismatchScreen current={user.role} needed={pageRole} />;
  return <AuthenticatedApp user={user} />;
}

function LoginRoute() {
  const { user, loading: authLoading } = useAuth();
  // Already signed in? Send them straight to their console.
  useEffect(() => {
    if (!authLoading && user) {
      window.location.replace(ROLE_HOME[user.role] ?? "/");
    }
  }, [authLoading, user]);
  if (authLoading || user) return <FullscreenSpinner />;
  return <LoginScreen pageRole={null} />;
}

function FullscreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
      <div className="font-mono text-xs uppercase tracking-[0.22em]">Loading…</div>
    </div>
  );
}

function LandingPage() {
  const { user, logout } = useAuth();
  return (
    <main className="screen bg-grid text-slate-100">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-3">
            <img src={logo} alt="Vital-Route logo" className="h-10 w-auto" />
            <span className="text-lg font-bold tracking-tight">wtf-hospital</span>
            <span className="text-sm text-slate-400">(Where's The Fastest Hospital?)</span>
          </a>
          <LandingAuthBadge user={user} onLogout={logout} />
        </header>

        <div className="grid flex-1 items-center gap-8 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:py-12">
          <section>
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-300">voice intake to hospital acceptance</p>
            <h1 className="mt-4 max-w-3xl text-5xl font-bold leading-[1.02] tracking-tight text-white sm:text-6xl lg:text-7xl">
              Route emergency patients faster.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-300">
              Turn EMT voice reports into structured patient records, rank nearby hospitals by capacity and ETA, and give receiving teams a live incoming-patient queue.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href={user ? (ROLE_HOME[user.role] ?? "/login") : "/login"}
                className="inline-flex items-center justify-center rounded-md bg-cyan-400 px-6 py-3 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:bg-cyan-300"
              >
                Explore
              </a>
            </div>
            <p className="mt-4 text-xs text-slate-400">
              {user
                ? `Signed in as ${user.displayName ?? user.username}. Explore opens your ${user.role === "hospital" ? "hospital" : user.role === "admin" ? "admin" : "EMT"} console.`
                : "Sign in or create an account to access the EMT or hospital console."}
            </p>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-700 bg-slate-950/70 shadow-2xl shadow-black/40">
            <div className="border-b border-slate-700 bg-slate-900/80 px-4 py-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-cyan-300">live workflow</p>
            </div>
            <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-1">
              <img src={logo} alt="Vital-Route" className="mx-auto h-44 w-auto object-contain p-8 sm:h-full lg:h-52" />
              <div className="border-t border-slate-700 p-5 sm:border-l sm:border-t-0 lg:border-l-0 lg:border-t">
                <div className="space-y-3 text-sm">
                  {[
                    ["1", "EMT voice transcript captured"],
                    ["2", "AI extracts patient severity and vitals"],
                    ["3", "MongoDB patient record created"],
                    ["4", "Hospital accepts from dashboard"],
                  ].map(([step, label]) => (
                    <div key={step} className="flex items-center gap-3 rounded-md border border-slate-700 bg-slate-900/70 p-3">
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 font-mono text-xs font-bold text-cyan-300">{step}</span>
                      <span className="text-slate-200">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

const ROLE_HOME = { emt: "/emt", hospital: "/hospital", admin: "/?admin=true" };

function LandingAuthBadge({ user, onLogout }) {
  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <a
          href="/login"
          className="rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
        >
          Sign in
        </a>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-right">
      <div className="hidden text-xs sm:block">
        <p className="font-semibold text-slate-100">{user.displayName ?? user.username}</p>
        <p className="text-[11px] uppercase tracking-wide text-slate-400">
          {user.role === "hospital" ? user.hospitalName ?? "Hospital" : user.role === "admin" ? "Admin" : "EMT"}
        </p>
      </div>
      <a
        href={ROLE_HOME[user.role] ?? "/"}
        className="rounded-md bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400"
      >
        Open console
      </a>
      <button
        type="button"
        onClick={onLogout}
        className="rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
      >
        Log out
      </button>
    </div>
  );
}

function AuthenticatedApp({ user }) {
  const { logout } = useAuth();
  const [nodes, setNodes] = useState([]);
  const [origin, setOrigin] = useState(null);
  const [route, setRoute] = useState(null);
  const [pulseTick, setPulseTick] = useState(false);
  const [provider, setProvider] = useState("fallback");
  const [selectedHospitalId, setSelectedHospitalId] = useState(null);
  const [locationAddress, setLocationAddress] = useState("");
  const [resolvedAddress, setResolvedAddress] = useState("");
  const [locationDetecting, setLocationDetecting] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [insurance, setInsurance] = useState("");
  const [activeTab, setActiveTab] = useState(isHospitalPage ? "hospital" : isAdminMode ? "admin" : "emt");
  const [hospitalRequests, setHospitalRequests] = useState([]);
  const [sentRequests, setSentRequests] = useState({}); // { [hospitalId]: requestId }
  const [mapCenter, setMapCenter] = useState(centerGL);
  const [mapZoom, setMapZoom] = useState(defaultZoom);
  const [dispatch, setDispatch] = useState(null);
  const [adminHospitals, setAdminHospitals] = useState([]);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [patientSummary, setPatientSummary] = useState(null);
  const [currentPatientId, setCurrentPatientId] = useState(null);
  const [editingLocation, setEditingLocation] = useState(false);
  const [locationDraft, setLocationDraft] = useState("");
  const [handoffDone, setHandoffDone] = useState(false);
  const mapRef = useRef(null);
  const originRef = useRef(origin);
  const prevDispatchRef = useRef(null);
  const locationAutocompleteRef = useRef(null);
  const voice = useVoice();

  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  useEffect(() => {
    apiFetch("/api/health")
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
    const pulseInterval = setInterval(() => setPulseTick((c) => !c), 900);
    return () => clearInterval(pulseInterval);
  }, []);

  // Attempt GPS → ip-api.com → LA default. Runs immediately on mount,
  // independent of Google Maps loading. Reverse geocoding waits for isLoaded.
  const didAutofillGpsRef = useRef(false);
  useEffect(() => {
    if (didAutofillGpsRef.current) return;
    didAutofillGpsRef.current = true;

    async function initLocation() {
      setLocationDetecting(true);
      let loc = null;
      let source = null;

      if (navigator.geolocation) {
        loc = await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            (err) => { console.warn("GPS:", err.message); resolve(null); },
            { enableHighAccuracy: false, timeout: 6_000, maximumAge: 300_000 },
          );
        });
        if (loc) source = "gps";
      }

      if (!loc) {
        try {
          // ip-api.com: free tier is HTTP only, 45 req/min, no key required
          const r = await fetch("http://ip-api.com/json/?fields=lat,lon,status,message", { signal: AbortSignal.timeout(4000) });
          const d = await r.json();
          if (d.status === "success" && d.lat && d.lon) {
            loc = { lat: d.lat, lng: d.lon };
            source = "ip";
          } else {
            console.warn("ip-api.com:", d.message ?? d.status);
          }
        } catch (err) {
          console.warn("IP geolocation failed:", err.message);
        }
      }

      // Default to central LA so the app is always usable
      if (!loc) {
        loc = { lat: 34.0522, lng: -118.2437 };
        source = "default";
        console.warn("Using LA default location — allow browser location or type an address to override.");
      }

      setLocationDetecting(false);
      console.log(`Location: ${source}`, loc);

      // Reverse geocoding needs Google Maps — wait up to 6 s for it to load
      let display = source === "default" ? "Los Angeles, CA" : null;
      const deadline = Date.now() + 6000;
      while (!window.google?.maps?.Geocoder && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (window.google?.maps?.Geocoder) {
        display = (await reverseGeocode(loc)) ?? display;
      }
      display = display ?? "Los Angeles, CA";

      setLocationAddress(display);
      setResolvedAddress(display);
      await fetchHospitalsByCoords(loc.lat, loc.lng);
      await requestRecommendations(loc);
    }

    initLocation();
  }, []);

  function reverseGeocode(loc) {
    return new Promise((resolve) => {
      const geocoder = new window.google.maps.Geocoder();
      geocoder.geocode({ location: loc }, (results, status) => {
        if (status === "OK" && results?.[0]) {
          resolve(results[0].formatted_address);
        } else {
          console.warn("Reverse geocode failed:", status);
          resolve(null);
        }
      });
    });
  }

  // Poll hospital requests when on hospital page or tab
  useEffect(() => {
    if (!isHospitalPage && activeTab !== "hospital") return;
    if (user.role !== "hospital" || !user.hospitalId) return;
    fetchHospitalRequests();
    const iv = setInterval(fetchHospitalRequests, 3500);
    return () => clearInterval(iv);
  }, [activeTab, user.hospitalId, user.role]);

  // Poll dispatch status while active
  useEffect(() => {
    if (!dispatch?.dispatchId || dispatch.status !== "active") return;
    const iv = setInterval(async () => {
      const res = await apiFetch(`/api/dispatch/${dispatch.dispatchId}`);
      const data = await res.json();
      if (res.ok) setDispatch(data);
    }, 3000);
    return () => clearInterval(iv);
  }, [dispatch?.dispatchId, dispatch?.status]);

  // Announce dispatch status changes via TTS
  useEffect(() => {
    if (!dispatch || !voiceEnabled) { prevDispatchRef.current = dispatch; return; }
    const prev = prevDispatchRef.current;
    prevDispatchRef.current = dispatch;
    if (!prev) return; // initial set — already announced at dispatch time

    const hospital = dispatch.currentHospital;
    const prevHospital = prev.currentHospital;

    if (dispatch.status === "accepted" && prev.status !== "accepted") {
      voice.speak(`Confirmed. ${hospital?.hospitalName} is ready. En route.`);
    } else if (dispatch.status === "exhausted" && prev.status !== "exhausted") {
      voice.speak("All hospitals have diverted. Please contact dispatch for further instructions.");
    } else if (dispatch.currentIndex > (prev.currentIndex ?? 0)) {
      const eta = hospital?.etaMins ?? "unknown";
      const autoApproved = dispatch.activeRequest?.autoApproved;
      if (autoApproved) {
        voice.speak(`${prevHospital?.hospitalName} diverted. Auto-approved at ${hospital?.hospitalName}, ${eta} minutes away. En route.`);
      } else {
        voice.speak(`${prevHospital?.hospitalName} diverted. Escalating to ${hospital?.hospitalName}, ${eta} minutes away. Awaiting confirmation.`);
      }
    }
  }, [dispatch]);

  // Populate admin hospitals from nodes (admin role only)
  useEffect(() => {
    if (user.role !== "admin" || nodes.length === 0) return;
    apiFetch("/api/admin/overrides")
      .then((r) => r.json())
      .then((data) => {
        setAdminHospitals(
          nodes.map((n) => ({ hospitalId: n.id, hospitalName: n.name, override: data.overrides?.[n.id] ?? null }))
        );
      })
      .catch(() => {
        setAdminHospitals(nodes.map((n) => ({ hospitalId: n.id, hospitalName: n.name, override: null })));
      });
  }, [nodes, user.role]);

  async function fetchHospitalsByCoords(lat, lng) {
    try {
      const res = await apiFetch("/api/hospitals-by-coords", {
        method: "POST",
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
    if (user.role !== "hospital" || !user.hospitalId) return;
    const hospitalParam = user.hospitalId === "__all__" ? "__all__" : user.hospitalId;
    const res = await apiFetch(`/api/hospitals/${hospitalParam}/incoming-patients`);
    const data = await res.json();
    const cards = [];
    for (const patient of (data.patients ?? [])) {
      // Add a diverted card for each divert history entry matching this hospital
      if (patient.divertHistory?.length) {
        for (const entry of patient.divertHistory) {
          if (user.hospitalId === "__all__" || entry.hospitalId === user.hospitalId) {
            cards.push(patientToRequestCard(patient, entry));
          }
        }
      }
      // Add the current active card if this hospital is currently routed here
      const isCurrentHospital = user.hospitalId === "__all__"
        || patient.assignedHospitalId === user.hospitalId
        || patient.recommendedHospitalId === user.hospitalId;
      if (isCurrentHospital) cards.push(patientToRequestCard(patient));
    }
    setHospitalRequests(cards);
  }

  async function handleRequest(candidate) {
    const res = await apiFetch("/api/dispatch", {
      method: "POST",
      body: JSON.stringify({
        chain: [{
          hospitalId: candidate.id,
          hospitalName: candidate.name,
          etaMins: candidate.durationMins,
          utilization: candidate.utilization,
          availableBeds: candidate.availableBeds,
          waitMins: candidate.waitMins,
        }],
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
    const res = await apiFetch("/api/dispatch", {
      method: "POST",
      body: JSON.stringify({ chain, insurance: insurance || null }),
    });
    const data = await res.json();
    if (res.ok) {
      const pollRes = await apiFetch(`/api/dispatch/${data.dispatchId}`);
      const pollData = await pollRes.json();
      if (pollRes.ok) setDispatch(pollData);
    }
  }

  async function handlePatientHandoff() {
    // Try the in-memory request path first, then fall back to direct patient update
    const requestId = dispatch?.activeRequest?.requestId;
    const patientId = dispatch?.activeRequest?.patientId ?? dispatch?.patientId ?? currentPatientId ?? patientSummary?.patientId;

    if (requestId) {
      await apiFetch(`/api/requests/${requestId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "delivered" }),
      });
    } else if (patientId) {
      await apiFetch(`/api/patients/${patientId}/deliver`, { method: "PATCH" });
    }

    // Also always hit the direct patient endpoint to guarantee MongoDB is updated
    if (patientId) {
      await apiFetch(`/api/patients/${patientId}/deliver`, { method: "PATCH" }).catch(() => {});
    }

    setHandoffDone(true);
    setTimeout(() => {
      setHandoffDone(false);
      setDispatch(null);
      setRoute(null);
      setPatientSummary(null);
      setSentRequests({});
    }, 1800);
  }

  async function handleRequestAction(request, status) {
    if (request.source === "patient") {
      if (status === "accepted") {
        await apiFetch(`/api/patients/${request.patientId}/accept`, {
          method: "PATCH",
          body: JSON.stringify({
            hospitalId: request.hospitalId,
            hospitalName: request.hospitalName,
            etaMinutes: request.etaMins,
          }),
        });
      } else if (status === "diverted") {
        await apiFetch(`/api/patients/${request.patientId}/divert`, { method: "PATCH" });
      }
      fetchHospitalRequests();
      return;
    }

    await apiFetch(`/api/requests/${request.requestId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    fetchHospitalRequests();
  }

  async function handleAdminOverride(hospitalId, status) {
    if (!status) {
      await apiFetch(`/api/admin/override/${hospitalId}`, { method: "DELETE" });
    } else {
      await apiFetch("/api/admin/override", {
        method: "POST",
        body: JSON.stringify({ hospitalId, status }),
      });
    }
    const res = await apiFetch("/api/admin/overrides");
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

  async function handleLocationPlaceChanged() {
    const place = locationAutocompleteRef.current?.getPlace();
    if (!place?.geometry?.location) return;
    const loc = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() };
    const display = place.formatted_address ?? locationDraft;
    setResolvedAddress(display);
    setLocationAddress(display);
    setEditingLocation(false);
    await fetchHospitalsByCoords(loc.lat, loc.lng);
    await requestRecommendations(loc);
  }

  async function handleLocationManualSubmit() {
    const draft = locationDraft.trim();
    if (!draft) { setEditingLocation(false); return; }
    try {
      const res = await apiFetch("/api/geocode", {
        method: "POST",
        body: JSON.stringify({ address: draft }),
      });
      const data = await res.json();
      if (res.ok && data.location) {
        const display = data.formattedAddress ?? draft;
        setResolvedAddress(display);
        setLocationAddress(display);
        await fetchHospitalsByCoords(data.location.lat, data.location.lng);
        await requestRecommendations(data.location);
      }
    } catch { /* ignore */ }
    setEditingLocation(false);
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

      let summary;
      try {
        const extractRes = await apiFetch("/api/extract-patient", {
          method: "POST",
          body: JSON.stringify({ transcript }),
        });
        summary = extractRes.ok ? await extractRes.json() : extractPatient(transcript);
      } catch {
        summary = extractPatient(transcript);
      }
      if (summary.insuranceProvider) setInsurance(summary.insuranceProvider);

      let geocoded = null;
      let resolvedOrigin = originRef.current;

      // If no origin yet (geolocation hadn't fired), fetch it now
      if (!resolvedOrigin && navigator.geolocation) {
        resolvedOrigin = await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            { timeout: 5000 }
          );
        });
        if (resolvedOrigin) await fetchHospitalsByCoords(resolvedOrigin.lat, resolvedOrigin.lng);
      }

      if (summary.address) {
        geocoded = await geocodeVoiceLocation(summary.address);
        if (geocoded) {
          resolvedOrigin = geocoded.location;
          setLocationAddress(geocoded.formattedAddress);
          setResolvedAddress(geocoded.formattedAddress);
          setLocationError("");
          await fetchHospitalsByCoords(resolvedOrigin.lat, resolvedOrigin.lng);
        }
      }

      const patientPayload = {
        ...summary,
        latitude: resolvedOrigin?.lat,
        longitude: resolvedOrigin?.lng,
        address: geocoded?.formattedAddress ?? summary.address ?? resolvedAddress,
      };
      const patient = currentPatientId
        ? await updatePatientFromVoice(currentPatientId, patientPayload)
        : await createPatientFromIntake(patientPayload);
      if (patient?.patientId) {
        setCurrentPatientId(patient.patientId);
        setPatientSummary(patient);
        summary = patient;
      } else {
        setPatientSummary(summary);
      }

      const reply = buildVoiceReply(summary, resolvedOrigin, geocoded);

      if (resolvedOrigin) {
        const routeData = await requestRecommendations(resolvedOrigin, { insurance: summary.insuranceProvider, patientId: summary.patientId, condition: summary.condition });
        const dispatchData = await autoDispatch(routeData, summary.insuranceProvider, summary);
        const hospital = dispatchData?.currentHospital;
        const req = dispatchData?.activeRequest;
        const eta = hospital?.etaMins ?? "unknown";
        const statusPhrase = req?.autoApproved
          ? "Auto-approved. En route."
          : "Awaiting hospital confirmation.";
        voice.speak(`${reply} Dispatching to ${hospital?.hospitalName ?? "top hospital"}, ${eta} minutes away. ${statusPhrase}`);
      } else {
        voice.speak(reply);
      }
    } else {
      await voice.start();
    }
  }

  async function geocodeVoiceLocation(phrase) {
    try {
      const res = await apiFetch("/api/geocode", {
        method: "POST",
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
    const effectiveInsurance = overrides.insurance ?? insurance;
    const effectiveCondition = overrides.condition ?? patientSummary?.condition ?? null;
    const res = await apiFetch("/api/route", {
      method: "POST",
      body: JSON.stringify({
        origin: inputOrigin,
        condition: effectiveCondition,
        insurance: effectiveInsurance || null,
      }),
    });
    const data = await res.json();
    setRoute(data);
    if (overrides.patientId && data.recommended) {
      await saveRouteRecommendation(overrides.patientId, data.recommended);
    }
    setProvider(data.provider ?? "fallback");
    if (data.insurance && !data.insuranceMatchFound) {
      setLocationError(
        `No hospitals accepting ${data.insurance} found nearby, showing best available options.`,
      );
    }
    return data;
  }

  async function autoDispatch(routeData, effectiveInsurance, summaryData) {
    if (!routeData?.top3?.length) return null;
    const chain = routeData.top3.map((c) => ({
      hospitalId: c.id,
      hospitalName: c.name,
      etaMins: c.durationMins,
      utilization: c.utilization,
      availableBeds: c.availableBeds,
      waitMins: c.waitMins,
    }));
    const res = await apiFetch("/api/dispatch", {
      method: "POST",
      body: JSON.stringify({
        chain,
        insurance: effectiveInsurance || insurance || null,
        patientId: summaryData?.patientId ?? currentPatientId,
        patientSummary: summaryData ?? null,
      }),
    });
    if (!res.ok) return null;
    const dispatchMeta = await res.json();
    const pollRes = await apiFetch(`/api/dispatch/${dispatchMeta.dispatchId}`);
    const dispatchData = await pollRes.json();
    if (pollRes.ok) setDispatch(dispatchData);
    return dispatchData;
  }

  const selectedHospital =
    route?.candidates?.find((c) => c.id === selectedHospitalId) ??
    nodes.find((n) => n.id === selectedHospitalId) ??
    null;
  const selectedStats = getHospitalStats(selectedHospital);

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

  // The role gate at the top of App() guarantees user.role === pageRole here.
  const tabs = pageRole === "hospital"
    ? ["hospital"]
    : pageRole === "admin"
      ? ["admin"]
      : ["emt"];

  return (
    <main className="screen bg-grid text-slate-100">
      <section className="mx-auto grid h-full w-full max-w-[1500px] grid-rows-[auto_auto_1fr] gap-4 p-4 lg:p-6">
        <header className="flex items-center gap-4 rounded-xl border border-slate-700 bg-slate-950/70 p-4 shadow-xl shadow-black/40 backdrop-blur">
          <a href="/" className="flex flex-1 items-center gap-4">
            <img src={logo} alt="Vital-Route logo" className="h-10 w-auto" />
            <div>
              <h1 className="text-3xl font-semibold tracking-tight lg:text-4xl">wtf-hospital</h1>
              <p className="mt-1 text-sm text-slate-300">optimize saving lives</p>
            </div>
          </a>
          <div className="flex items-center gap-3 text-right">
            <div className="hidden text-xs sm:block">
              <p className="font-semibold text-slate-100">{user.displayName ?? user.username}</p>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">
                {user.role === "hospital"
                  ? user.hospitalName ?? "Hospital"
                  : user.role === "admin"
                    ? "Admin"
                    : "EMT"}
              </p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="rounded-md border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              Log out
            </button>
          </div>
        </header>

        {tabs.length > 1 && (
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
        )}

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

              <div
                className={`absolute left-3 top-3 max-w-[280px] rounded-lg border border-slate-600/90 bg-slate-950/85 px-3 py-2 backdrop-blur transition-shadow ${editingLocation ? "ring-1 ring-cyan-500/60" : "cursor-pointer hover:border-slate-400/80"}`}
                onClick={!editingLocation ? () => { setLocationDraft(resolvedAddress); setEditingLocation(true); } : undefined}
              >
                <p className="font-mono text-[10px] uppercase tracking-wide text-cyan-400">
                  {editingLocation ? "Enter address" : "Current location"}
                </p>
                {editingLocation ? (
                  <Autocomplete
                    onLoad={(a) => { locationAutocompleteRef.current = a; }}
                    onPlaceChanged={handleLocationPlaceChanged}
                  >
                    <input
                      autoFocus
                      value={locationDraft}
                      onChange={(e) => setLocationDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditingLocation(false);
                        if (e.key === "Enter") handleLocationManualSubmit();
                      }}
                      onBlur={() => setTimeout(() => setEditingLocation(false), 200)}
                      className="mt-0.5 w-full bg-transparent text-xs text-slate-200 outline-none border-b border-slate-500/70 pb-0.5 placeholder-slate-500"
                      placeholder="Search address…"
                    />
                  </Autocomplete>
                ) : (
                  <p className={`mt-0.5 text-xs leading-snug ${resolvedAddress ? "text-slate-200" : "text-slate-500 italic"}`}>
                    {resolvedAddress || (locationDetecting ? "Detecting…" : "Tap to set location")}
                  </p>
                )}
              </div>

              <div className="pointer-events-none absolute bottom-3 right-3 max-w-[240px] rounded-lg border border-slate-600/90 bg-slate-950/85 p-3 backdrop-blur">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-200">Legend</p>
                <ul className="mt-2 space-y-1.5 text-xs text-slate-300">
                  <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" />Green: &lt;70% util</li>
                  <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />Yellow: 70–96% util</li>
                  <li><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-red-500" />Red: 97%+ util</li>
                  <li><span className="mr-2 inline-block h-[2px] w-6 bg-sky-400 align-middle" />Top recommendation</li>
                  <li><span className="mr-2 inline-block h-[2px] w-6 border-b border-dashed border-slate-400 align-middle" />Closest baseline</li>
                </ul>
              </div>
            </article>

            <aside className="flex min-h-0 flex-col gap-4">
              <section className="rounded-xl border border-slate-700 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Voice Intake</h2>
                  <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${voiceEnabled ? "text-emerald-300" : "text-slate-500"}`}>
                    {voiceEnabled ? "ElevenLabs ready" : "voice offline"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleTalkToggle}
                  disabled={!voiceEnabled || voice.isProcessing}
                  className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-semibold transition ${
                    voice.isListening
                      ? "bg-red-500 text-white hover:bg-red-400"
                      : "bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                  } ${(!voiceEnabled || voice.isProcessing) ? "cursor-not-allowed opacity-60" : ""} ${
                    !route && !voice.isListening && !voice.isProcessing && !voice.isSpeaking && voiceEnabled
                      ? "ring-2 ring-cyan-400/60 animate-pulse"
                      : ""
                  }`}
                >
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${voice.isListening ? "animate-pulse bg-white" : "bg-slate-950/60"}`} />
                  {voice.isListening
                    ? "Listening — tap to stop"
                    : voice.isProcessing
                      ? "Transcribing…"
                      : voice.isSpeaking
                        ? "Speaking…"
                        : "Tap to talk"}
                </button>
                {voice.error && <p className="mt-2 text-xs text-red-300">{voice.error}</p>}
                {resolvedAddress && <p className="mt-2 text-xs text-slate-500">Location: {resolvedAddress}</p>}
                {locationError && <p className="mt-1 text-xs text-red-300">{locationError}</p>}
              </section>

              <section className="max-h-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950/70 p-4">
                <h2 className="text-sm font-semibold text-slate-300">Call Transcript</h2>
                {!voice.isListening && !voice.isProcessing && !patientSummary && (
                  <p className="mt-2 text-xs text-slate-500">Transcript appears here after voice intake. Click the map to set location manually.</p>
                )}
                {voice.isListening && (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
                    <span className="text-sm text-slate-300 animate-pulse">Recording…</span>
                  </div>
                )}
                {voice.isProcessing && (
                  <p className="mt-3 text-sm text-slate-400">Transcribing…</p>
                )}
                {patientSummary && (
                  <div className="mt-2 space-y-1.5 text-xs text-slate-200">
                    {patientSummary.transcript && (
                      <p className="rounded-md border border-slate-700 bg-slate-900/60 p-2 italic leading-relaxed text-slate-300">
                        "{patientSummary.transcript}"
                      </p>
                    )}
                    <div className="mt-1 space-y-1 rounded-lg border border-slate-700/50 bg-slate-900/40 p-2">
                      <p className="font-mono text-[10px] uppercase tracking-wide text-cyan-300">Extracted</p>
                      {patientSummary.name && <p>Name: <span className="font-semibold text-white">{patientSummary.name}</span></p>}
                      {(patientSummary.age || patientSummary.sex) && (
                        <p>Demographics: {[patientSummary.age && `${patientSummary.age}y`, patientSummary.sex].filter(Boolean).join(", ")}</p>
                      )}
                      {patientSummary.chiefComplaint && <p>Complaint: <span className="font-semibold text-white">{patientSummary.chiefComplaint}</span></p>}
                      {patientSummary.condition && <p>Condition: <span className="font-semibold text-white">{patientSummary.condition.toUpperCase()}</span></p>}
                      {patientSummary.severity && <p>Severity: <span className="font-semibold text-white">{patientSummary.severity}</span></p>}
                      {patientSummary.insuranceProvider && <p>Insurance: <span className="font-semibold text-white">{patientSummary.insuranceProvider}</span></p>}
                      {patientSummary.address && <p>Location heard: <span className="font-semibold text-white">{patientSummary.address}</span></p>}
                      {(patientSummary.bloodPressure || patientSummary.heartRate || patientSummary.oxygenSaturation || patientSummary.respiratoryRate) && (
                        <p>Vitals: {[
                          patientSummary.bloodPressure && `BP ${patientSummary.bloodPressure}`,
                          patientSummary.heartRate && `HR ${patientSummary.heartRate}`,
                          patientSummary.oxygenSaturation && `SpO₂ ${patientSummary.oxygenSaturation}%`,
                          patientSummary.respiratoryRate && `RR ${patientSummary.respiratoryRate}`,
                        ].filter(Boolean).join(" · ")}</p>
                      )}
                      {patientSummary.summary && <p>Summary: <span className="font-semibold text-white">{patientSummary.summary}</span></p>}
                      {patientSummary.confidence != null && <p>Confidence: <span className="font-semibold text-white">{Math.round(patientSummary.confidence * 100)}%</span></p>}
                    </div>
                  </div>
                )}
              </section>


              <section className={`flex-1 min-h-0 overflow-auto rounded-xl border border-slate-700 bg-slate-950/70 p-4 transition-opacity duration-500 ${handoffDone ? "opacity-30" : "opacity-100"}`}>
                <h2 className="text-lg font-semibold">Top 3 Hospital Choices</h2>
                {!route && <p className="mt-2 text-sm text-slate-300">Click anywhere on the map, type an address, or tap the mic to start.</p>}
                {route && (
                  <div className="mt-2 space-y-3 text-sm">
                    <p className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-slate-200">
                      Model: <span className="font-mono text-cyan-300">{route.model}</span>
                    </p>
                    {route.closest && <p>Closest: <span className="font-semibold text-slate-100">{route.closest.name}</span> ({route.closest.distanceMiles} mi, {route.closest.durationMins} min)</p>}
                    <div className="space-y-2 pt-1">
                      {(route.top3 || []).map((candidate, index) => {
                        const chainEntry = dispatch?.chain?.find((e) => e.hospitalId === candidate.id);
                        return (
                        <div key={candidate.id} className="rounded-md border border-slate-700 bg-slate-900/60 p-2">
                          <p className="flex flex-wrap items-center gap-2 font-medium text-slate-100">
                            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-cyan-500/20 text-sm font-bold text-cyan-300">{rankLabels[index]}</span>
                            <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: getNodeColor(candidate.utilization) }} />
                            {candidate.name}
                            {chainEntry?.requestStatus === "diverted" && (
                              <span className="rounded-full border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 text-xs font-semibold text-amber-300">Rerouted</span>
                            )}
                            {chainEntry?.requestStatus === "accepted" && chainEntry?.autoApproved && (
                              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">Auto-Accepted</span>
                            )}
                            {chainEntry?.requestStatus === "accepted" && !chainEntry?.autoApproved && (
                              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">Accepted</span>
                            )}
                          </p>
                          {(candidate.traumaLevel || candidate.strokeCapable || candidate.cardiacCapable) && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {candidate.traumaLevel && (
                                <span className="rounded-full border border-orange-400/40 bg-orange-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-300">
                                  Trauma Lvl {candidate.traumaLevel}
                                </span>
                              )}
                              {candidate.strokeCapable && (
                                <span className="rounded-full border border-violet-400/40 bg-violet-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
                                  Stroke
                                </span>
                              )}
                              {candidate.cardiacCapable && (
                                <span className="rounded-full border border-rose-400/40 bg-rose-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
                                  Cardiac
                                </span>
                              )}
                            </div>
                          )}
                          <p className="mt-1 text-xs text-slate-300">
                            {candidate.distanceMiles} mi ({candidate.durationMins} min) | {candidate.availableBeds} beds avail ({Math.round(candidate.utilization * 100)}% util) | {candidate.waitMins} min wait
                          </p>
                          {index === 0 && route.top3[1] && buildPickedOverDiff(route.top3[0], route.top3[1]) && (
                            <p className="mt-1 text-[11px] italic text-cyan-300/80">
                              Picked over {route.top3[1].name}: {buildPickedOverDiff(route.top3[0], route.top3[1])}
                            </p>
                          )}
                        </div>
                        );
                      })}
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
                          <>
                            <p className={`font-semibold transition-opacity duration-500 ${handoffDone ? "opacity-0" : "opacity-100"}`}>
                              Confirmed — en route to {dispatch.currentHospital?.hospitalName}
                            </p>
                            <button
                              type="button"
                              onClick={handlePatientHandoff}
                              disabled={handoffDone}
                              className={`mt-2 w-full rounded-md px-3 py-2 text-sm font-semibold transition-all duration-300 ${
                                handoffDone
                                  ? "scale-95 bg-emerald-400 text-slate-950 cursor-default"
                                  : "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                              }`}
                            >
                              {handoffDone ? "Done! ✓" : "Patient Handed Off"}
                            </button>
                          </>
                        )}
                        {dispatch.status === "exhausted" && (
                          <>
                            <p className="font-semibold">All hospitals diverted — contact dispatch</p>
                            <button
                              type="button"
                              onClick={handlePatientHandoff}
                              className="mt-2 w-full rounded-md bg-slate-600 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:bg-slate-500"
                            >
                              Clear &amp; New Patient
                            </button>
                          </>
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
            hospitalName={user.hospitalName}
            requests={hospitalRequests}
            onAccept={(request) => handleRequestAction(request, "accepted")}
            onDivert={(request) => handleRequestAction(request, "diverted")}
            onDelete={async (request) => {
              await apiFetch(`/api/patients/${request.patientId}`, { method: "DELETE" });
              fetchHospitalRequests();
            }}
          />
        )}

        {activeTab === "admin" && user.role === "admin" && (
          <AdminView hospitals={adminHospitals} onOverride={handleAdminOverride} />
        )}
      </section>
    </main>
  );
}

function buildVoiceReply(summary, resolvedOrigin, geocoded) {
  const parts = [];

  if (summary.condition) {
    parts.push(`Heard possible ${summary.condition} emergency.`);
  } else {
    parts.push("Got it.");
  }

  if (summary.insuranceProvider) {
    parts.push(`Insurance noted as ${summary.insuranceProvider}.`);
  }

  if (geocoded) {
    parts.push(`Pinned location at ${geocoded.formattedAddress}.`);
  } else if (summary.address && !geocoded) {
    parts.push(`I couldn't pin "${summary.address}" on the map. Confirm the address.`);
  }

  if (resolvedOrigin) {
    parts.push("Computing the route now.");
  } else {
    parts.push("Set the patient's location to compute the route.");
  }

  return parts.join(" ");
}

async function createPatientFromIntake(payload) {
  try {
    const res = await apiFetch("/api/patients/intake", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return res.ok ? data.patient : null;
  } catch {
    return null;
  }
}

async function updatePatientFromVoice(patientId, payload) {
  try {
    const res = await apiFetch(`/api/patients/${patientId}/voice-update`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    return res.ok ? data.patient : null;
  } catch {
    return null;
  }
}

async function saveRouteRecommendation(patientId, recommended) {
  try {
    await apiFetch(`/api/patients/${patientId}/route`, {
      method: "PATCH",
      body: JSON.stringify({
        recommendedHospitalId: recommended.id,
        recommendedHospitalName: recommended.name,
        etaMinutes: recommended.durationMins,
        routingReason: "Best ranked hospital based on ETA, wait time, capacity, and status.",
      }),
    });
  } catch { /* non-blocking */ }
}

function patientToRequestCard(patient, divertEntry = null) {
  if (divertEntry) {
    return {
      source: "patient",
      requestId: `${patient.patientId}-diverted-${divertEntry.hospitalId}`,
      patientId: patient.patientId,
      hospitalId: divertEntry.hospitalId,
      hospitalName: divertEntry.hospitalName,
      status: "diverted",
      divertedTo: divertEntry.divertedToName,
      insurance: patient.insuranceProvider,
      patientSummary: patient,
      etaMins: patient.etaMinutes,
      requestedAt: divertEntry.divertedAt ?? patient.createdAt ?? new Date().toISOString(),
      acceptedAt: null,
      deliveredAt: null,
    };
  }
  const status = patient.status === "delivered" ? "delivered"
    : patient.status === "accepted" ? "accepted"
    : "pending";
  return {
    source: "patient",
    requestId: patient.patientId,
    patientId: patient.patientId,
    hospitalId: patient.assignedHospitalId ?? patient.recommendedHospitalId,
    hospitalName: patient.assignedHospitalName ?? patient.recommendedHospitalName,
    status,
    insurance: patient.insuranceProvider,
    patientSummary: patient,
    etaMins: patient.etaMinutes,
    requestedAt: patient.updatedAt ?? patient.createdAt ?? new Date().toISOString(),
    acceptedAt: patient.acceptedAt ?? null,
    deliveredAt: patient.deliveredAt ?? null,
  };
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

function ElapsedTimer({ since }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (!since) return null;
  const ms = Date.now() - new Date(since).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return <span className="font-mono text-sm font-semibold text-amber-300">{mm}:{ss}</span>;
}

function HospitalView({ hospitalName, requests, onAccept, onDivert, onDelete }) {
  const [reportReq, setReportReq] = useState(null);
  return (
    <section className="grid min-h-0 grid-rows-[auto_1fr] gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950/70 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Incoming Patient Requests</h2>
          <p className="mt-1 text-sm text-slate-300">
            {hospitalName ? `${hospitalName} — ` : ""}EMT notifications routed to your hospital. Auto-approved when capacity is healthy.
          </p>
        </div>
      </div>
      <div className="min-h-0 overflow-auto">
        {requests.length === 0 ? (
          <div className="flex h-64 items-center justify-center rounded-xl border border-slate-700 bg-slate-950/70">
            <p className="text-base text-slate-400">No incoming requests for your hospital.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {requests.map((req) => (
              <div key={req.requestId} className="relative rounded-xl border border-slate-700 bg-slate-900/60 p-4">
                <button
                  type="button"
                  onClick={() => onDelete(req)}
                  className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-700 hover:text-slate-200"
                  title="Remove record"
                >
                  ×
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  {req.escalatedFrom && <span className="rounded-full border border-orange-400/30 bg-orange-400/10 px-2.5 py-1 text-xs font-semibold text-orange-200">Rerouted from {req.escalatedFrom}</span>}
                  {req.autoApproved && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">Auto-Approved</span>}
                  {req.status === "accepted" && !req.autoApproved && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">Accepted</span>}
                  {req.status === "diverted" && <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-200">Diverted{req.divertedTo ? ` → ${req.divertedTo}` : ""}</span>}
                  {req.status === "pending" && <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">Pending</span>}
                  {req.status === "delivered" && <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">Patient Arrived</span>}
                </div>
                <p className="mt-3 font-semibold text-slate-100">{req.hospitalName}</p>
                <div className="mt-2 space-y-1 text-sm text-slate-300">
                  <p>ETA: <span className="text-slate-100">{req.etaMins != null ? `${req.etaMins} min` : "--"}</span></p>
                  {req.insurance && <p>Insurance: <span className="text-slate-100">{req.insurance}</span></p>}
                  {(req.status === "accepted" || req.status === "delivered") && req.acceptedAt && (
                    <div className={`mt-2 flex items-center justify-between rounded-md border px-3 py-2 ${req.status === "delivered" ? "border-emerald-500/20 bg-emerald-500/10" : "border-amber-500/20 bg-amber-500/10"}`}>
                      <span className={`text-xs ${req.status === "delivered" ? "text-emerald-300" : "text-amber-300"}`}>{req.status === "delivered" ? "Total time" : "En route"}</span>
                      {req.status === "delivered"
                        ? <span className="font-mono text-sm font-semibold text-emerald-300">{(() => { const s = Math.max(0, Math.floor((new Date(req.deliveredAt) - new Date(req.acceptedAt)) / 1000)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; })()}</span>
                        : <ElapsedTimer since={req.acceptedAt} />
                      }
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setReportReq(req)}
                    className="mt-3 w-full rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
                  >
                    Patient Report
                  </button>
                  <p className="font-mono text-xs text-slate-500">{new Date(req.requestedAt).toLocaleTimeString()}</p>
                </div>
                {req.status === "pending" && (
                  <div className="mt-4 flex gap-2">
                    <button type="button" onClick={() => onAccept(req)} className="flex-1 rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/30">Accept</button>
                    <button type="button" onClick={() => onDivert(req)} className="flex-1 rounded-md bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/30">Divert</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {reportReq && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setReportReq(null)}
        >
          <div
            className="relative max-h-[85vh] w-full max-w-md overflow-auto rounded-2xl border border-slate-600 bg-slate-900 p-6 shadow-2xl shadow-black/60"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setReportReq(null)}
              className="absolute right-4 top-4 text-xl leading-none text-slate-400 hover:text-white"
            >
              ×
            </button>
            <p className="font-mono text-[10px] uppercase tracking-wide text-cyan-400">Patient Report</p>
            <p className="mt-0.5 text-base font-semibold text-slate-100">{reportReq.hospitalName}</p>
            <p className="mb-4 text-xs text-slate-400">{new Date(reportReq.requestedAt).toLocaleString()}</p>

            <div className="space-y-4 text-sm">
              {(reportReq.patientSummary?.name || reportReq.patientSummary?.age || reportReq.patientSummary?.sex) && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Patient</p>
                  {reportReq.patientSummary.name && <p className="font-semibold text-white">{reportReq.patientSummary.name}</p>}
                  {(reportReq.patientSummary.age || reportReq.patientSummary.sex) && (
                    <p className="text-slate-300">{[reportReq.patientSummary.age && `${reportReq.patientSummary.age}yo`, reportReq.patientSummary.sex].filter(Boolean).join(", ")}</p>
                  )}
                </div>
              )}
              {(reportReq.patientSummary?.chiefComplaint || reportReq.patientSummary?.condition) && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Chief Complaint</p>
                  <p className="text-slate-100">{reportReq.patientSummary.chiefComplaint ?? reportReq.patientSummary.condition?.toUpperCase()}</p>
                </div>
              )}
              {reportReq.patientSummary?.severity && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Severity</p>
                  <p className="text-slate-100">{reportReq.patientSummary.severity}</p>
                </div>
              )}
              {(reportReq.patientSummary?.bloodPressure || reportReq.patientSummary?.heartRate || reportReq.patientSummary?.oxygenSaturation || reportReq.patientSummary?.respiratoryRate) && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Vital Signs</p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-slate-100">
                    {reportReq.patientSummary.bloodPressure && <p>BP <span className="font-medium text-white">{reportReq.patientSummary.bloodPressure}</span></p>}
                    {reportReq.patientSummary.heartRate && <p>HR <span className="font-medium text-white">{reportReq.patientSummary.heartRate} bpm</span></p>}
                    {reportReq.patientSummary.oxygenSaturation && <p>SpO₂ <span className="font-medium text-white">{reportReq.patientSummary.oxygenSaturation}%</span></p>}
                    {reportReq.patientSummary.respiratoryRate && <p>RR <span className="font-medium text-white">{reportReq.patientSummary.respiratoryRate}/min</span></p>}
                  </div>
                </div>
              )}
              {reportReq.patientSummary?.summary && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Summary</p>
                  <p className="text-slate-100">{reportReq.patientSummary.summary}</p>
                </div>
              )}
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">ETA</p>
                <p className="text-slate-100">{reportReq.etaMins != null ? `${reportReq.etaMins} min` : "—"}</p>
              </div>
              {(reportReq.insurance || reportReq.patientSummary?.insuranceProvider) && (
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Insurance</p>
                  <p className="text-slate-100">{reportReq.insurance ?? reportReq.patientSummary.insuranceProvider}</p>
                </div>
              )}
              {!reportReq.patientSummary && (
                <p className="text-slate-400">No detailed patient information available for this request.</p>
              )}
              {reportReq.patientSummary?.transcript && (
                <div className="border-t border-slate-700 pt-3">
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Call Transcript</p>
                  <p className="text-xs italic leading-relaxed text-slate-400">"{reportReq.patientSummary.transcript}"</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
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


function statusBadgeColor(status) {
  switch (status) {
    case "Open": return "border border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "Saturation": return "border border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "Diversion": return "border border-red-500/30 bg-red-500/10 text-red-200";
    default: return "border border-slate-700 bg-slate-800 text-slate-300";
  }
}

function getNodeColor(utilization) {
  if (utilization >= 0.97) return "#ef4444";
  if (utilization >= 0.70) return "#f59e0b";
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
