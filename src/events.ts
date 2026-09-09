import { and, asc, eq, gt, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import { events } from "./db/schema.ts";
import { projectSlug } from "./knowledge.ts";

export const POST_TYPES = ["status", "question", "answer", "decision"] as const;
export const SYSTEM_TYPES = [
  "session.started",
  "session.titled",
  "session.ended",
  "session.summarized",
  "task.completed",
] as const;

// An assignment starts a process on another machine, so it is never posted through the
// generic route: it exists only where the prompt and the launch identity are checked.
export const ASSIGNMENT_TYPE = "delegation.assigned";
export const ASSIGNMENT_PRODUCER = "orchestrator";
// Only a key with the orchestrator role may publish these.
export const ORCHESTRATOR_TYPES = ["launch.cancelled"] as const;
export const DEPUTY_TYPES = ["launch.claimed", "launch.started", "launch.failed"] as const;

export const MAX_BODY = 2048;
export const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;
// Each recipient is one bound parameter and D1 allows 100 per query.
export const MAX_RECIPIENTS = 20;

export type EventInput = {
  accountEmail: string;
  project: string;
  type: string;
  producer: string;
  eventKey: string;
  sessionId?: string | null;
  delegation?: string | null;
  machineId?: string | null;
  recipient?: string | null;
  launch?: string | null;
  replyTo?: number | null;
  body: string;
};

export function eventRow(input: EventInput) {
  return {
    accountEmail: input.accountEmail,
    project: input.project || "unknown",
    type: input.type,
    producer: input.producer,
    eventKey: input.eventKey,
    sessionId: input.sessionId ?? null,
    delegation: input.delegation ?? null,
    machineId: input.machineId ?? null,
    recipient: input.recipient ?? null,
    launch: input.launch ?? null,
    replyTo: input.replyTo ?? null,
    body: input.body.slice(0, MAX_BODY),
    createdAt: new Date(),
  };
}

// Returned as a statement so a caller can commit it in the same batch as the state
// change it describes. A repeat of the same producer key is dropped, not duplicated.
export function insertEvent(db: DB, input: EventInput) {
  return db.insert(events).values(eventRow(input)).onConflictDoNothing();
}

export function systemEvent(
  session: { id: string; accountEmail: string; project?: string | null; projectKey?: string | null; delegation?: string | null; machineId?: string | null },
  type: (typeof SYSTEM_TYPES)[number],
  body: string,
  discriminator = "",
): EventInput {
  return {
    accountEmail: session.accountEmail,
    project: projectSlug(session.projectKey ?? null, session.project ?? null),
    type,
    producer: "fleet",
    eventKey: `${session.id}:${type}${discriminator ? `:${discriminator}` : ""}`,
    sessionId: session.id,
    delegation: session.delegation ?? null,
    machineId: session.machineId ?? null,
    body,
  };
}

export async function publishEvent(db: DB, input: EventInput): Promise<{ id: number; duplicate: boolean }> {
  const inserted = await db.insert(events).values(eventRow(input)).onConflictDoNothing().returning({ id: events.id });
  if (inserted[0]) return { id: inserted[0].id, duplicate: false };
  const existing = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.accountEmail, input.accountEmail), eq(events.producer, input.producer), eq(events.eventKey, input.eventKey)))
    .limit(1);
  if (!existing[0]) throw new Error("event insert reported a conflict but no row exists");
  return { id: existing[0].id, duplicate: true };
}

// A consumer names every address it answers to in one query: its launch, its session and
// its delegation. One cursor belongs to one address set. Adding an address later cannot
// recover that address's older rows, so a consumer that widens its set must replay from
// the boundary it saved and drop the ids it already delivered.
//
// A project filter and a recipient filter are refused together: a message addressed to a
// consumer may carry another project, and the combination would hide it while the cursor
// moved past it.
export async function listEvents(
  db: DB,
  email: string,
  params: { project?: string; recipients?: string[]; launches?: string[]; after?: number; limit?: number },
) {
  const recipients = [...new Set((params.recipients ?? []).map((value) => value.trim()).filter(Boolean))];
  const launches = [...new Set((params.launches ?? []).map((value) => value.trim()).filter(Boolean))];
  if (!params.project && !recipients.length) throw new Error("a project or a recipient is required");
  if (params.project && recipients.length) throw new Error("a recipient query cannot also filter by project");
  if (recipients.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} recipients`);
  if (launches.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} launches`);
  const filters: SQL[] = [eq(events.accountEmail, email), gt(events.id, params.after ?? 0)];
  if (params.project) filters.push(eq(events.project, params.project));
  if (recipients.length) {
    filters.push(
      recipients.length === 1 ? eq(events.recipient, recipients[0]) : (inArray(events.recipient, recipients) as SQL),
    );
  }
  // A row scoped to one launch is not for the launch that replaced it, even when both
  // answer to the same delegation address.
  if (launches.length) {
    filters.push(
      or(
        isNull(events.launch),
        launches.length === 1 ? eq(events.launch, launches[0]) : (inArray(events.launch, launches) as SQL),
      ) as SQL,
    );
  }
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const rows = await db
    .select()
    .from(events)
    .where(and(...filters))
    .orderBy(asc(events.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: page.map((row) => ({
      id: row.id,
      type: row.type,
      author: row.producer,
      sessionId: row.sessionId,
      delegation: row.delegation,
      machineId: row.machineId,
      recipient: row.recipient,
      launch: row.launch,
      replyTo: row.replyTo,
      body: row.body,
      createdAt: row.createdAt?.toISOString() ?? null,
    })),
    // Only a delivered row may move the cursor; an empty page keeps the one it was given.
    nextAfter: page.length ? page[page.length - 1].id : (params.after ?? 0),
    hasMore: rows.length > limit,
  };
}

// An assignment is unique per launch, not per producer key: the generic key includes the
// producer, so two producers could otherwise assign the same launch to two machines.
export async function findAssignment(db: DB, email: string, launch: string) {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.accountEmail, email), eq(events.launch, launch), eq(events.type, ASSIGNMENT_TYPE)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertAssignment(db: DB, input: EventInput): Promise<{ id: number; duplicate: boolean }> {
  const inserted = await db.insert(events).values(eventRow(input)).onConflictDoNothing().returning({ id: events.id });
  if (inserted[0]) return { id: inserted[0].id, duplicate: false };
  const existing = await findAssignment(db, input.accountEmail, input.launch ?? "");
  if (!existing) throw new Error("assignment insert reported a conflict but no assignment exists");
  return { id: existing.id, duplicate: true };
}

export async function purgeOldEvents(db: DB): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - EVENT_RETENTION_MS);
  const rows = await db.delete(events).where(lt(events.createdAt, cutoff)).returning({ id: events.id });
  return { removed: rows.length };
}

export async function purgeProjectEvents(db: DB, email: string, project: string): Promise<{ removed: number }> {
  const rows = await db
    .delete(events)
    .where(and(eq(events.accountEmail, email), eq(events.project, project)))
    .returning({ id: events.id });
  return { removed: rows.length };
}
