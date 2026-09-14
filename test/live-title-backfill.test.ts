import assert from "node:assert/strict";
import test from "node:test";
import { accounts } from "../src/db/schema.ts";
import { backfillTitle, buildLiveTree, ingestLive, startLive, type DurableState } from "../src/live-state.ts";
import { readSessionTitle, startSession } from "../src/store.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";
const NO_FILTERS = { project: null, kind: null, delegation: null, machine: null };
const TITLE = "Fix Ceiling Startup Menu Entry";

type Account = DurableState["accounts"][string];

async function seeded(t: any) {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });
  return harness;
}

function pruned(): Account {
  return { machines: {}, version: 0 };
}

function reader(db: any) {
  return (sessionId: string) => readSessionTitle(db, EMAIL, sessionId);
}

async function start(account: Account, body: any, read: (sessionId: string) => Promise<string | null>) {
  const result = startLive(account, EMAIL, body);
  if ("error" in result) return result;
  const title = await backfillTitle(account, result.sessionId, read);
  return { ok: true, ...result, title };
}

test("a resumed session takes its title back from the durable row", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1", title: TITLE });

  const account = pruned();
  const answer = await start(account, { machineId: "box", hostname: "box", sessionId: "s1" }, reader(db));

  assert.deepEqual(answer, {
    ok: true,
    machineId: `${EMAIL}::box`,
    sessionId: `${EMAIL}::s1`,
    title: TITLE,
  });

  const tree = buildLiveTree(account, EMAIL, NO_FILTERS);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].sessions.length, 1);
  assert.equal(tree[0].sessions[0].title, TITLE);
});

test("a session with no durable row answers a null title rather than none at all", async (t) => {
  const { db } = await seeded(t);

  const answer = await start(pruned(), { machineId: "box", hostname: "box", sessionId: "unknown" }, reader(db));

  assert.ok("title" in answer);
  assert.equal(answer.title, null);
});

test("a title the caller reports outranks the stored one", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1", title: TITLE });

  const answer = await start(
    pruned(),
    { machineId: "box", hostname: "box", sessionId: "s1", title: "Rename the launcher" },
    reader(db),
  );

  assert.equal(answer.title, "Rename the launcher");
});

test("a snapshot revives a pruned card with its stored title", async (t) => {
  const { db } = await seeded(t);
  await startSession(db, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1", title: TITLE });

  const account = pruned();
  const result = ingestLive(account, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: "s1" },
    tasks: [{ name: "read the transcript" }],
  });
  assert.ok(!("error" in result));

  const title = await backfillTitle(account, `${EMAIL}::s1`, reader(db));
  assert.equal(title, TITLE);
  assert.equal(buildLiveTree(account, EMAIL, NO_FILTERS)[0].sessions[0].title, TITLE);
});

test("a failed read leaves the card untitled instead of failing the start", async () => {
  const account = pruned();
  const answer = await start(account, { machineId: "box", hostname: "box", sessionId: "s1" }, () =>
    Promise.reject(new Error("D1_ERROR")),
  );

  assert.ok("title" in answer);
  assert.equal(answer.title, null);
  assert.equal(buildLiveTree(account, EMAIL, NO_FILTERS)[0].sessions[0].title, null);
});
