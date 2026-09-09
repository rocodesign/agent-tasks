import { and, asc, eq, gt, lt } from "drizzle-orm";
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

export const MAX_BODY = 2048;
export const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;

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

export async function listEvents(
  db: DB,
  email: string,
  params: { project: string; after?: number; limit?: number },
) {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.accountEmail, email), eq(events.project, params.project), gt(events.id, params.after ?? 0)))
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
      replyTo: row.replyTo,
      body: row.body,
      createdAt: row.createdAt?.toISOString() ?? null,
    })),
    // Only a delivered row may move the cursor; an empty page keeps the one it was given.
    nextAfter: page.length ? page[page.length - 1].id : (params.after ?? 0),
    hasMore: rows.length > limit,
  };
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
