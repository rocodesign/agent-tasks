import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { accounts, events } from "../src/db/schema.ts";
import { listEvents, publishEvent, purgeOldEvents, purgeProjectEvents } from "../src/events.ts";
import { completeTask, endSession, enrichSession, startSession, titleSession } from "../src/store.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";

async function seeded(t: any) {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });
  return harness;
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    accountEmail: EMAIL,
    project: "bella",
    type: "question",
    producer: "vpsp/l2",
    eventKey: "k1",
    body: "Is the migration complete?",
    ...overrides,
  } as any;
}

test("a session's life is published as events on its project stream", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1", project: "github.com/rocodesign/bella" });
  await titleSession(db, EMAIL, { sessionId: "s1", title: "Repair the booking flow" });
  await enrichSession(db, EMAIL, { sessionId: "s1", summary: "The booking flow was repaired.", tasks: [{ name: "Verify staging" }] });
  await endSession(db, EMAIL, "s1", "hook");

  const page = await listEvents(db, EMAIL, { project: "bella" });
  assert.deepEqual(
    page.events.map((event) => event.type),
    ["session.started", "session.titled", "session.summarized", "session.ended"],
  );
  assert.equal(page.events[2].body, "The booking flow was repaired.");
  assert.equal(page.hasMore, false);
});

test("a completed follow-up is published", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1", project: "bella" });
  await enrichSession(db, EMAIL, { sessionId: "s1", summary: "Done.", tasks: [{ name: "Verify staging" }] });
  await completeTask(db, EMAIL, "s1", "Verify staging");
  const page = await listEvents(db, EMAIL, { project: "bella" });
  const completed = page.events.filter((event) => event.type === "task.completed");
  assert.equal(completed.length, 1);
  assert.match(completed[0].body, /Verify staging/);
});

test("a repeated post is one event", async (t) => {
  const { db } = await seeded(t);
  const first = await publishEvent(db, post());
  const second = await publishEvent(db, post());
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  const page = await listEvents(db, EMAIL, { project: "bella" });
  assert.equal(page.events.length, 1);
});

test("the cursor advances only through delivered rows", async (t) => {
  const { db } = await seeded(t);
  for (let index = 0; index < 3; index += 1) await publishEvent(db, post({ eventKey: `k${index}`, body: `message ${index}` }));

  const first = await listEvents(db, EMAIL, { project: "bella", limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextAfter, first.events[1].id);

  const second = await listEvents(db, EMAIL, { project: "bella", after: first.nextAfter, limit: 2 });
  assert.equal(second.events.length, 1);
  assert.equal(second.hasMore, false);

  const empty = await listEvents(db, EMAIL, { project: "bella", after: second.nextAfter });
  assert.equal(empty.events.length, 0);
  assert.equal(empty.nextAfter, second.nextAfter);
});

test("a deleted event never lends its sequence to a later one", async (t) => {
  const { db } = await seeded(t);
  await publishEvent(db, post({ eventKey: "k1" }));
  const second = await publishEvent(db, post({ eventKey: "k2" }));
  await db.delete(events).where(eq(events.id, second.id));
  const third = await publishEvent(db, post({ eventKey: "k3" }));
  assert.ok(third.id > second.id, `expected a new sequence, got ${third.id} after ${second.id}`);
});

test("one project's stream never shows another's", async (t) => {
  const { db } = await seeded(t);
  await publishEvent(db, post({ project: "bella", eventKey: "a" }));
  await publishEvent(db, post({ project: "fleet", eventKey: "b" }));
  const page = await listEvents(db, EMAIL, { project: "bella" });
  assert.equal(page.events.length, 1);

  const removed = await purgeProjectEvents(db, EMAIL, "bella");
  assert.equal(removed.removed, 1);
  assert.equal((await listEvents(db, EMAIL, { project: "fleet" })).events.length, 1);
});

test("retention removes only events past the window", async (t) => {
  const { db } = await seeded(t);
  const fresh = await publishEvent(db, post({ eventKey: "fresh" }));
  const stale = await publishEvent(db, post({ eventKey: "stale" }));
  await db
    .update(events)
    .set({ createdAt: new Date(Date.now() - 31 * 24 * 3_600_000) })
    .where(eq(events.id, stale.id));
  const purged = await purgeOldEvents(db);
  assert.equal(purged.removed, 1);
  const page = await listEvents(db, EMAIL, { project: "bella" });
  assert.deepEqual(page.events.map((event) => event.id), [fresh.id]);
});
