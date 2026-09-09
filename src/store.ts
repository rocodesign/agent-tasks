import { eq, ne, and, or, asc, desc, gte, lt, max, isNull, isNotNull, notInArray, inArray } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import { machines, sessions, tasks, dismissals } from "./db/schema.ts";
import { HISTORY_HIDDEN_KINDS, type SessionFilters } from "./session-filters.ts";
import { insertEvent, launchIdsForProject, purgeProjectEvents, systemEvent } from "./events.ts";
import { projectSlug } from "./knowledge.ts";
import { launchPromptKey } from "./launch.ts";
import { normalizeProvider, pickSessionMeta, sessionRelation, type SessionMeta } from "./session-metadata.ts";

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
  const provider = normalizeProvider(session.provider);
  const meta = pickSessionMeta(session, body);

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
      provider,
      status: normalizeSessionStatus(session.status),
      lastActivityAt: now,
      updatedAt: now,
      ...meta,
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
        ...(provider ? { provider } : {}),
        ...meta,
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

  // Snapshot replacement only touches the live TodoWrite mirror — post-session
  // generated tasks are managed by enrichSession and survive re-ingests.
  const ops: any[] = [db.delete(tasks).where(and(eq(tasks.sessionId, sessionId), ne(tasks.source, "generated")))];
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
        ...sessionRelation(s.id),
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

// Durable session history for the orchestrator: summarized sessions, newest first, with
// their generated follow-up tasks. `project` matches the normalized project_key first and
// falls back to the raw cwd of rows that predate it. Without an explicit `kind`, the
// automated kinds stay out of the answer.
export async function listHistorySessions(
  db: DB,
  email: string,
  params: SessionFilters & { since?: string | null; all?: boolean; limit?: number },
) {
  const conditions = [eq(sessions.accountEmail, email)];
  if (!params.all) conditions.push(isNotNull(sessions.summary));
  if (params.project) {
    conditions.push(
      or(eq(sessions.projectKey, params.project), and(isNull(sessions.projectKey), eq(sessions.project, params.project)))!,
    );
  }
  if (params.kind) {
    const kinds = params.kind.split(",").map((entry) => entry.trim()).filter(Boolean);
    conditions.push(kinds.length === 1 ? eq(sessions.kind, kinds[0]) : inArray(sessions.kind, kinds));
  }
  else conditions.push(or(isNull(sessions.kind), notInArray(sessions.kind, HISTORY_HIDDEN_KINDS))!);
  if (params.delegation) conditions.push(eq(sessions.delegation, params.delegation));
  if (params.machine) {
    conditions.push(
      inArray(
        sessions.machineId,
        db
          .select({ id: machines.id })
          .from(machines)
          .where(
            and(
              eq(machines.accountEmail, email),
              or(eq(machines.hostname, params.machine), eq(machines.id, `${email}::${params.machine}`)),
            ),
          ),
      ),
    );
  }
  if (params.since && !Number.isNaN(Date.parse(params.since))) {
    conditions.push(gte(sessions.lastActivityAt, new Date(params.since)));
  }

  const rows = await db
    .select()
    .from(sessions)
    .where(and(...conditions))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(Math.min(params.limit || 50, 500));
  if (!rows.length) return [];

  const ids = rows.map((row) => row.id);
  // D1 allows 100 bound variables per statement, and each id is one of them.
  const generated: (typeof tasks.$inferSelect)[] = [];
  for (let start = 0; start < ids.length; start += 80) {
    const batch = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.accountEmail, email), eq(tasks.source, "generated"), inArray(tasks.sessionId, ids.slice(start, start + 80))));
    generated.push(...batch);
  }
  const bySession = groupBy(generated, (task) => task.sessionId);
  return rows.map((row) => ({ ...row, generatedTasks: bySession.get(row.id) ?? [] }));
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

export async function completeTask(
  db: DB,
  email: string,
  sessionId: string,
  taskName: string,
): Promise<{ error?: string }> {
  const id = namespaced(email, sessionId);
  const owns = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.accountEmail, email)))
    .limit(1);
  if (!owns.length) return { error: "not_found" };
  const subject = await eventSubject(db, email, id);
  await db.batch([
    db
      .update(tasks)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(tasks.accountEmail, email), eq(tasks.sessionId, id), eq(tasks.name, taskName))),
    insertEvent(db, systemEvent(subject!, "task.completed", `A follow-up task was completed: ${taskName}`, keyOf(taskName))),
  ] as any);
  return {};
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

// `reason` records WHY the session ended so the dashboard can tell a clean hook exit
// from a timeout: "hook" (SessionEnd hook), "reaper" (timed out).
export async function endSession(
  db: DB,
  email: string,
  rawSessionId: string,
  reason: string = "hook",
): Promise<{ error?: string }> {
  const sessionId = `${email}::${rawSessionId}`;
  const subject = await eventSubject(db, email, sessionId);
  if (!subject) return {};
  await db.batch([
    db
      .update(sessions)
      .set({ status: "ended", endedReason: reason, updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.accountEmail, email))),
    insertEvent(db, systemEvent(subject, "session.ended", `The session ended (${reason}).`)),
  ] as any);
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
  await endSession(db, email, stripAccountPrefix(email, rows[0].id), reason);
  return { ended: rows[0].id };
}

// ---- maintenance (run from the scheduled cron, NOT per-request; account-wide) ----------
// A killed/headless process can't announce its own exit, so the SessionEnd hook may never
// fire. The reaper marks any session that's gone silent as ended, so the DB reflects reality
// instead of leaving it "active" forever. Set a touch past the UI's 30m stale mark so a
// merely-quiet session (mid-build, between task reports) isn't ended out from under itself.
const REAP_AFTER_MS = 45 * 60_000;
// Ended sessions are hidden from the tree after 5m; hard-delete the ones nothing ever
// summarized after 30 days so the table doesn't grow unbounded (FK cascade removes their
// tasks + dismissals).
const PURGE_ENDED_AFTER_MS = 30 * 24 * 60 * 60_000;

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
  // Summarized sessions are the durable session history the orchestrator reads. A row
  // with a transcript cursor but no summary means the summarizer ran and produced
  // nothing usable, so it is history too: one failed window must not erase it.
  const rows = await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.status, "ended"),
        lt(sessions.updatedAt, cutoff),
        isNull(sessions.summary),
        isNull(sessions.summarizedThrough),
      ),
    )
    .returning({ id: sessions.id });
  return { removed: rows.length };
}

// Early title from the first-prompt hook: fires while the session is still running,
// so a live card gets a real name within seconds of the opening message. Never
// outranks a digest — once enrichment has run, the transcript-derived title wins.

export type EventSubject = {
  id: string;
  accountEmail: string;
  project: string | null;
  projectKey: string | null;
  delegation: string | null;
  machineId: string | null;
};

async function eventSubject(db: DB, email: string, sessionId: string): Promise<EventSubject | null> {
  const rows = await db
    .select({
      id: sessions.id,
      accountEmail: sessions.accountEmail,
      project: sessions.project,
      projectKey: sessions.projectKey,
      delegation: sessions.delegation,
      machineId: sessions.machineId,
    })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountEmail, email)))
    .limit(1);
  return rows[0] ?? null;
}

// Short, stable discriminator so a repeated report is one event, not many.
function keyOf(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

export async function titleSession(
  db: DB,
  email: string,
  body: any,
): Promise<{ error?: string; titled?: string }> {
  const rawSessionId = String(body?.sessionId ?? "");
  const title = String(body?.title ?? "").slice(0, 300);
  if (!rawSessionId || !title) return { error: "sessionId and title required" };
  const sessionId = `${email}::${rawSessionId}`;

  const subject = await eventSubject(db, email, sessionId);
  if (!subject) return { error: "not_found" };
  const updated = await db
    .update(sessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountEmail, email), isNull(sessions.summarizedAt)))
    .returning({ id: sessions.id });
  if (!updated.length) return { error: "not_found" };
  await insertEvent(db, systemEvent(subject, "session.titled", title, keyOf(title)));
  return { titled: sessionId };
}

// Post-session enrichment from the summarizer hook: AI-generated title/summary plus
// follow-up tasks extracted from the transcript (source "generated", distinct from the
// live TodoWrite mirror). Update-only: the session row must already exist (SessionEnd
// flushes the archive queue before the summarizer runs).
export async function enrichSession(
  db: DB,
  email: string,
  body: any,
): Promise<{ error?: string; enriched?: string }> {
  const rawSessionId = String(body?.sessionId ?? "");
  if (!rawSessionId) return { error: "sessionId required" };
  const sessionId = `${email}::${rawSessionId}`;
  const now = new Date();

  const updated = await db
    .update(sessions)
    .set({
      summarizedAt: now,
      updatedAt: now,
      ...pickSessionMeta(body),
      ...(body?.summary ? { summary: String(body.summary).slice(0, 8000) } : {}),
      ...(body?.title ? { title: String(body.title).slice(0, 300) } : {}),
    })
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountEmail, email)))
    .returning({ id: sessions.id });
  if (!updated.length) return { error: "not_found" };

  if (Array.isArray(body?.tasks)) {
    const settled = await settledGeneratedTasks(db, sessionId);
    const rows = body.tasks
      .map((t: any, i: number) => {
        const name = String(t?.name ?? t?.content ?? "").slice(0, 2000);
        return {
          id: `${sessionId}::gen::${i}`,
          accountEmail: email,
          sessionId,
          name,
          // A follow-up the user already closed stays closed when the summarizer regenerates it.
          status: settled.get(name) ?? normalizeTaskStatus(t?.status),
          source: "generated",
          position: i,
          createdAt: now,
          updatedAt: now,
        };
      })
      .filter((row: any) => row.name);
    const ops: any[] = [db.delete(tasks).where(and(eq(tasks.sessionId, sessionId), eq(tasks.source, "generated")))];
    if (rows.length) ops.push(db.insert(tasks).values(rows));
    await db.batch(ops as any);
  }
  const subject = await eventSubject(db, email, sessionId);
  if (subject) {
    const digest = String(body?.summary ?? body?.title ?? "The session was summarized.");
    await insertEvent(db, systemEvent(subject, "session.summarized", digest, String(now.getTime())));
  }
  return { enriched: sessionId };
}

export async function settledGeneratedTasks(db: DB, sessionId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ name: tasks.name, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.sessionId, sessionId), eq(tasks.source, "generated")));
  return new Map(rows.filter((row) => row.status === "completed" || row.status === "deferred").map((row) => [row.name, row.status]));
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
    provider?: string | null;
    meta?: Partial<SessionMeta>;
  },
): Promise<{ machineId: string; sessionId: string }> {
  const now = new Date();
  const machineId = `${email}::${p.machineId}`;
  const sessionId = `${email}::${p.sessionId}`;
  const provider = normalizeProvider(p.provider);

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
      provider,
      status: "active",
      lastActivityAt: now,
      updatedAt: now,
      ...(p.meta ?? {}),
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
        ...(provider ? { provider } : {}),
        ...(p.meta ?? {}),
      },
    });

  const subject = await eventSubject(db, email, sessionId);
  if (subject) {
    await insertEvent(db, systemEvent(subject, "session.started", p.title || "A session started."));
  }
  return { machineId, sessionId };
}

// Permanently remove a session (and, via FK cascade, its tasks + dismissals).
// `fullSessionId` is the namespaced `${email}::${rawId}` as shown in the tree.
function stripAccountPrefix(email: string, id: string): string {
  return id.startsWith(`${email}::`) ? id.slice(email.length + 2) : id;
}

export async function removeSession(db: DB, email: string, fullSessionId: string): Promise<{ error?: string }> {
  await db.delete(sessions).where(and(eq(sessions.id, fullSessionId), eq(sessions.accountEmail, email)));
  return {};
}

// ---- helpers --------------------------------------------------------------
export function namespaced(email: string, sessionId: string): string {
  const prefix = `${email}::`;
  return sessionId.startsWith(prefix) ? sessionId : `${prefix}${sessionId}`;
}

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

// Dropping a project is irreversible by design: every session it produced, the follow-ups
// and dismissals hanging off them, its event stream, its knowledge documents and the
// prompts of the launches it recorded. The slug is derived from the cwd, so the rows are
// matched in memory rather than by a LIKE that would also catch a similarly named path.
export async function purgeProject(
  db: DB,
  bucket: R2Bucket,
  email: string,
  slug: string,
): Promise<{ slug: string; sessions: string[]; events: number; objects: number }> {
  const candidates = await db
    .select({ id: sessions.id, project: sessions.project, projectKey: sessions.projectKey })
    .from(sessions)
    .where(eq(sessions.accountEmail, email));
  const doomed = candidates.filter((row) => projectSlug(row.projectKey, row.project) === slug).map((row) => row.id);

  const launches = await launchIdsForProject(db, email, slug);
  const { removed } = await purgeProjectEvents(db, email, slug);

  for (const batch of chunk(doomed, 50)) {
    // D1 does not enforce the cascade, so the children go first: an orphaned task would
    // keep the follow-up visible in every brief.
    await db.delete(tasks).where(and(eq(tasks.accountEmail, email), inArray(tasks.sessionId, batch)));
    await db.delete(dismissals).where(and(eq(dismissals.accountEmail, email), inArray(dismissals.sessionId, batch)));
    await db.delete(sessions).where(and(eq(sessions.accountEmail, email), inArray(sessions.id, batch)));
  }

  let objects = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `sessions/${slug}/`, cursor });
    for (const object of page.objects) {
      await bucket.delete(object.key);
      objects += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  for (const launchId of launches) {
    await bucket.delete(launchPromptKey(launchId));
    objects += 1;
  }

  return { slug, sessions: doomed, events: removed, objects };
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
