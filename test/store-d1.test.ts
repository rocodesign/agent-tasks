import assert from "node:assert/strict";
import test from "node:test";
import { accounts, dismissals, sessions, tasks } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import {
  buildTree,
  computeVersion,
  dismissTask,
  endSession,
  enrichSession,
  ingestSnapshot,
  purgeOldEndedSessions,
  reapStaleSessions,
  removeSession,
  startSession,
  titleSession,
} from "../src/store.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";

async function seeded() {
  const harness = await freshDb();
  await harness.db.insert(accounts).values({ email: EMAIL });
  return harness;
}

test("starts a session and mirrors a task snapshot", async (t) => {
  const { db, miniflare } = await seeded();
  t.after(() => miniflare.dispose());

  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1", project: "D:/Work/fleet" });
  const ingested = await ingestSnapshot(db, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: "s1", title: "Port to D1" },
    tasks: [{ name: "write schema", status: "in_progress" }, { name: "run tests" }],
  });
  assert.ok("result" in ingested);
  assert.equal(ingested.result.tasks, 2);

  const tree = await buildTree(db, EMAIL);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].sessions.length, 1);
  assert.equal(tree[0].sessions[0].title, "Port to D1");
  assert.equal(tree[0].sessions[0].tasks.length, 2);
  assert.ok((await computeVersion(db, EMAIL)) > 0);
});

test("dismissals survive re-ingest and clear when the agent complies", async (t) => {
  const { db, miniflare } = await seeded();
  t.after(() => miniflare.dispose());

  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1" });
  await ingestSnapshot(db, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: "s1" },
    tasks: [{ name: "refactor everything" }],
  });
  await dismissTask(db, EMAIL, `${EMAIL}::s1`, "refactor everything");

  const again = await ingestSnapshot(db, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: "s1" },
    tasks: [{ name: "refactor everything" }],
  });
  assert.ok("result" in again);
  assert.deepEqual(again.result.dismissed, ["refactor everything"]);

  const complied = await ingestSnapshot(db, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: "s1" },
    tasks: [{ name: "something else" }],
  });
  assert.ok("result" in complied);
  assert.deepEqual(complied.result.dismissed, []);
});

test("titles a live session and lets enrichment replace generated tasks", async (t) => {
  const { db, miniflare } = await seeded();
  t.after(() => miniflare.dispose());

  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1" });
  assert.deepEqual(await titleSession(db, EMAIL, { sessionId: "s1", title: "First prompt" }), {
    titled: `${EMAIL}::s1`,
  });

  await enrichSession(db, EMAIL, {
    sessionId: "s1",
    title: "Digest title",
    summary: "Ported the archive tier.",
    tasks: [{ name: "apply remote migrations" }],
  });
  const [row] = await db.select().from(sessions).where(eq(sessions.id, `${EMAIL}::s1`));
  assert.equal(row.title, "Digest title");
  assert.equal(row.summary, "Ported the archive tier.");
  assert.ok(row.summarizedAt instanceof Date);

  const generated = await db.select().from(tasks).where(eq(tasks.sessionId, `${EMAIL}::s1`));
  assert.deepEqual(generated.map((task) => task.name), ["apply remote migrations"]);
});

test("reaps silent sessions and keeps summarized rows through a purge", async (t) => {
  const { db, miniflare } = await seeded();
  t.after(() => miniflare.dispose());

  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1" });
  const old = new Date(Date.now() - 60 * 60_000);
  await db.update(sessions).set({ lastActivityAt: old }).where(eq(sessions.id, `${EMAIL}::s1`));
  assert.deepEqual(await reapStaleSessions(db), { ended: 1 });

  await enrichSession(db, EMAIL, { sessionId: "s1", summary: "kept forever" });
  await db
    .update(sessions)
    .set({ updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60_000) })
    .where(eq(sessions.id, `${EMAIL}::s1`));
  assert.deepEqual(await purgeOldEndedSessions(db), { removed: 0 });
});

test("removing a session cascades to its tasks and dismissals", async (t) => {
  const { db, miniflare } = await seeded();
  t.after(() => miniflare.dispose());

  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1" });
  await ingestSnapshot(db, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: "s1" },
    tasks: [{ name: "keep me" }],
  });
  await dismissTask(db, EMAIL, `${EMAIL}::s1`, "keep me");
  await endSession(db, EMAIL, "s1");

  await removeSession(db, EMAIL, `${EMAIL}::s1`);
  assert.deepEqual(await db.select().from(sessions), []);
  assert.deepEqual(await db.select().from(tasks), []);
  assert.deepEqual(await db.select().from(dismissals), []);
});

test("stores the enrichment fields from start, ingest and enrich", async (t) => {
  const { db, miniflare } = await seeded();
  t.after(() => miniflare.dispose());

  await startSession(db, EMAIL, {
    machineId: "box",
    hostname: "box",
    sessionId: "s1",
    project: "D:/Work/sidus/fleet",
    meta: { projectKey: "github.com/rocodesign/fleet", kind: "delegated", harness: "claude-code" },
  });
  let [row] = await db.select().from(sessions).where(eq(sessions.id, `${EMAIL}::s1`));
  assert.equal(row.projectKey, "github.com/rocodesign/fleet");
  assert.equal(row.kind, "delegated");

  await ingestSnapshot(db, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: "s1", ticketId: "36", delegation: "majordomo-36" },
    tasks: [],
  });
  [row] = await db.select().from(sessions).where(eq(sessions.id, `${EMAIL}::s1`));
  assert.equal(row.ticketId, "36");
  assert.equal(row.delegation, "majordomo-36");
  assert.equal(row.projectKey, "github.com/rocodesign/fleet");

  await enrichSession(db, EMAIL, {
    sessionId: "s1",
    summary: "Ported the archive tier.",
    category: "infra",
    tags: ["cloudflare", "d1"],
    decisions: ["Keep the raw project column."],
    summaryVersion: 2,
    summarizedThrough: "msg-41",
  });
  [row] = await db.select().from(sessions).where(eq(sessions.id, `${EMAIL}::s1`));
  assert.equal(row.category, "infra");
  assert.deepEqual(row.tags, ["cloudflare", "d1"]);
  assert.deepEqual(row.decisions, ["Keep the raw project column."]);
  assert.equal(row.summaryVersion, 2);
  assert.equal(row.summarizedThrough, "msg-41");
  assert.equal(row.kind, "delegated");
});
