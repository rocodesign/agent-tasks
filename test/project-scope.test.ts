import assert from "node:assert/strict";
import test from "node:test";
import { accounts } from "../src/db/schema.ts";
import { insertEvent, listEvents } from "../src/events.ts";
import { scopeSearch } from "../src/search.ts";
import { reachableSession } from "../src/session-filters.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";

test("an unrestricted credential searches whatever it names", () => {
  const open = scopeSearch({ query: "what happened" }, null);
  assert.equal(open.ok, true);
  assert.equal(open.ok && open.request.project, undefined);
});

test("one project is forced rather than asked for", () => {
  const scoped = scopeSearch({ query: "what happened" }, ["bella"]);
  assert.equal(scoped.ok, true);
  assert.equal(scoped.ok && scoped.request.project, "bella");
});

test("a project outside the scope is refused, not silently widened", () => {
  const scoped = scopeSearch({ query: "what happened", project: "fleet" }, ["bella"]);
  assert.equal(scoped.ok, false);
  assert.equal(!scoped.ok && scoped.status, 403);
});

test("several projects need one named, because the filter compares one folder", () => {
  const scoped = scopeSearch({ query: "what happened" }, ["bella", "fleet"]);
  assert.equal(scoped.ok, false);
  assert.equal(!scoped.ok && scoped.status, 400);
  assert.match(!scoped.ok ? scoped.error : "", /bella, fleet/);

  const named = scopeSearch({ query: "what happened", project: "fleet" }, ["bella", "fleet"]);
  assert.equal(named.ok, true);
});

test("a recipient query cannot read another project's stream", async (t) => {
  const { db, miniflare } = await freshDb();
  t.after(() => miniflare.dispose());
  await db.insert(accounts).values({ email: EMAIL });

  const launch = "l-20260909-0a1b2c3d";
  await insertEvent(db, {
    accountEmail: EMAIL,
    project: "fleet",
    type: "decision",
    producer: "majordomo",
    eventKey: "fleet:1",
    recipient: launch,
    body: "Ship it.",
  });
  await insertEvent(db, {
    accountEmail: EMAIL,
    project: "bella",
    type: "decision",
    producer: "majordomo",
    eventKey: "bella:1",
    recipient: launch,
    body: "Hold it.",
  });

  const open = await listEvents(db, EMAIL, { recipients: [launch] });
  assert.equal(open.events.length, 2);

  const scoped = await listEvents(db, EMAIL, { recipients: [launch], projects: ["bella"] });
  assert.deepEqual(
    scoped.events.map((event) => event.body),
    ["Hold it."],
  );
});

test("a session is reachable by the slug its cwd derives, not by the raw key", () => {
  const session = { projectKey: "D:/Work/sidus/bella", project: "D:/Work/sidus/bella" };
  assert.equal(reachableSession(session, null), true);
  assert.equal(reachableSession(session, ["bella"]), true);
  assert.equal(reachableSession(session, ["fleet"]), false);
  assert.equal(reachableSession({ projectKey: null, project: null }, ["bella"]), false);
});
