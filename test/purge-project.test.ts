import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { accounts, events, sessions, tasks } from "../src/db/schema.ts";
import { insertEvent } from "../src/events.ts";
import { writeSessionKnowledge } from "../src/knowledge.ts";
import { storeLaunchPrompt } from "../src/launch.ts";
import { enrichSession, purgeProject, startSession } from "../src/store.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";

async function populated() {
  const harness = await freshDb();
  await harness.db.insert(accounts).values({ email: EMAIL });

  for (const [sessionId, project] of [
    ["doomed-1", "D:/Work/sidus/bella"],
    ["doomed-2", "/root/sidus/bella"],
    ["keeper", "D:/Work/sidus/fleet"],
  ] as const) {
    await startSession(harness.db, EMAIL, {
      machineId: "box",
      hostname: "box",
      sessionId,
      project,
      meta: { projectKey: project },
    });
    await enrichSession(harness.db, EMAIL, {
      sessionId,
      title: `Work on ${project}`,
      summary: "Something happened.",
      tasks: [{ name: "follow up" }],
      endedAt: "2026-09-09T18:20:00.000Z",
    });
  }

  await insertEvent(harness.db, {
    accountEmail: EMAIL,
    project: "bella",
    type: "status",
    producer: "sidecar",
    eventKey: "bella:1",
    launch: "l-20260909-0a1b2c3d",
    body: "{}",
  });
  await insertEvent(harness.db, {
    accountEmail: EMAIL,
    project: "fleet",
    type: "status",
    producer: "sidecar",
    eventKey: "fleet:1",
    body: "{}",
  });

  return harness;
}

test("a drop removes the project's sessions, follow-ups, events and objects", async (t) => {
  const { db, miniflare, bucket } = await populated();
  t.after(() => miniflare.dispose());
  const r2 = (await bucket()) as any;

  await writeSessionKnowledge(db, r2, EMAIL, "doomed-1", {});
  await writeSessionKnowledge(db, r2, EMAIL, "keeper", {});
  await storeLaunchPrompt(r2, "l-20260909-0a1b2c3d", "Do the thing.");

  const result = await purgeProject(db, r2, EMAIL, "bella");
  assert.equal(result.sessions.length, 2);
  // The manual event plus the lifecycle events Fleet writes for the two sessions.
  assert.ok(result.events >= 1);

  const left = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountEmail, EMAIL));
  assert.deepEqual(
    left.map((row) => row.id),
    [`${EMAIL}::keeper`],
  );

  const followUps = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.accountEmail, EMAIL));
  assert.equal(followUps.length, 1);

  const stream = await db.select({ project: events.project }).from(events).where(eq(events.accountEmail, EMAIL));
  assert.ok(stream.length > 0);
  assert.ok(stream.every((row) => row.project === "fleet"));

  assert.equal(await r2.get("sessions/bella/doomed-1.md"), null);
  assert.equal(await r2.get("launches/l-20260909-0a1b2c3d.md"), null);
  assert.ok(await r2.get("sessions/fleet/keeper.md"));
});

test("a rehearsal counts what a drop would take and removes none of it", async (t) => {
  const { db, miniflare, bucket } = await populated();
  t.after(() => miniflare.dispose());
  const r2 = (await bucket()) as any;

  await writeSessionKnowledge(db, r2, EMAIL, "doomed-1", {});
  await storeLaunchPrompt(r2, "l-20260909-0a1b2c3d", "Do the thing.");

  const rehearsal = await purgeProject(db, r2, EMAIL, "bella", { dryRun: true });
  assert.equal(rehearsal.dryRun, true);
  assert.equal(rehearsal.sessions.length, 2);
  assert.ok(rehearsal.events >= 1);
  assert.equal(rehearsal.objects, 2);

  assert.equal((await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountEmail, EMAIL))).length, 3);
  assert.ok(await r2.get("sessions/bella/doomed-1.md"));
  assert.ok(await r2.get("launches/l-20260909-0a1b2c3d.md"));

  const real = await purgeProject(db, r2, EMAIL, "bella");
  assert.equal(real.dryRun, false);
  assert.equal(real.sessions.length, rehearsal.sessions.length);
  assert.equal(real.events, rehearsal.events);
  assert.equal(real.objects, rehearsal.objects);
});

test("a slug that matched nothing changes nothing", async (t) => {
  const { db, miniflare, bucket } = await populated();
  t.after(() => miniflare.dispose());

  const result = await purgeProject(db, (await bucket()) as any, EMAIL, "nowhere");
  assert.equal(result.sessions.length, 0);
  assert.equal(result.events, 0);
  assert.equal(result.objects, 0);

  const left = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountEmail, EMAIL));
  assert.equal(left.length, 3);
});
