import { useAuth } from "../lib/auth.jsx";
import logo from "../assets/logo_nobkg.png";

const ROLE_LABEL = { emt: "EMT", hospital: "Hospital staff", admin: "Admin" };

const PAGE_PATH = { emt: "/emt", hospital: "/hospital", admin: "/?admin=true" };

export function RoleMismatchScreen({ current, needed }) {
  const { logout } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/80 p-8 shadow-2xl shadow-black/50">
        <div className="mb-6 flex items-center gap-3">
          <img src={logo} alt="Vital-Route" className="h-10 w-10" />
          <h1 className="text-xl font-semibold text-slate-100">Wrong page for your role</h1>
        </div>

        <p className="text-sm text-slate-300">
          You're signed in as <span className="font-semibold text-cyan-300">{ROLE_LABEL[current] ?? current}</span>,
          but this page is for <span className="font-semibold text-cyan-300">{ROLE_LABEL[needed] ?? needed}</span>.
        </p>

        <div className="mt-6 space-y-3">
          <a
            href={PAGE_PATH[current] ?? "/"}
            className="block w-full rounded-md bg-cyan-500 px-4 py-2.5 text-center text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
          >
            Go to your console
          </a>
          <button
            type="button"
            onClick={logout}
            className="w-full rounded-md border border-slate-600 bg-slate-950 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            Log out and switch
          </button>
          <a
            href="/"
            className="block text-center text-xs text-slate-400 hover:text-slate-200"
          >
            ← Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
