import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { accounts, sessions } from "../src/db/schema.ts";
import {
  enrichSession,
  ingestSnapshot,
  listFailedDigests,
  listHistorySessions,
  markDigestFailed,
  MAX_DIGEST_REASON,
  startSession,
} from "../src/store.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";
const NO_FILTERS = { project: null, kind: null, delegation: null, machine: null };

async function seeded(t: any) {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });
  return harness;
}

const row = (db: any, id = "s1") => db.select().from(sessions).where(eq(sessions.id, `${EMAIL}::${id}`));

test("an abandoned digest is recorded on the session it belongs to", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "vpsp", hostname: "vpsp", sessionId: "s1", project: "majordomo" });

  const result = await markDigestFailed(db, EMAIL, { sessionId: "s1", reason: "model refused twice", attempts: 5 });
  assert.equal(result.failed, `${EMAIL}::s1`);

  const [session] = await row(db);
  assert.equal(session.digestFailedReason, "model refused twice");
  assert.equal(session.digestFailedAttempts, 5);
  assert.ok(session.digestFailedAt instanceof Date);
});

test("a reason longer than the column is cut, not refused", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "vpsp", hostname: "vpsp", sessionId: "s1" });
  await markDigestFailed(db, EMAIL, { sessionId: "s1", reason: "x".repeat(900), attempts: 5 });
  const [session] = await row(db);
  assert.equal(session.digestFailedReason.length, MAX_DIGEST_REASON);
});

test("a failure for a session Fleet never saw is not found", async (t) => {
  const { db } = await seeded(t);
  assert.deepEqual(await markDigestFailed(db, EMAIL, { sessionId: "ghost", reason: "gone", attempts: 5 }), {
    error: "not_found",
  });
  assert.deepEqual(await markDigestFailed(db, EMAIL, { reason: "gone" }), { error: "sessionId required" });
});

test("the failed list names the session, its machine and why the digest never arrived", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, {
    machineId: "vpsp",
    hostname: "vpsp",
    sessionId: "s1",
    project: "D:/Work/sidus/majordomo",
    title: "Repair the brief",
    meta: { projectKey: "majordomo" },
  });
  await markDigestFailed(db, EMAIL, { sessionId: "s1", reason: "transcript unreadable", attempts: 5 });

  const [failed] = await listFailedDigests(db, EMAIL, NO_FILTERS);
  assert.equal(failed.sessionId, "s1");
  assert.equal(failed.machine, "vpsp");
  assert.equal(failed.title, "Repair the brief");
  assert.equal(failed.reason, "transcript unreadable");
  assert.equal(failed.attempts, 5);
  assert.ok(failed.failedAt);
  assert.ok(failed.endedAt);
});

test("a summary that finally arrives clears the failure", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "vpsp", hostname: "vpsp", sessionId: "s1", project: "majordomo" });
  await markDigestFailed(db, EMAIL, { sessionId: "s1", reason: "transcript unreadable", attempts: 5 });
  assert.equal((await listFailedDigests(db, EMAIL, NO_FILTERS)).length, 1);

  await enrichSession(db, EMAIL, { sessionId: "s1", summary: "The brief was repaired." });
  const [session] = await row(db);
  assert.equal(session.digestFailedAt, null);
  assert.equal(session.digestFailedReason, null);
  assert.equal(session.digestFailedAttempts, null);
  assert.equal((await listFailedDigests(db, EMAIL, NO_FILTERS)).length, 0);
});

test("the failed list follows the same project and machine filters as the history", async (t) => {
  const { db } = await seeded(t);
  for (const [id, project, machine] of [
    ["s1", "majordomo", "vpsp"],
    ["s2", "fleet", "vps2"],
  ] as const) {
    await startSession(db, EMAIL, {
      machineId: machine,
      hostname: machine,
      sessionId: id,
      project,
      meta: { projectKey: project },
    });
    await markDigestFailed(db, EMAIL, { sessionId: id, reason: "gave up", attempts: 5 });
  }

  assert.deepEqual(
    (await listFailedDigests(db, EMAIL, { ...NO_FILTERS, project: "fleet" })).map((entry) => entry.sessionId),
    ["s2"],
  );
  assert.deepEqual(
    (await listFailedDigests(db, EMAIL, { ...NO_FILTERS, machine: "vpsp" })).map((entry) => entry.sessionId),
    ["s1"],
  );
  assert.deepEqual(
    (await listFailedDigests(db, EMAIL, NO_FILTERS, ["fleet"])).map((entry) => entry.sessionId),
    ["s2"],
  );
});

test("a failed digest stays out of the default history and rides beside it", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "vpsp", hostname: "vpsp", sessionId: "s1", project: "majordomo" });
  await markDigestFailed(db, EMAIL, { sessionId: "s1", reason: "gave up", attempts: 5 });

  assert.equal((await listHistorySessions(db, EMAIL, { ...NO_FILTERS })).length, 0);
  const [session] = await listHistorySessions(db, EMAIL, { ...NO_FILTERS, all: true });
  assert.equal(session.digestFailedReason, "gave up");
});

test("proposed tags are stored on ingest and returned with the session", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "vpsp", hostname: "vpsp", sessionId: "s1", project: "majordomo" });
  await enrichSession(db, EMAIL, {
    sessionId: "s1",
    summary: "Ported the relay.",
    tags: ["relay", "fleet"],
    proposedTags: ["durable-object", "websocket"],
  });

  const [session] = await listHistorySessions(db, EMAIL, { ...NO_FILTERS });
  assert.deepEqual(session.tags, ["relay", "fleet"]);
  assert.deepEqual(session.proposedTags, ["durable-object", "websocket"]);
});

test("an ingest that names no proposed tags leaves the ones already stored", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "vpsp", hostname: "vpsp", sessionId: "s1", project: "majordomo" });
  await ingestSnapshot(db, EMAIL, {
    machine: { id: "vpsp", hostname: "vpsp" },
    session: { id: "s1", proposedTags: ["cloudflare"] },
    tasks: [],
  });
  await enrichSession(db, EMAIL, { sessionId: "s1", summary: "Done." });

  const [session] = await row(db);
  assert.deepEqual(session.proposedTags, ["cloudflare"]);
});
