import { eq, ne, and, asc, desc, lt, max, isNull, inArray } from "drizzle-orm";
import type { DB } from "./db/client";
import { machines, sessions, tasks, dismissals } from "./db/schema";

// All data access is account-scoped (multi-tenant). `email` is the authenticated
// account; machine/session ids are namespaced as `${email}::${rawId}`.

export type IngestResult =
  | { error: string }
  | { result: { tasks: number; dismissed: string[]; machineId: string; sessionId: string } };

export async function ingestSnapshot(db: DB, email: string, body: any): Promise<IngestResult> {
  const machine = body?.machine;
  const session = body?.session;
  const taskList: any[] = Array.isArray(body?.tasks) ? body.tasks : [];
  if (!machine?.id || !machine?.hostname || !session?.id) {
    return { error: "machine.id, machine.hostname and session.id are required" };
  }

  const now = new Date();
  const machineId = `${email}::${machine.id}`;
  const sessionId = `${email}::${session.id}`;

  await db
    .insert(machines)
    .values({
      id: machineId,
      accountEmail: email,
      hostname: machine.hostname,
      os: machine.os ?? null,
      label: machine.label ?? null,
      lastSeen: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: machines.id,
      set: { hostname: machine.hostname, os: machine.os ?? null, label: machine.label ?? null, lastSeen: now, updatedAt: now },
    });

  await db
    .insert(sessions)
    .values({
      id: sessionId,
      accountEmail: email,
      machineId,
      project: session.project ?? null,
      title: session.title ?? null,
      status: normalizeSessionStatus(session.status),
      lastActivityAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        machineId,
        status: normalizeSessionStatus(session.status),
        // Fresh activity revives the session — clear any prior end reason (e.g. a reaped
        // session that started reporting again).
        endedReason: null,
        lastActivityAt: now,
        updatedAt: now,
        // Preserve project/title (e.g. set by the SessionStart hook) unless the caller
        // explicitly provides new values — agents reporting tasks needn't resend them.
        ...(session.project ? { project: session.project } : {}),
        ...(session.title ? { title: session.title } : {}),
      },
    });

  // User dismissals persist across re-ingests.
  const dismissalRows = await db
    .select({ taskName: dismissals.taskName })
    .from(dismissals)
    .where(and(eq(dismissals.sessionId, sessionId), isNull(dismissals.acknowledgedAt)));
  const dismissedNames = new Set(dismissalRows.map((d) => d.taskName));

  const rows = taskList.map((t, i) => {
    const name = String(t?.name ?? t?.content ?? "").slice(0, 2000);
    const status = dismissedNames.has(name) ? "deferred" : normalizeTaskStatus(t?.status);
    return { id: `${sessionId}::${i}`, accountEmail: email, sessionId, name, status, position: i, createdAt: now, updatedAt: now };
  });

  const ops: any[] = [db.delete(tasks).where(eq(tasks.sessionId, sessionId))];
  if (rows.length) ops.push(db.insert(tasks).values(rows));
  await db.batch(ops as any);

  const submittedActive = new Set(
    taskList
      .map((t) => ({ name: String(t?.name ?? t?.content ?? "").slice(0, 2000), status: normalizeTaskStatus(t?.status) }))
      .filter((t) => t.status === "pending" || t.status === "in_progress")
      .map((t) => t.name),
  );
  const stillActive = [...dismissedNames].filter((n) => submittedActive.has(n));
  const complied = [...dismissedNames].filter((n) => !submittedActive.has(n));
  if (complied.length) {
    await db
      .update(dismissals)
      .set({ acknowledgedAt: now })
      .where(and(eq(dismissals.sessionId, sessionId), inArray(dismissals.taskName, complied)));
  }

  return { result: { tasks: rows.length, dismissed: stillActive, machineId, sessionId } };
}

// Card lifecycle: ENDED cards drop 5 min after ending; a session goes STALE after 30 min
// idle and is removed 3h after it became stale.
const ENDED_TTL_MS = 5 * 60_000;
const STALE_AFTER_MS = 30 * 60_000;
const STALE_DROP_AFTER_MS = 3 * 60 * 60_000;

export async function buildTree(db: DB, email: string) {
  const [machineRows, sessionRows, taskRows] = await Promise.all([
    db.select().from(machines).where(eq(machines.accountEmail, email)).orderBy(asc(machines.hostname)),
    db.select().from(sessions).where(eq(sessions.accountEmail, email)).orderBy(desc(sessions.lastActivityAt)),
    db.select().from(tasks).where(eq(tasks.accountEmail, email)).orderBy(asc(tasks.position)),
  ]);

  const tasksBySession = groupBy(taskRows, (t) => t.sessionId);
  const sessionsByMachine = groupBy(sessionRows, (s) => s.machineId);
  const now = Date.now();
  const endedCutoff = now - ENDED_TTL_MS;
  const staleDropMs = STALE_AFTER_MS + STALE_DROP_AFTER_MS;

  return machineRows.map((m) => ({
    ...m,
    sessions: (sessionsByMachine.get(m.id) ?? [])
      // Drop ENDED cards 5 min after they ended, and idle cards once they've been stale 3h.
      .filter((s) =>
        s.status === "ended"
          ? new Date(s.updatedAt).getTime() >= endedCutoff
          : now - new Date(s.lastActivityAt).getTime() < staleDropMs,
      )
      .map((s) => ({
        ...s,
        // A friendly, stable name + the raw (un-namespaced) id for reference.
        name: sessionName(stripAccount(email, s.id)),
        shortId: stripAccount(email, s.id),
        tasks: tasksBySession.get(s.id) ?? [],
      }))
      // Active/idle first; ended sinks to the bottom; otherwise most-recent first.
      .sort(
        (a, b) =>
          rankStatus(a.status) - rankStatus(b.status) ||
          new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
      ),
  }));
}

export async function computeVersion(db: DB, email: string): Promise<number> {
  const [[m], [s], [t]] = await Promise.all([
    db.select({ v: max(machines.updatedAt) }).from(machines).where(eq(machines.accountEmail, email)),
    db.select({ v: max(sessions.updatedAt) }).from(sessions).where(eq(sessions.accountEmail, email)),
    db.select({ v: max(tasks.updatedAt) }).from(tasks).where(eq(tasks.accountEmail, email)),
  ]);
  return [m?.v, s?.v, t?.v]
    .filter(Boolean)
    .map((d) => new Date(d as any).getTime())
    .reduce((a, b) => Math.max(a, b), 0);
}

export async function listDismissals(db: DB, email: string, sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ taskName: dismissals.taskName })
    .from(dismissals)
    .where(and(eq(dismissals.accountEmail, email), eq(dismissals.sessionId, sessionId), isNull(dismissals.acknowledgedAt)));
  return rows.map((r) => r.taskName);
}

export async function dismissTask(
  db: DB,
  email: string,
  sessionId: string,
  taskName: string,
): Promise<{ error?: string }> {
  // Ownership check: the session must belong to this account.
  const owns = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountEmail, email)))
    .limit(1);
  if (!owns.length) return { error: "not_found" };

  const now = new Date();
  await db
    .insert(dismissals)
    .values({ sessionId, taskName, accountEmail: email, createdAt: now, acknowledgedAt: null })
    .onConflictDoUpdate({
      target: [dismissals.sessionId, dismissals.taskName],
      set: { createdAt: now, acknowledgedAt: null, accountEmail: email },
    });
  await db
    .update(tasks)
    .set({ status: "deferred", updatedAt: now })
    .where(and(eq(tasks.accountEmail, email), eq(tasks.sessionId, sessionId), eq(tasks.name, taskName)));
  return {};
}

// `reason` records WHY the session ended so the dashboard can tell a clean exit from a
// timeout: "tool" (model called end_session), "hook" (SessionEnd hook), "reaper" (timed out).
export async function endSession(
  db: DB,
  email: string,
  rawSessionId: string,
  reason: string = "tool",
): Promise<{ error?: string }> {
  const sessionId = `${email}::${rawSessionId}`;
  await db
    .update(sessions)
    .set({ status: "ended", endedReason: reason, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountEmail, email)));
  return {};
}

// End the most-recently-active (non-ended) session on a machine — used by the SessionEnd
// hook, which knows the machine (hostname) but not the server-assigned session id.
export async function endLatestSession(
  db: DB,
  email: string,
  rawMachineId: string,
  reason: string = "hook",
): Promise<{ ended: string | null }> {
  const machineId = `${email}::${rawMachineId}`;
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.accountEmail, email), eq(sessions.machineId, machineId), ne(sessions.status, "ended")))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(1);
  if (!rows.length) return { ended: null };
  await db
    .update(sessions)
    .set({ status: "ended", endedReason: reason, updatedAt: new Date() })
    .where(eq(sessions.id, rows[0].id));
  return { ended: rows[0].id };
}

// ---- maintenance (run from the scheduled cron, NOT per-request; account-wide) ----------
// A killed/headless process can't announce its own exit, so the SessionEnd hook may never
// fire. The reaper marks any session that's gone silent as ended, so the DB reflects reality
// instead of leaving it "active" forever. Set a touch past the UI's 30m stale mark so a
// merely-quiet session (mid-build, between task reports) isn't ended out from under itself.
const REAP_AFTER_MS = 45 * 60_000;
// Ended sessions are hidden from the tree after 5m; hard-delete them after a week so the
// table doesn't grow unbounded (FK cascade removes their tasks + dismissals).
const PURGE_ENDED_AFTER_MS = 7 * 24 * 60 * 60_000;

export async function reapStaleSessions(db: DB): Promise<{ ended: number }> {
  const cutoff = new Date(Date.now() - REAP_AFTER_MS);
  const rows = await db
    .update(sessions)
    .set({ status: "ended", endedReason: "reaper", updatedAt: new Date() })
    .where(and(ne(sessions.status, "ended"), lt(sessions.lastActivityAt, cutoff)))
    .returning({ id: sessions.id });
  return { ended: rows.length };
}

export async function purgeOldEndedSessions(db: DB): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - PURGE_ENDED_AFTER_MS);
  const rows = await db
    .delete(sessions)
    .where(and(eq(sessions.status, "ended"), lt(sessions.updatedAt, cutoff)))
    .returning({ id: sessions.id });
  return { removed: rows.length };
}

// Raw (un-namespaced) id of the most-recently-active, non-ended session on a machine,
// or null. Lets the hosted MCP attach tasks to the session the SessionStart hook created
// (the MCP never learns the Claude session id, but it knows the machine).
export async function latestActiveRawSession(
  db: DB,
  email: string,
  rawMachineId: string,
): Promise<string | null> {
  const machineId = `${email}::${rawMachineId}`;
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.accountEmail, email), eq(sessions.machineId, machineId), ne(sessions.status, "ended")))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(1);
  return rows.length ? stripAccount(email, rows[0].id) : null;
}

// Set a session's display name (title). Agents call this to label what they're working on.
export async function setSessionTitle(
  db: DB,
  email: string,
  rawSessionId: string,
  title: string,
): Promise<{ error?: string }> {
  const sessionId = `${email}::${rawSessionId}`;
  await db
    .update(sessions)
    .set({ title: title.slice(0, 200), updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountEmail, email)));
  return {};
}

// Register (or re-activate) a session with NO tasks, so it appears on the dashboard the
// moment a Claude session starts — before any task is reported. Idempotent.
export async function startSession(
  db: DB,
  email: string,
  p: {
    machineId: string;
    hostname: string;
    os?: string | null;
    label?: string | null;
    sessionId: string;
    project?: string | null;
    title?: string | null;
  },
): Promise<{ machineId: string; sessionId: string }> {
  const now = new Date();
  const machineId = `${email}::${p.machineId}`;
  const sessionId = `${email}::${p.sessionId}`;

  await db
    .insert(machines)
    .values({
      id: machineId,
      accountEmail: email,
      hostname: p.hostname,
      os: p.os ?? null,
      label: p.label ?? null,
      lastSeen: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: machines.id,
      set: { hostname: p.hostname, os: p.os ?? null, label: p.label ?? null, lastSeen: now, updatedAt: now },
    });

  await db
    .insert(sessions)
    .values({
      id: sessionId,
      accountEmail: email,
      machineId,
      project: p.project ?? null,
      title: p.title ?? null,
      status: "active",
      lastActivityAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        machineId,
        status: "active",
        endedReason: null,
        lastActivityAt: now,
        updatedAt: now,
        // Only overwrite project/title when the caller supplies them.
        ...(p.project ? { project: p.project } : {}),
        ...(p.title ? { title: p.title } : {}),
      },
    });

  return { machineId, sessionId };
}

// Permanently remove a session (and, via FK cascade, its tasks + dismissals).
// `fullSessionId` is the namespaced `${email}::${rawId}` as shown in the tree.
export async function removeSession(db: DB, email: string, fullSessionId: string): Promise<{ error?: string }> {
  await db.delete(sessions).where(and(eq(sessions.id, fullSessionId), eq(sessions.accountEmail, email)));
  return {};
}

// ---- single-session task views (used by the session-bound MCP) ------------

// Only this session's tasks (rawSessionId is namespaced to the account here).
export async function listSessionTasks(db: DB, email: string, rawSessionId: string) {
  const sessionId = `${email}::${rawSessionId}`;
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.accountEmail, email), eq(tasks.sessionId, sessionId)))
    .orderBy(asc(tasks.position));
  return rows.map((r) => ({ name: r.name, status: r.status, position: r.position }));
}

// Update one task's status in this session. A user dismissal still wins.
export async function updateTaskStatus(
  db: DB,
  email: string,
  rawSessionId: string,
  taskName: string,
  status: unknown,
): Promise<{ error?: string; status?: string; deferred?: boolean }> {
  const sessionId = `${email}::${rawSessionId}`;
  const existing = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.accountEmail, email), eq(tasks.sessionId, sessionId), eq(tasks.name, taskName)))
    .limit(1);
  if (!existing.length) return { error: "task_not_found" };

  const dis = await db
    .select({ n: dismissals.taskName })
    .from(dismissals)
    .where(and(eq(dismissals.sessionId, sessionId), eq(dismissals.taskName, taskName), isNull(dismissals.acknowledgedAt)))
    .limit(1);
  const deferred = dis.length > 0;
  const finalStatus = deferred ? "deferred" : normalizeTaskStatus(status);

  const now = new Date();
  await db
    .update(tasks)
    .set({ status: finalStatus, updatedAt: now })
    .where(and(eq(tasks.accountEmail, email), eq(tasks.sessionId, sessionId), eq(tasks.name, taskName)));
  await db
    .update(sessions)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(and(eq(sessions.accountEmail, email), eq(sessions.id, sessionId)));
  return { status: finalStatus, deferred };
}

// ---- helpers --------------------------------------------------------------
export function groupBy<T, K>(arr: T[], keyFn: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = keyFn(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function normalizeTaskStatus(s: unknown): string {
  if (typeof s === "number") {
    const map = ["pending", "in_progress", "completed", "cancelled"];
    return map[s] ?? "pending";
  }
  const v = String(s ?? "").toLowerCase();
  if (["in_progress", "in-progress", "active", "doing"].includes(v)) return "in_progress";
  if (["completed", "complete", "done"].includes(v)) return "completed";
  if (["cancelled", "canceled", "skipped"].includes(v)) return "cancelled";
  if (["deferred", "dropped", "dismissed"].includes(v)) return "deferred";
  return "pending";
}

export function normalizeSessionStatus(s: unknown): string {
  const v = String(s ?? "").toLowerCase();
  if (["idle"].includes(v)) return "idle";
  if (["ended", "done", "closed"].includes(v)) return "ended";
  return "active";
}

// ---- session display name (deterministic from the session id) -------------
const SESSION_ADJ = [
  "amber", "brisk", "calm", "clever", "cobalt", "crimson", "dusky", "eager", "fleet", "gentle",
  "ivory", "jade", "keen", "lively", "mellow", "noble", "opal", "plucky", "quiet", "rapid",
  "sage", "swift", "teal", "umber", "vivid", "witty", "zesty", "bright", "bold", "lunar",
];
const SESSION_NOUN = [
  "otter", "falcon", "cedar", "comet", "delta", "ember", "fjord", "grove", "harbor", "ibis",
  "jasper", "kestrel", "lynx", "meadow", "nimbus", "onyx", "pinion", "quartz", "raven", "summit",
  "tundra", "vertex", "willow", "yarrow", "zephyr", "badger", "cove", "drift", "heron", "maple",
];

// Strip the `${email}::` namespace from a stored id, leaving the raw session/machine id.
function stripAccount(email: string, id: string): string {
  const prefix = `${email}::`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

// Stable, friendly two-word name derived from any session id (FNV-1a hash).
export function sessionName(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const adj = SESSION_ADJ[h % SESSION_ADJ.length];
  const noun = SESSION_NOUN[Math.floor(h / SESSION_ADJ.length) % SESSION_NOUN.length];
  return `${adj}-${noun}`;
}

function rankStatus(status: string): number {
  return status === "ended" ? 1 : 0;
}
