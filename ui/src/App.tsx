import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

// ---- types (mirror /api/tree) --------------------------------------------
type Task = { id: string; name: string; status: string; position: number; updatedAt: string };
type Session = {
  id: string;
  machineId: string;
  name: string; // server-generated friendly name (e.g. "swift-otter")
  shortId: string; // raw session id without the account namespace
  project: string | null;
  title: string | null;
  status: string;
  endedReason: string | null; // tool | hook | reaper once ended; null while live
  lastActivityAt: string;
  updatedAt: string;
  tasks: Task[];
};

type EffStatus = "active" | "idle" | "stale" | "ended";
type StatusFilter = "all" | "active" | "stale" | "ended";
type Machine = {
  id: string;
  hostname: string;
  os: string | null;
  label: string | null;
  lastSeen: string;
  sessions: Session[];
};

const KEY_STORAGE = "agent-tasks:apiKey";
const POLL_MS = 3000;
const STALE_MS = 30 * 60_000; // sessions idle >=30m are shown as STALE
const STALE_DROP_AFTER_MS = 3 * 60 * 60_000; // STALE sessions disappear 3h after going stale
const ENDED_DROP_MS = 5 * 60_000; // ended sessions disappear 5m after ending (mirrors the server)

// ---- root -----------------------------------------------------------------
export default function App() {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(KEY_STORAGE) ?? "");
  if (!apiKey) {
    return (
      <EmailLogin
        onAuthed={(k) => {
          localStorage.setItem(KEY_STORAGE, k);
          setApiKey(k);
        }}
      />
    );
  }
  return <Dashboard apiKey={apiKey} onSignOut={() => { localStorage.removeItem(KEY_STORAGE); setApiKey(""); }} />;
}

// ---- dashboard ------------------------------------------------------------
function Dashboard({ apiKey, onSignOut }: { apiKey: string; onSignOut: () => void }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // machineId | null = all
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const versionRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const headers = { Authorization: `Bearer ${apiKey}` };

    async function tick() {
      try {
        const vr = await fetch("/api/version", { headers });
        if (vr.status === 401) {
          if (active) setError("Unauthorized — wrong API key");
          return;
        }
        const { version } = await vr.json();
        if (version !== versionRef.current) {
          versionRef.current = version;
          const tr = await fetch("/api/tree", { headers });
          const data = await tr.json();
          if (active) setMachines(data.machines ?? []);
        }
        if (active) {
          setError(null);
          setUpdatedAt(Date.now());
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    }

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [apiKey]);

  const filtered = useMemo(() => filterMachines(machines, selected, query), [machines, selected, query]);
  // Recomputed every poll tick (updatedAt changes) so STALE/ENDED transitions are live.
  const flatSessions = useMemo(() => {
    const now = updatedAt ?? Date.now();
    return filtered
      .flatMap((m) => m.sessions.map((s) => ({ session: s, machine: m, eff: effectiveStatus(s, now) })))
      // Mirror the server's lifecycle client-side so cards leave on time: ENDED 5m after
      // ending, idle cards once they've been stale for 3h.
      .filter(({ session, eff }) =>
        eff === "ended"
          ? now - new Date(session.updatedAt).getTime() < ENDED_DROP_MS
          : now - new Date(session.lastActivityAt).getTime() < STALE_MS + STALE_DROP_AFTER_MS,
      );
  }, [filtered, updatedAt]);
  const sessions = useMemo(
    () =>
      flatSessions
        .filter(({ eff }) => matchFilter(statusFilter, eff))
        // active/idle first, then stale, then ended; ties broken by most-recent activity.
        .sort(
          (a, b) =>
            statusRank(a.eff) - statusRank(b.eff) ||
            new Date(b.session.lastActivityAt).getTime() - new Date(a.session.lastActivityAt).getTime(),
        ),
    [flatSessions, statusFilter],
  );
  const counts = useMemo(() => {
    const c = { all: flatSessions.length, active: 0, stale: 0, ended: 0 };
    for (const { eff } of flatSessions) {
      if (eff === "ended") c.ended++;
      else if (eff === "stale") c.stale++;
      else c.active++;
    }
    return c;
  }, [flatSessions]);
  const sidebar = useMemo(() => sidebarMachines(machines, query), [machines, query]);
  const totals = useMemo(() => summarize(machines, updatedAt ?? Date.now()), [machines, updatedAt]);
  const totalSessions = useMemo(() => machines.reduce((n, m) => n + m.sessions.length, 0), [machines]);

  const dismiss = useCallback(
    async (sessionId: string, taskName: string) => {
      try {
        await fetch("/api/dismiss", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ sessionId, taskName }),
        });
        versionRef.current = null; // force the next poll to refetch the tree
      } catch {
        /* the next poll will recover */
      }
    },
    [apiKey],
  );

  const remove = useCallback(
    async (sessionId: string) => {
      // Optimistically drop the card, then delete it server-side.
      setMachines((ms) => ms.map((m) => ({ ...m, sessions: m.sessions.filter((s) => s.id !== sessionId) })));
      versionRef.current = null; // force the next poll to refetch
      try {
        await fetch("/api/session/remove", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
      } catch {
        /* the next poll will recover */
      }
    },
    [apiKey],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface font-sans text-fg-2 antialiased">
      {/* top bar */}
      <header className="flex h-[54px] flex-none items-center justify-between gap-4 border-b border-edge-1 px-5">
        <div className="flex min-w-0 items-baseline gap-3.5">
          <span className="text-[15px] font-semibold tracking-[-0.02em] text-fg-1">Fleet</span>
          <span className="truncate text-[12.5px] text-fg-6">
            {totals.machines} machines · {totals.activeSessions} active sessions · {totals.inProgress} in progress
          </span>
        </div>
        <div className="flex flex-none items-center gap-4">
          {error ? (
            <span className="flex items-center gap-[7px] text-[12.5px] text-red-400">
              <span className="h-[7px] w-[7px] flex-none rounded-full bg-red-400" />
              {error}
            </span>
          ) : (
            <span className="flex items-center gap-2 text-[12.5px] tabular-nums text-fg-5">
              <span className="h-[7px] w-[7px] flex-none rounded-full bg-emerald-400 animate-live-dot" />
              live · {updatedAt ? timeAgo(updatedAt) : "…"}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(apiKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title="Copy your agent key (paste into the MCP server or skill config)"
              className="rounded-[7px] border border-edge-3 bg-transparent px-[11px] py-[5px] font-mono text-[11.5px] tracking-[0.02em] text-fg-4 hover:border-[#3a3a3a] hover:bg-surface-3 hover:text-fg-2"
            >
              {copied ? "copied ✓" : "agent key"}
            </button>
            <button
              onClick={onSignOut}
              className="rounded-[7px] border border-edge-3 bg-transparent px-[11px] py-[5px] font-mono text-[11.5px] tracking-[0.02em] text-fg-4 hover:border-[#3a3a3a] hover:bg-surface-3 hover:text-fg-2"
            >
              sign out
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* sidebar: machines */}
        <aside className="flex w-64 flex-none flex-col gap-[3px] overflow-y-auto border-r border-edge-1 px-3 py-3.5">
          <div className="mb-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search machines, projects, tasks…"
              className="w-full rounded-lg border border-edge-2 bg-surface-2 px-[11px] py-2 text-[12.5px] text-fg-2 outline-none focus:border-[#3a3a3a]"
            />
          </div>

          <button
            onClick={() => setSelected(null)}
            className={`flex w-full items-center gap-[9px] rounded-lg px-[9px] py-[7px] text-left ${
              selected === null ? "bg-edge-1 text-fg-1" : "text-fg-3 hover:bg-surface-2"
            }`}
          >
            <span className="h-2 w-2 flex-none rounded-sm bg-fg-8" />
            <span className="flex-1 text-[12.5px] font-medium">All machines</span>
            <span className="text-[11px] tabular-nums text-fg-6">{totalSessions}</span>
          </button>

          {sidebar.map((m) => {
            // Count live sessions (active/idle), not stale/ended ones — mirrors effectiveStatus
            // so the badge agrees with the card pills instead of the raw DB status.
            const now = updatedAt ?? Date.now();
            const active = m.sessions.filter((s) => {
              const e = effectiveStatus(s, now);
              return e === "active" || e === "idle";
            }).length;
            return (
              <button
                key={m.id}
                onClick={() => setSelected(m.id)}
                className={`flex w-full items-center gap-[9px] rounded-lg px-[9px] py-[7px] text-left ${
                  selected === m.id ? "bg-edge-1 text-fg-1" : "text-fg-3 hover:bg-surface-2"
                }`}
              >
                <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ backgroundColor: machineColor(m.id) }} />
                <span className="flex-1 truncate font-mono text-[12px]">{m.hostname}</span>
                {active > 0 && (
                  <span className="min-w-[18px] rounded-[5px] bg-emerald-400/10 px-1.5 py-px text-center text-[10.5px] font-semibold tabular-nums text-emerald-400">
                    {active}
                  </span>
                )}
              </button>
            );
          })}
          {sidebar.length === 0 && <div className="px-2 py-2.5 text-[12px] text-fg-8">No machines yet.</div>}
        </aside>

        {/* main: session cards */}
        <main className="flex-1 overflow-y-auto p-5">
          <div className="mb-3.5 flex items-center gap-1.5">
            {(["all", "active", "stale", "ended"] as StatusFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`flex items-center gap-1.5 rounded-[7px] px-[10px] py-[5px] text-[11.5px] font-medium ${
                  statusFilter === f ? "bg-edge-1 text-fg-1" : "text-fg-5 hover:bg-surface-2"
                }`}
              >
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                <span className="tabular-nums text-fg-6">{counts[f]}</span>
              </button>
            ))}
          </div>
          {sessions.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] content-start gap-3.5">
              {sessions.map(({ session, machine, eff }) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  machine={machine}
                  eff={eff}
                  showMachine={selected === null}
                  onDismiss={dismiss}
                  onRemove={remove}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---- session card ---------------------------------------------------------
function SessionCard({
  session,
  machine,
  showMachine,
  eff,
  onDismiss,
  onRemove,
}: {
  session: Session;
  machine: Machine;
  showMachine: boolean;
  eff: EffStatus;
  onDismiss: (sessionId: string, taskName: string) => void;
  onRemove: (sessionId: string) => void;
}) {
  const done = session.tasks.filter((t) => t.status === "completed").length;
  const proj = basename(session.project);
  // Uniform layout for every card so the fleet doesn't look inconsistent regardless of
  // which reporting path created the session: line 1 is always a human label (the agent-set
  // title, or the friendly session name when none was set — never the raw project path),
  // and line 2 is always the project dir (when known) + machine.
  const headline = session.title || session.name;
  const subParts: string[] = [];
  if (proj) subParts.push(proj);
  if (showMachine) subParts.push(machine.hostname);
  const subline = subParts.join("  ·  ");
  const removable = eff === "ended" || eff === "stale";
  const color = machineColor(machine.id);
  return (
    <div
      className="group flex flex-col gap-[13px] rounded-xl border bg-surface-card/50 px-4 py-[15px]"
      style={{ borderColor: color }}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px]" style={{ color }} title={session.project ?? session.name}>
            {headline}
          </div>
          {subline && <div className="mt-[3px] truncate font-mono text-[11px] text-fg-6">{subline}</div>}
        </div>
        <div className="flex flex-none items-center gap-[9px]">
          <span className="text-[11.5px] tabular-nums text-fg-6">
            {done}/{session.tasks.length}
          </span>
          <SessionPill status={eff} endedReason={session.endedReason} />
          {removable && (
            <button
              onClick={() => onRemove(session.id)}
              title="Remove this card now"
              className="flex-none text-[13px] leading-none text-fg-6 opacity-60 transition hover:text-red-400 hover:opacity-100"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        {session.tasks.map((t) => (
          <TaskRow key={t.id} task={t} sessionId={session.id} onDismiss={onDismiss} />
        ))}
        {session.tasks.length === 0 && <div className="px-2 py-1 text-[11px] text-fg-6">No tasks reported.</div>}
      </div>

      <div className="text-right text-[11px] tabular-nums text-fg-8">
        updated {timeAgo(new Date(session.lastActivityAt).getTime())}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  sessionId,
  onDismiss,
}: {
  task: Task;
  sessionId: string;
  onDismiss: (sessionId: string, taskName: string) => void;
}) {
  const inProgress = task.status === "in_progress";
  const deferred = task.status === "deferred";
  const canDismiss = task.status === "pending" || task.status === "in_progress";
  const nameClass =
    task.status === "completed" || task.status === "cancelled" || deferred
      ? "text-fg-7 line-through"
      : inProgress
        ? "font-medium text-fg-1"
        : "text-fg-4";
  return (
    <div
      className={`group flex items-center gap-[9px] rounded-md border-l-2 px-[9px] py-[5px] ${
        inProgress ? "border-violet-400 bg-violet-400/[0.08]" : "border-transparent"
      }`}
    >
      <TaskIcon status={task.status} />
      <span className={`flex-1 truncate font-mono text-[12.5px] ${nameClass}`}>{task.name}</span>
      {deferred && (
        <span className="flex-none rounded bg-amber-400/10 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em] text-amber-400">
          deferred
        </span>
      )}
      {canDismiss && (
        <button
          onClick={() => onDismiss(sessionId, task.name)}
          title="Defer / dismiss — tell the agent to drop this task"
          className="flex-none text-fg-6 opacity-0 transition hover:text-amber-400 group-hover:opacity-100"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ---- bits -----------------------------------------------------------------
function TaskIcon({ status }: { status: string }) {
  const base = "w-[14px] flex-none text-center text-[13px] leading-none";
  if (status === "completed") return <span className={`${base} text-emerald-400`}>✓</span>;
  if (status === "cancelled") return <span className={`${base} text-fg-6`}>✕</span>;
  if (status === "deferred") return <span className={`${base} text-amber-400/70`}>⊘</span>;
  if (status === "in_progress") return <span className={`${base} text-violet-400 animate-pulse-soft`}>◉</span>;
  return <span className={`${base} text-fg-6`}>◷</span>;
}

function SessionPill({ status, endedReason }: { status: EffStatus; endedReason?: string | null }) {
  const base = "flex-none rounded-[5px] px-[7px] py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em]";
  // A reaper-ended session timed out (no clean exit signal) — surface that distinctly so a
  // pile of "timed out" cards reads as "the end signal isn't reaching the server".
  const timedOut = status === "ended" && endedReason === "reaper";
  const key = timedOut ? "timed_out" : status;
  const label = timedOut ? "timed out" : status;
  const map: Record<string, string> = {
    active: "bg-emerald-400/10 text-emerald-400 border border-emerald-400/[0.18]",
    idle: "bg-amber-400/10 text-amber-400 border border-amber-400/[0.18]",
    stale: "bg-[rgba(140,140,140,0.10)] text-fg-3 border border-edge-3",
    ended: "bg-[rgba(140,140,140,0.08)] text-fg-5 border border-edge-3",
    timed_out: "bg-amber-400/[0.07] text-amber-400/80 border border-amber-400/[0.16]",
  };
  return <span className={`${base} ${map[key] ?? map.active}`}>{label}</span>;
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-fg-6">
      <div className="text-[15px] font-medium text-fg-4">No agents reporting yet</div>
      <div className="max-w-[360px] text-[12.5px] leading-[1.6]">
        Point an agent at <span className="font-mono text-fg-5">POST /api/ingest</span> — see{" "}
        <a href="/instructions" className="font-mono text-fg-5 underline hover:text-fg-2">
          /instructions
        </a>{" "}
        to get started.
      </div>
    </div>
  );
}

// ---- email login (email -> OTP -> minted API key) -------------------------
function EmailLogin({ onAuthed }: { onAuthed: (apiKey: string) => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function requestOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `error ${r.status}`);
      }
      setStep("code");
      setNotice("If that email is allowed, a 6-digit code is on its way.");
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.apiKey) throw new Error(d.error || `error ${r.status}`);
      onAuthed(d.apiKey);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }

  const fieldClass =
    "w-full rounded-[9px] border border-edge-2 bg-surface-1 px-3 py-2.5 text-fg-2 outline-none focus:border-[#3a3a3a]";

  return (
    <div className="flex h-screen items-center justify-center bg-surface p-6 font-sans text-fg-2 antialiased">
      <form
        onSubmit={step === "email" ? requestOtp : verify}
        className="flex w-[348px] max-w-full flex-col gap-4 rounded-[14px] border border-edge-2 bg-surface-card/60 p-[30px]"
      >
        <div className="text-[19px] font-semibold tracking-[-0.02em] text-fg-1">
          {step === "email" ? "Fleet" : "Check your email"}
        </div>
        <p className="text-[13px] leading-[1.55] text-fg-4">
          {step === "email" ? (
            "Sign in with your email — we'll send a one-time code. Your agent key is minted on this device and never baked into the build."
          ) : (
            <>
              Enter the 6-digit code sent to <span className="font-mono text-fg-2">{email.trim()}</span>.
            </>
          )}
        </p>
        {step === "email" ? (
          <input
            autoFocus
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={`${fieldClass} font-mono text-[13px] tracking-[0.02em]`}
          />
        ) : (
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="000000"
            className={`${fieldClass} text-center font-mono text-[18px] tracking-[0.5em]`}
          />
        )}
        {error ? (
          <div className="text-[12px] text-red-400">{error}</div>
        ) : (
          notice && <div className="text-[12px] text-fg-6">{notice}</div>
        )}
        <button
          type="submit"
          disabled={busy}
          className="mt-0.5 rounded-[9px] bg-violet-400 px-3.5 py-2.5 text-[13px] font-semibold text-surface hover:bg-violet-300 disabled:opacity-60"
        >
          {busy ? "…" : step === "email" ? "Send code" : "Verify & sign in"}
        </button>
        {step === "code" && (
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
              setNotice(null);
            }}
            className="text-[12px] text-fg-5 underline-offset-2 hover:text-fg-2 hover:underline"
          >
            Use a different email
          </button>
        )}
      </form>
    </div>
  );
}

// ---- pure helpers ---------------------------------------------------------
function filterMachines(machines: Machine[], selected: string | null, query: string): Machine[] {
  const q = query.trim().toLowerCase();
  return machines
    .filter((m) => (selected ? m.id === selected : true))
    .map((m) => {
      if (!q) return m;
      const sessions = m.sessions.filter(
        (s) =>
          (s.project ?? "").toLowerCase().includes(q) ||
          (s.title ?? "").toLowerCase().includes(q) ||
          m.hostname.toLowerCase().includes(q) ||
          s.tasks.some((t) => t.name.toLowerCase().includes(q)),
      );
      return { ...m, sessions };
    })
    .filter((m) => m.sessions.length > 0 || !q);
}

function sidebarMachines(machines: Machine[], query: string): Machine[] {
  const q = query.trim().toLowerCase();
  if (!q) return machines;
  return machines.filter(
    (m) =>
      m.hostname.toLowerCase().includes(q) ||
      m.sessions.some(
        (s) =>
          (s.project ?? "").toLowerCase().includes(q) ||
          (s.title ?? "").toLowerCase().includes(q) ||
          s.tasks.some((t) => t.name.toLowerCase().includes(q)),
      ),
  );
}

function summarize(machines: Machine[], now: number) {
  let activeSessions = 0;
  let inProgress = 0;
  for (const m of machines) {
    for (const s of m.sessions) {
      const eff = effectiveStatus(s, now);
      if (eff === "active" || eff === "idle") activeSessions++;
      inProgress += s.tasks.filter((t) => t.status === "in_progress").length;
    }
  }
  return { machines: machines.length, activeSessions, inProgress };
}

function timeAgo(ms: number): string {
  // Floor (not round) so "2h ago" never shows before a full 2h — keeps it consistent
  // with the STALE threshold (a card reads "2h ago" exactly when it turns stale).
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// Effective status: a session goes STALE after 2h of no activity, unless already ended.
function effectiveStatus(s: Session, now: number): EffStatus {
  if (s.status === "ended") return "ended";
  if (now - new Date(s.lastActivityAt).getTime() >= STALE_MS) return "stale";
  return s.status === "idle" ? "idle" : "active";
}

function statusRank(eff: EffStatus): number {
  return eff === "ended" ? 2 : eff === "stale" ? 1 : 0;
}

function matchFilter(filter: StatusFilter, eff: EffStatus): boolean {
  if (filter === "all") return true;
  if (filter === "active") return eff === "active" || eff === "idle";
  return eff === filter;
}

// Last path segment of a project path (handles both / and \ separators).
function basename(p: string | null): string | null {
  if (!p) return null;
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

// Deterministic, dark-theme-friendly color per machine (stable from its id). High enough
// lightness to stay legible on the dark surface; full hue spread so machines are distinct.
function machineColor(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `hsl(${h % 360} 62% 67%)`;
}
