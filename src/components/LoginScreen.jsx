import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.jsx";
import logo from "../assets/logo_nobkg.png";

const ROLE_PATH = { emt: "/emt", hospital: "/hospital", admin: "/?admin=true" };

const ROLE_OPTIONS = [
  { value: "emt", label: "EMT", desc: "Dispatch console" },
  { value: "hospital", label: "Hospital", desc: "Incoming patients" },
  { value: "admin", label: "Admin", desc: "Operations console" },
];

function currentPath() {
  return window.location.pathname.replace(/\/$/, "") + window.location.search;
}

function navigateToRoleHome(role) {
  const target = ROLE_PATH[role] ?? "/";
  if (currentPath() === target.replace(/\/$/, "")) return;
  window.location.assign(target);
}

export function LoginScreen({ pageRole }) {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState("signin");
  const [signupRole, setSignupRole] = useState(pageRole ?? "emt");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [hospitalId, setHospitalId] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [hospitalsList, setHospitalsList] = useState([]);
  const [loadingHospitals, setLoadingHospitals] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (mode !== "signup" || signupRole !== "hospital") return;
    setLoadingHospitals(true);
    apiFetch("/api/auth/hospitals-list")
      .then((r) => r.json())
      .then((data) => setHospitalsList(data.hospitals ?? []))
      .catch(() => setHospitalsList([]))
      .finally(() => setLoadingHospitals(false));
  }, [mode, signupRole]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (mode === "signin") {
        const user = await login(username, password);
        navigateToRoleHome(user.role);
      } else {
        const payload = {
          username,
          password,
          role: signupRole,
          displayName: displayName || null,
        };
        if (signupRole === "hospital") {
          if (!hospitalId) throw new Error("Please pick a hospital");
          payload.hospitalId = hospitalId;
        }
        if (signupRole === "admin" && adminToken) payload.adminToken = adminToken;
        const user = await signup(payload);
        navigateToRoleHome(user.role);
      }
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/80 p-8 shadow-2xl shadow-black/50">
        <div className="mb-6 flex items-center gap-3">
          <img src={logo} alt="Vital-Route" className="h-10 w-10" />
          <div>
            <h1 className="text-xl font-semibold text-slate-100">
              {mode === "signin" ? "Sign in" : "Create account"}
            </h1>
            <p className="text-xs text-slate-400">
              {mode === "signin"
                ? "Sign in with your username and password."
                : "Pick the role you'll be using."}
            </p>
          </div>
        </div>

        <div className="mb-5 inline-flex rounded-lg border border-slate-700 bg-slate-950 p-1 text-xs">
          <button
            type="button"
            onClick={() => { setMode("signin"); setError(""); }}
            className={`rounded-md px-3 py-1.5 font-semibold transition ${mode === "signin" ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400 hover:text-slate-200"}`}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => { setMode("signup"); setError(""); }}
            className={`rounded-md px-3 py-1.5 font-semibold transition ${mode === "signup" ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400 hover:text-slate-200"}`}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "signup" && (
            <Field label="Role">
              <div className="grid grid-cols-3 gap-2">
                {ROLE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSignupRole(opt.value)}
                    className={`rounded-lg border px-2 py-2 text-left text-xs transition ${
                      signupRole === opt.value
                        ? "border-cyan-400 bg-cyan-500/15 text-cyan-100"
                        : "border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    <p className="font-semibold">{opt.label}</p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field label="Username">
            <input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input"
              required
              minLength={3}
            />
          </Field>

          <Field label="Password">
            <input
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              required
              minLength={6}
            />
          </Field>

          {mode === "signup" && (
            <>
              <Field label="Display name (optional)">
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="input"
                />
              </Field>

              {signupRole === "hospital" && (
                <Field label="Your hospital">
                  <select
                    value={hospitalId}
                    onChange={(e) => setHospitalId(e.target.value)}
                    className="input"
                    required
                  >
                    <option value="">{loadingHospitals ? "Loading hospitals…" : "Select a hospital"}</option>
                    <option value="__all__">All Hospitals (Admin)</option>
                    {hospitalsList.map((h) => (
                      <option key={h.id} value={h.id}>{h.name}</option>
                    ))}
                  </select>
                </Field>
              )}

              {signupRole === "admin" && (
                <Field label="Admin signup token (if required)">
                  <input
                    type="password"
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value)}
                    className="input"
                  />
                </Field>
              )}
            </>
          )}

          {error && (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-60"
          >
            {submitting ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-center text-[10px] uppercase tracking-wider text-slate-500">
          After {mode === "signin" ? "sign-in" : "account creation"}, you'll be sent to the right console for your role.
        </p>
        <a
          href="/"
          className="mt-3 block text-center text-xs text-slate-400 hover:text-slate-200"
        >
          ← Back to home
        </a>
      </div>

      <style>{`
        .input {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgb(71 85 105);
          background-color: rgb(2 6 23);
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: rgb(241 245 249);
          outline: none;
        }
        .input:focus {
          border-color: rgb(34 211 238);
          box-shadow: 0 0 0 1px rgb(34 211 238);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}
