import { and, asc, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import { events, sessions, type Event } from "./db/schema.ts";
import { ASSIGNMENT_TYPE, EXPIRY_TYPE } from "./events.ts";
import { projectSlug } from "./knowledge.ts";
import { namespaced } from "./store.ts";

export type LaunchState = "assigned" | "claimed" | "running" | "failed" | "cancelled" | "expired" | "done";
export type DelegationState = "open" | "done" | "failed" | "stale";

export const STALE_AFTER_MS = 24 * 3_600_000;
// The live states: only these can go stale, and only these keep a delegation open.
const LIVE_STATES: LaunchState[] = ["assigned", "claimed", "running"];

const EVIDENCE = new Map<string, LaunchState>([
  [ASSIGNMENT_TYPE, "assigned"],
  ["launch.claimed", "claimed"],
  ["launch.started", "running"],
  ["launch.failed", "failed"],
  ["launch.cancelled", "cancelled"],
  [EXPIRY_TYPE, "expired"],
]);
// The order is the precedence, not a list: a later entry outranks an earlier one, so a
// launch that started and then failed is failed. Do not reorder.
const PRECEDENCE: LaunchState[] = ["assigned", "claimed", "running", "failed", "cancelled", "expired", "done"];

export type OpenQuestion = { id: number; at: string | null; note: string };

export type LaunchView = {
  launchId: string;
  delegation: string | null;
  project: string | null;
  machine: string | null;
  state: LaunchState;
  stale: boolean;
  assignedAt: string | null;
  lastEventAt: string | null;
  lastEvent: { type: string; note: string } | null;
  reason: string | null;
  sessionId: string | null;
  openQuestions: OpenQuestion[];
};

export type DelegationView = {
  id: string;
  project: string | null;
  state: DelegationState;
  assignedAt: string | null;
  lastEventAt: string | null;
  openQuestions: number;
  launches: LaunchView[];
};

// A body is JSON from a machine and prose from a person. Both carry the same thing to a
// reader, so the note is whichever of the two the row turns out to hold.
export function noteOf(body: string): string {
  const trimmed = body?.trim() ?? "";
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return trimmed;
    for (const key of ["note", "reason", "state"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export function deriveLaunchState(types: string[], summarized: boolean): LaunchState {
  let rank = -1;
  let state: LaunchState = "assigned";
  for (const type of types) {
    const candidate = EVIDENCE.get(type);
    if (!candidate) continue;
    const candidateRank = PRECEDENCE.indexOf(candidate);
    if (candidateRank >= rank) {
      rank = candidateRank;
      state = candidate;
    }
  }
  return summarized && PRECEDENCE.indexOf("done") >= rank ? "done" : state;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function stripAccount(email: string, id: string): string {
  const prefix = `${email}::`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

// The deputy names the session on the event, the sidecar names it inside the body, and a
// launch is linked to its work through whichever of the two arrives.
function sessionRef(row: Event): string | null {
  if (row.sessionId) return row.sessionId;
  const trimmed = row.body?.trim() ?? "";
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const value = parsed?.sessionId ?? parsed?.session;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function buildLaunch(
  email: string,
  launchId: string,
  rows: Event[],
  answered: Set<number>,
  summarized: Set<string>,
  now = Date.now(),
): LaunchView {
  const assignment = rows.find((row) => row.type === ASSIGNMENT_TYPE) ?? null;
  const newest = rows[rows.length - 1] ?? null;
  const failure = [...rows].reverse().find((row) => row.type === "launch.failed") ?? null;
  const reference = [...rows].reverse().map(sessionRef).find(Boolean) ?? null;
  const sessionId = reference ? stripAccount(email, reference) : null;

  const state = deriveLaunchState(
    rows.map((row) => row.type),
    Boolean(sessionId && summarized.has(namespaced(email, sessionId))),
  );
  const lastEventAt = iso(newest?.createdAt);
  const age = lastEventAt ? now - Date.parse(lastEventAt) : 0;

  return {
    launchId,
    delegation: assignment?.delegation ?? rows.find((row) => row.delegation)?.delegation ?? null,
    project: assignment?.project ?? rows[0]?.project ?? null,
    machine: assignment?.recipient ?? assignment?.machineId ?? null,
    state,
    stale: LIVE_STATES.includes(state) && age > STALE_AFTER_MS,
    assignedAt: iso(assignment?.createdAt ?? rows[0]?.createdAt),
    lastEventAt,
    lastEvent: newest ? { type: newest.type, note: noteOf(newest.body) } : null,
    reason: failure ? noteOf(failure.body) : null,
    sessionId,
    openQuestions: rows
      .filter((row) => row.type === "question" && !answered.has(row.id))
      .map((row) => ({ id: row.id, at: iso(row.createdAt), note: noteOf(row.body) })),
  };
}

async function answeredQuestions(db: DB, email: string, questionIds: number[]): Promise<Set<number>> {
  const answered = new Set<number>();
  for (let start = 0; start < questionIds.length; start += 80) {
    const rows = await db
      .select({ replyTo: events.replyTo })
      .from(events)
      .where(
        and(
          eq(events.accountEmail, email),
          eq(events.type, "answer"),
          inArray(events.replyTo, questionIds.slice(start, start + 80)),
        ),
      );
    for (const row of rows) if (row.replyTo !== null) answered.add(row.replyTo);
  }
  return answered;
}

export async function readLaunch(db: DB, email: string, launchId: string): Promise<LaunchView | null> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.accountEmail, email), eq(events.launch, launchId)))
    .orderBy(asc(events.id));
  if (!rows.length) return null;

  const answered = await answeredQuestions(
    db,
    email,
    rows.filter((row) => row.type === "question").map((row) => row.id),
  );
  const reference = [...rows].reverse().map(sessionRef).find(Boolean) ?? null;
  const summarized = new Set<string>();
  if (reference) {
    const id = namespaced(email, stripAccount(email, reference));
    const [session] = await db
      .select({ id: sessions.id, summary: sessions.summary })
      .from(sessions)
      .where(and(eq(sessions.accountEmail, email), eq(sessions.id, id)))
      .limit(1);
    if (session?.summary) summarized.add(session.id);
  }
  return buildLaunch(email, launchId, rows, answered, summarized);
}

type DelegationParams = {
  state?: string | null;
  project?: string | null;
  // The projects this credential may read. Undefined or null is every project.
  projects?: string[] | null;
};

export async function listDelegations(db: DB, email: string, params: DelegationParams = {}): Promise<DelegationView[]> {
  const filters: SQL[] = [
    eq(events.accountEmail, email),
    or(isNotNull(events.delegation), isNotNull(events.launch)) as SQL,
  ];
  if (params.project) filters.push(eq(events.project, params.project));
  if (params.projects) {
    filters.push(
      params.projects.length === 1
        ? eq(events.project, params.projects[0])
        : (inArray(events.project, params.projects) as SQL),
    );
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...filters))
    .orderBy(asc(events.id));

  const answered = await answeredQuestions(
    db,
    email,
    rows.filter((row) => row.type === "question").map((row) => row.id),
  );
  const allSessions = await db
    .select({
      id: sessions.id,
      delegation: sessions.delegation,
      summary: sessions.summary,
      project: sessions.project,
      projectKey: sessions.projectKey,
      startedAt: sessions.startedAt,
      lastActivityAt: sessions.lastActivityAt,
    })
    .from(sessions)
    .where(and(eq(sessions.accountEmail, email), isNotNull(sessions.delegation)));
  // The scope names slugs, which no session column holds, so the narrowing happens here
  // rather than in the query above.
  const sessionRows = allSessions.filter((row) => {
    const slug = projectSlug(row.projectKey, row.project);
    if (params.project && slug !== params.project) return false;
    return !params.projects || params.projects.includes(slug);
  });
  const summarized = new Set(sessionRows.filter((row) => row.summary).map((row) => row.id));

  const byLaunch = new Map<string, Event[]>();
  for (const row of rows) {
    if (!row.launch) continue;
    const list = byLaunch.get(row.launch) ?? [];
    list.push(row);
    byLaunch.set(row.launch, list);
  }
  const now = Date.now();
  const launches = [...byLaunch].map(([id, list]) => buildLaunch(email, id, list, answered, summarized, now));
  const launchDelegation = new Map(launches.map((launch) => [launch.launchId, launch.delegation]));

  // A delegation is an address, not a row: it exists because something spoke to it.
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.delegation ?? (row.launch ? launchDelegation.get(row.launch) : null);
    if (name) names.add(name);
  }
  for (const row of sessionRows) if (row.delegation) names.add(row.delegation);

  const views = [...names].map((id) => {
    const mine = launches.filter((launch) => launch.delegation === id);
    const launchIds = new Set(mine.map((launch) => launch.launchId));
    const owned = rows.filter((row) => row.delegation === id || (row.launch && launchIds.has(row.launch)));
    const work = sessionRows.filter((row) => row.delegation === id);

    const times = [
      ...owned.map((row) => row.createdAt?.getTime() ?? 0),
      ...work.map((row) => row.lastActivityAt?.getTime() ?? 0),
    ].filter(Boolean);
    const starts = [
      ...owned.map((row) => row.createdAt?.getTime() ?? 0),
      ...work.map((row) => row.startedAt?.getTime() ?? 0),
    ].filter(Boolean);
    const lastEventAt = times.length ? Math.max(...times) : 0;

    const done = mine.some((launch) => launch.state === "done") || work.some((row) => Boolean(row.summary));
    const running = mine.some((launch) => launch.state === "running");
    const spent = mine.length > 0 && mine.every((launch) => ["failed", "expired", "cancelled"].includes(launch.state));
    let state: DelegationState = "open";
    if (done && !running) state = "done";
    else if (spent) state = "failed";
    else if (lastEventAt && now - lastEventAt > STALE_AFTER_MS) state = "stale";

    return {
      id,
      project: owned.find((row) => row.project)?.project ?? projectOf(work) ?? null,
      state,
      assignedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
      openQuestions: owned.filter((row) => row.type === "question" && !answered.has(row.id)).length,
      launches: mine.sort((a, b) => (a.assignedAt ?? "").localeCompare(b.assignedAt ?? "")),
    } satisfies DelegationView;
  });

  const open = (view: DelegationView) => view.state === "open" || view.state === "stale";
  const wanted = params.state === "all" ? views : views.filter(open);
  return wanted.sort((a, b) => rank(a) - rank(b) || (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
}

function projectOf(work: { project: string | null; projectKey: string | null }[]): string | null {
  const first = work.find((row) => row.project || row.projectKey);
  return first ? projectSlug(first.projectKey, first.project) : null;
}

function rank(view: DelegationView): number {
  if (view.state === "stale") return 0;
  if (view.state === "open") return 1;
  return 2;
}
