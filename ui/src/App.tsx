import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { groupSessions } from "./session-groups";

// ---- types (mirror /api/tree) --------------------------------------------
type Task = { id: string; name: string; status: string; position: number; updatedAt: string };
type SessionProvider = "claude" | "codex";
type Session = {
  id: string;
  machineId: string;
  name: string; // server-generated friendly name (e.g. "swift-otter")
  shortId: string; // raw session id without the account namespace
  project: string | null;
  title: string | null;
  provider: SessionProvider | null;
  isSubagent: boolean;
  parentSessionId: string | null;
  agentId: string | null;
  status: string;
  endedReason: string | null; // tool | hook | reaper once ended; null while live
  startedAt: string;
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

type SessionView = { session: Session; machine: Machine; eff: EffStatus };
type StackPlacement = { side: "below" | "left" | "right"; columns: 1 | 2 };
type SubagentStackControl = {
  activeCount: number;
  totalCount: number;
  expanded: boolean;
  panelId: string;
  onPress: () => void;
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
  const sessionGroups = useMemo(() => groupSessions(sessions), [sessions]);
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
              title="Copy your agent key (set it as AGENT_TASKS_KEY for the hook)"
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
              {sessionGroups.map(({ root, subagents }) => (
                <SessionStack
                  key={root.session.id}
                  root={root}
                  subagents={subagents}
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

function SessionStack({
  root,
  subagents,
  showMachine,
  onDismiss,
  onRemove,
}: {
  root: SessionView;
  subagents: SessionView[];
  showMachine: boolean;
  onDismiss: (sessionId: string, taskName: string) => void;
  onRemove: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [placement, setPlacement] = useState<StackPlacement>({ side: "right", columns: 1 });
  const panelId = useId();
  const stackRef = useRef<HTMLElement>(null);
  const activeSubagents = subagents.filter(({ eff }) => eff === "active" || eff === "idle");

  if (subagents.length === 0) {
    return (
      <SessionCard
        session={root.session}
        machine={root.machine}
        eff={root.eff}
        showMachine={showMachine}
        onDismiss={onDismiss}
        onRemove={onRemove}
      />
    );
  }

  const supportsHover = () => window.matchMedia("(hover: hover)").matches;
  const positionOverlay = () => {
    if (!supportsHover()) {
      setPlacement({ side: "right", columns: 1 });
      return;
    }

    const card = stackRef.current?.getBoundingClientRect();
    const viewport = stackRef.current?.closest("main")?.getBoundingClientRect();
    if (!card || !viewport) return;

    const gap = 14;
    const preferredColumns = activeSubagents.length > 1 ? 2 : 1;
    const leftSpace = card.left - viewport.left;
    const rightSpace = viewport.right - card.right;
    const preferredWidth = card.width * preferredColumns + gap * preferredColumns;
    const columns = preferredColumns === 2 && Math.max(leftSpace, rightSpace) < preferredWidth ? 1 : preferredColumns;
    const overlayWidth = card.width * columns + gap * columns;
    if (Math.max(leftSpace, rightSpace) < card.width + gap) {
      setPlacement({ side: "below", columns: 1 });
      return;
    }
    const side = rightSpace >= overlayWidth || rightSpace >= leftSpace ? "right" : "left";
    setPlacement({ side, columns });
  };
  const openOverlay = () => {
    if (activeSubagents.length === 0) return;
    positionOverlay();
    setExpanded(true);
  };
  const isExpanded = expanded && activeSubagents.length > 0;
  const stackControl: SubagentStackControl = {
    activeCount: activeSubagents.length,
    totalCount: subagents.length,
    expanded: isExpanded,
    panelId,
    onPress: () => {
      if (!supportsHover() && activeSubagents.length > 0) {
        if (!isExpanded) positionOverlay();
        setExpanded((current) => !current);
      }
    },
  };
  const color = machineColor(root.machine.id);
  const placementClass =
    placement.side === "right"
      ? "md:left-full md:right-auto md:top-0 md:pl-3.5 md:pr-0 md:pt-0"
      : placement.side === "left"
        ? "md:left-auto md:right-full md:top-0 md:pl-0 md:pr-3.5 md:pt-0"
        : "md:left-0 md:right-auto md:top-full md:pl-0 md:pr-0 md:pt-3";
  const widthClass =
    placement.side === "below"
      ? "md:w-full"
      : placement.columns === 2
        ? "md:w-[calc(200%+1.75rem)]"
        : "md:w-[calc(100%+0.875rem)]";
  const hiddenOffset =
    placement.side === "right"
      ? "md:-translate-x-3"
      : placement.side === "left"
        ? "md:translate-x-3"
        : "md:-translate-y-2";

  return (
    <section
      ref={stackRef}
      className={`relative ${isExpanded ? "z-40" : "z-0"}`}
      onMouseEnter={() => {
        if (supportsHover()) openOverlay();
      }}
      onMouseLeave={() => {
        if (supportsHover()) setExpanded(false);
      }}
      onFocus={() => {
        if (supportsHover()) openOverlay();
      }}
      onBlur={(event) => {
        if (supportsHover() && !event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false);
      }}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-2 top-1 h-full rounded-xl border bg-surface-card transition-all duration-200 motion-reduce:transition-none ${
          isExpanded ? "translate-y-0 opacity-0" : "translate-y-2 opacity-20"
        }`}
        style={{ borderColor: color }}
      />
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-4 top-1 h-full rounded-xl border bg-surface-card transition-all duration-200 motion-reduce:transition-none ${
          isExpanded ? "translate-y-0 opacity-0" : "translate-y-3.5 opacity-10"
        }`}
        style={{ borderColor: color }}
      />
      <div className="relative z-10">
        <SessionCard
          session={root.session}
          machine={root.machine}
          eff={root.eff}
          showMachine={showMachine}
          onDismiss={onDismiss}
          onRemove={onRemove}
          subagentStack={stackControl}
        />
      </div>
      {activeSubagents.length > 0 && (
        <div
          id={panelId}
          aria-hidden={!isExpanded}
          className={`absolute left-0 top-full z-30 w-full pt-3 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${placementClass} ${widthClass} ${
            isExpanded
              ? "visible translate-x-0 translate-y-0 opacity-100"
              : `invisible pointer-events-none -translate-y-2 opacity-0 md:translate-y-0 ${hiddenOffset}`
          }`}
        >
          <div className="max-h-[min(75vh,48rem)] overflow-y-auto rounded-2xl border border-edge-2 bg-surface/95 p-3 shadow-2xl backdrop-blur-md">
            <div className={`grid grid-cols-1 gap-3 ${placement.columns === 2 ? "md:grid-cols-2" : ""}`}>
              {activeSubagents.map(({ session, machine, eff }) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  machine={machine}
                  eff={eff}
                  showMachine={showMachine}
                  onDismiss={onDismiss}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
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
  subagentStack,
}: {
  session: Session;
  machine: Machine;
  showMachine: boolean;
  eff: EffStatus;
  onDismiss: (sessionId: string, taskName: string) => void;
  onRemove: (sessionId: string) => void;
  subagentStack?: SubagentStackControl;
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
      className="group flex flex-col gap-[13px] rounded-xl border bg-surface-card px-4 py-[15px]"
      style={{ borderColor: color }}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <ProviderIcon provider={session.provider} />
            <div className="truncate font-mono text-[13px]" style={{ color }} title={session.project ?? session.name}>
              {headline}
            </div>
            {session.isSubagent && (
              <span
                className="flex-none rounded border border-violet-400/20 bg-violet-400/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.06em] text-violet-300"
                title={subagentLabel(session)}
              >
                subagent
              </span>
            )}
            {subagentStack && subagentStack.activeCount > 0 && (
              <button
                type="button"
                aria-expanded={subagentStack.expanded}
                aria-controls={subagentStack.panelId}
                onClick={subagentStack.onPress}
                title={`${subagentStack.expanded ? "Hide" : "Show"} ${subagentStack.activeCount} active of ${
                  subagentStack.totalCount
                } subagents`}
                className="flex flex-none items-center gap-1 rounded border border-violet-400/20 bg-violet-400/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.05em] text-violet-300 transition-colors hover:border-violet-300/40 hover:bg-violet-400/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
              >
                <span>{subagentStack.activeCount}/{subagentStack.totalCount} active</span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 12 12"
                  className={`h-2.5 w-2.5 transition-transform duration-200 motion-reduce:transition-none ${
                    subagentStack.expanded ? "rotate-180" : ""
                  }`}
                >
                  <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            )}
            {subagentStack && subagentStack.activeCount === 0 && (
              <span
                title={`0 active of ${subagentStack.totalCount} subagents`}
                className="flex flex-none items-center rounded border border-violet-400/15 bg-violet-400/[0.06] px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.05em] text-violet-300/60"
              >
                0/{subagentStack.totalCount} active
              </span>
            )}
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

      <div className="flex items-center justify-between text-[11px] tabular-nums text-fg-8">
        <span>created {detailedTimeAgo(new Date(session.startedAt).getTime())}</span>
        <span>updated {timeAgo(new Date(session.lastActivityAt).getTime())}</span>
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

function ProviderIcon({ provider }: { provider: SessionProvider | null }) {
  if (!provider) return null;
  const label = provider === "codex" ? "Codex" : "Claude";
  return (
    <span
      className="flex h-4 w-4 flex-none items-center justify-center"
      title={label}
      aria-label={label}
      role="img"
    >
      {provider === "codex" ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-[#D97757]" aria-hidden="true">
          <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
        </svg>
      )}
    </span>
  );
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
        Install the hook plugin and set{" "}
        <span className="font-mono text-fg-5">AGENT_TASKS_KEY</span> to get started.
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

function detailedTimeAgo(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s ago`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ago`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h${minutes ? ` ${minutes}m` : ""} ago`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours ? ` ${hours}h` : ""} ago`;
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

function subagentLabel(session: Session): string {
  if (!session.parentSessionId) return "Subagent";
  const separator = session.parentSessionId.indexOf("::");
  const parent = separator >= 0 ? session.parentSessionId.slice(separator + 2) : session.parentSessionId;
  return `Subagent of ${parent}`;
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
