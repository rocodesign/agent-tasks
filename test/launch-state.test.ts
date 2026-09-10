import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { accounts, events } from "../src/db/schema.ts";
import { EXPIRY_NOTE, EXPIRY_TYPE, expireStaleLaunches, publishEvent } from "../src/events.ts";
import { assignLaunch, delegationProblem, LaunchConflict } from "../src/launch.ts";
import { deriveLaunchState, listDelegations, noteOf, readLaunch, STALE_AFTER_MS } from "../src/launch-state.ts";
import { enrichSession, startSession } from "../src/store.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";
const LAUNCH = "l-20260910-aabbccdd";
const OTHER = "l-20260910-11112222";
const DELEGATION = "d-20260910-fix-brief";

async function seeded(t: any) {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });
  return { ...harness, r2: (await harness.bucket()) as unknown as R2Bucket };
}

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    launchId: LAUNCH,
    project: "majordomo",
    machine: "vpsp",
    prompt: "Repair the brief.",
    delegation: DELEGATION,
    cwd: "D:/Work/sidus/majordomo",
    ...overrides,
  } as any;
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    accountEmail: EMAIL,
    project: "majordomo",
    type: "status",
    producer: "deputy",
    eventKey: `k${Math.random()}`,
    launch: LAUNCH,
    recipient: LAUNCH,
    delegation: DELEGATION,
    body: "{}",
    ...overrides,
  } as any;
}

const age = (db: any, launch: string, ms: number) =>
  db.update(events).set({ createdAt: new Date(Date.now() - ms) }).where(eq(events.launch, launch));

test("a note reads the same whether a machine or a person wrote it", () => {
  assert.equal(noteOf(JSON.stringify({ note: "working on the selector" })), "working on the selector");
  assert.equal(noteOf(JSON.stringify({ reason: "spawn failed: EPERM" })), "spawn failed: EPERM");
  assert.equal(noteOf("Is the migration complete?"), "Is the migration complete?");
  assert.equal(noteOf("{not json"), "{not json");
});

test("the newest evidence names the state, and an outcome outranks progress", () => {
  assert.equal(deriveLaunchState(["delegation.assigned"], false), "assigned");
  assert.equal(deriveLaunchState(["delegation.assigned", "launch.claimed"], false), "claimed");
  assert.equal(deriveLaunchState(["delegation.assigned", "launch.claimed", "launch.started"], false), "running");
  assert.equal(deriveLaunchState(["launch.started", "launch.failed"], false), "failed");
  assert.equal(deriveLaunchState(["launch.started", "launch.cancelled"], false), "cancelled");
  assert.equal(deriveLaunchState(["delegation.assigned", EXPIRY_TYPE], false), "expired");
  assert.equal(deriveLaunchState(["delegation.assigned", "launch.started"], true), "done");
  assert.equal(deriveLaunchState(["status"], false), "assigned");
});

test("an assigned launch reports its machine, its delegation and no reason", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());

  const launch = await readLaunch(db, EMAIL, LAUNCH);
  assert.ok(launch);
  assert.equal(launch.launchId, LAUNCH);
  assert.equal(launch.state, "assigned");
  assert.equal(launch.machine, "vpsp");
  assert.equal(launch.project, "majordomo");
  assert.equal(launch.delegation, DELEGATION);
  assert.equal(launch.reason, null);
  assert.equal(launch.stale, false);
  assert.equal(launch.sessionId, null);
  assert.equal(launch.lastEvent?.type, "delegation.assigned");
  assert.ok(launch.assignedAt);
});

test("a failure carries the deputy's last error as the reason", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.claimed", eventKey: `${LAUNCH}:claimed` }));
  await publishEvent(
    db,
    post({
      type: "launch.failed",
      eventKey: `${LAUNCH}:failed`,
      body: JSON.stringify({ note: "abandoned after 5 attempts: the assignment expired" }),
    }),
  );

  const launch = await readLaunch(db, EMAIL, LAUNCH);
  assert.equal(launch?.state, "failed");
  assert.equal(launch?.reason, "abandoned after 5 attempts: the assignment expired");
});

test("a launch whose session was summarized is done", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.started", eventKey: `${LAUNCH}:started` }));
  await publishEvent(db, post({ eventKey: `${LAUNCH}:progress`, body: JSON.stringify({ session: "s1", state: "working" }) }));

  await startSession(db, EMAIL, { machineId: "vpsp", hostname: "vpsp", sessionId: "s1", project: "majordomo" });
  assert.equal((await readLaunch(db, EMAIL, LAUNCH))?.state, "running");

  await enrichSession(db, EMAIL, { sessionId: "s1", summary: "The brief was repaired." });
  const launch = await readLaunch(db, EMAIL, LAUNCH);
  assert.equal(launch?.state, "done");
  assert.equal(launch?.sessionId, "s1");
});

test("a live launch goes stale after a day of silence", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.started", eventKey: `${LAUNCH}:started` }));
  await age(db, LAUNCH, STALE_AFTER_MS + 60_000);

  const launch = await readLaunch(db, EMAIL, LAUNCH);
  assert.equal(launch?.state, "running");
  assert.equal(launch?.stale, true);
});

test("a settled launch is never stale", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.cancelled", eventKey: `${LAUNCH}:cancelled` }));
  await age(db, LAUNCH, STALE_AFTER_MS * 3);
  assert.equal((await readLaunch(db, EMAIL, LAUNCH))?.stale, false);
});

test("a question stays open until an answer replies to it", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  const asked = await publishEvent(db, post({ type: "question", producer: "deputy", eventKey: "q1", body: "Which branch?" }));
  const second = await publishEvent(db, post({ type: "question", producer: "deputy", eventKey: "q2", body: "Deploy now?" }));

  let launch = await readLaunch(db, EMAIL, LAUNCH);
  assert.deepEqual(launch?.openQuestions.map((question) => question.note), ["Which branch?", "Deploy now?"]);
  assert.equal(launch?.openQuestions[0].id, asked.id);

  await publishEvent(db, post({ type: "answer", producer: "majordomo", eventKey: "a1", replyTo: asked.id, body: "main" }));
  launch = await readLaunch(db, EMAIL, LAUNCH);
  assert.deepEqual(launch?.openQuestions.map((question) => question.id), [second.id]);
});

test("a launch nobody ever assigned is not found", async (t) => {
  const { db } = await seeded(t);
  assert.equal(await readLaunch(db, EMAIL, "l-20260910-99999999"), null);
});

test("the maintenance pass closes an assignment no deputy claimed", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  assert.deepEqual(await expireStaleLaunches(db), { expired: 0 });

  await age(db, LAUNCH, 7 * 3_600_000);
  assert.deepEqual(await expireStaleLaunches(db), { expired: 1 });

  const [expiry] = await db.select().from(events).where(eq(events.type, EXPIRY_TYPE));
  assert.equal(expiry.launch, LAUNCH);
  assert.equal(expiry.project, "majordomo");
  assert.equal(expiry.delegation, DELEGATION);
  assert.equal(expiry.recipient, "vpsp");
  assert.equal(expiry.producer, "fleet");
  assert.equal(expiry.eventKey, `expired:${LAUNCH}`);
  assert.equal(JSON.parse(expiry.body).note, EXPIRY_NOTE);
  assert.equal((await readLaunch(db, EMAIL, LAUNCH))?.state, "expired");

  assert.deepEqual(await expireStaleLaunches(db), { expired: 0 });
  assert.equal((await db.select().from(events).where(eq(events.type, EXPIRY_TYPE))).length, 1);
});

test("a claimed assignment is never expired, however old", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.claimed", eventKey: `${LAUNCH}:claimed` }));
  await age(db, LAUNCH, 30 * 3_600_000);
  assert.deepEqual(await expireStaleLaunches(db), { expired: 0 });
});

test("a cancelled assignment is not expired on top of its cancellation", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.cancelled", producer: "orchestrator", eventKey: `${LAUNCH}:cancelled` }));
  await age(db, LAUNCH, 30 * 3_600_000);
  assert.deepEqual(await expireStaleLaunches(db), { expired: 0 });
  assert.equal((await readLaunch(db, EMAIL, LAUNCH))?.state, "cancelled");
});

test("a delegation id is checked before a launch is assigned", () => {
  assert.equal(delegationProblem("d-20260910-fix-brief"), null);
  assert.equal(delegationProblem("d-20260910-a"), null);
  assert.equal(delegationProblem(null), null);
  assert.ok(delegationProblem("majordomo-36"));
  assert.ok(delegationProblem("d-2026-fix"));
  assert.ok(delegationProblem("d-20260910-Fix-Brief"));
  assert.ok(delegationProblem("d-20260910-fix--brief"));
  assert.ok(delegationProblem(`d-20260910-${"a".repeat(60)}`));
  assert.ok(delegationProblem(42));
});

test("an assignment carrying a malformed delegation is refused before anything is written", async (t) => {
  const { db, r2 } = await seeded(t);
  await assert.rejects(
    () => assignLaunch(db, r2, EMAIL, assignment({ delegation: "majordomo-36" })),
    (error: any) => error instanceof LaunchConflict && error.status === 400,
  );
  assert.equal(await readLaunch(db, EMAIL, LAUNCH), null);
});

test("open delegations carry their launches, their questions and their state", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.started", eventKey: `${LAUNCH}:started` }));
  await publishEvent(db, post({ type: "question", producer: "deputy", eventKey: "q1", body: "Which branch?" }));

  const [delegation] = await listDelegations(db, EMAIL, {});
  assert.equal(delegation.id, DELEGATION);
  assert.equal(delegation.project, "majordomo");
  assert.equal(delegation.state, "open");
  assert.equal(delegation.openQuestions, 1);
  assert.deepEqual(delegation.launches.map((launch) => launch.launchId), [LAUNCH]);
  assert.equal(delegation.launches[0].state, "running");
});

test("a delegation is done once its work is summarized and nothing is still running", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ eventKey: `${LAUNCH}:progress`, body: JSON.stringify({ session: "s1" }) }));
  await startSession(db, EMAIL, {
    machineId: "vpsp",
    hostname: "vpsp",
    sessionId: "s1",
    project: "majordomo",
    meta: { delegation: DELEGATION },
  });
  await enrichSession(db, EMAIL, { sessionId: "s1", summary: "Done." });

  assert.deepEqual(await listDelegations(db, EMAIL, {}), []);
  const [delegation] = await listDelegations(db, EMAIL, { state: "all" });
  assert.equal(delegation.state, "done");
  assert.equal(delegation.launches[0].state, "done");
});

test("a delegation whose every launch is spent is failed", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await publishEvent(db, post({ type: "launch.failed", eventKey: `${LAUNCH}:failed`, body: JSON.stringify({ note: "gave up" }) }));
  await assignLaunch(db, r2, EMAIL, assignment({ launchId: OTHER }));
  await publishEvent(db, post({ launch: OTHER, recipient: OTHER, type: "launch.cancelled", eventKey: `${OTHER}:cancelled` }));

  const [delegation] = await listDelegations(db, EMAIL, { state: "all" });
  assert.equal(delegation.state, "failed");
  assert.equal(delegation.launches.length, 2);
});

test("a silent open delegation is stale and sorts before the busy ones", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await age(db, LAUNCH, STALE_AFTER_MS + 60_000);
  await assignLaunch(db, r2, EMAIL, assignment({ launchId: OTHER, delegation: "d-20260910-fresh" }));

  const delegations = await listDelegations(db, EMAIL, {});
  assert.deepEqual(delegations.map((entry) => [entry.id, entry.state]), [
    [DELEGATION, "stale"],
    ["d-20260910-fresh", "open"],
  ]);
});

test("a project filter answers with that project's delegations only", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await assignLaunch(db, r2, EMAIL, assignment({ launchId: OTHER, project: "fleet", delegation: "d-20260910-relay" }));

  assert.deepEqual((await listDelegations(db, EMAIL, { project: "fleet" })).map((entry) => entry.id), [
    "d-20260910-relay",
  ]);
  assert.equal((await listDelegations(db, EMAIL, {})).length, 2);
});

test("a credential scoped to one project never reads another's delegations", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await assignLaunch(db, r2, EMAIL, assignment({ launchId: OTHER, project: "fleet", delegation: "d-20260910-relay" }));

  const visible = await listDelegations(db, EMAIL, { projects: ["fleet"] });
  assert.deepEqual(visible.map((entry) => entry.id), ["d-20260910-relay"]);
});
