import assert from "node:assert/strict";
import test from "node:test";
import { deleteSessionKnowledge, writeSessionKnowledge } from "../src/knowledge.ts";
import { accounts } from "../src/db/schema.ts";
import { enrichSession, startSession } from "../src/store.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";

async function enriched() {
  const harness = await freshDb();
  await harness.db.insert(accounts).values({ email: EMAIL });
  await startSession(harness.db, EMAIL, {
    machineId: "windows-box",
    hostname: "windows-box",
    sessionId: "abc-123",
    project: "D:/Work/sidus/fleet",
    provider: "claude",
    meta: { projectKey: "github.com/rocodesign/fleet", kind: "interactive", ticketId: "36" },
  });
  await enrichSession(harness.db, EMAIL, {
    sessionId: "abc-123",
    title: "Move the archive tier to D1",
    summary: "Ported the schema and the store to Cloudflare D1.",
    category: "infra",
    tags: ["cloudflare", "d1"],
    decisions: ["Keep the raw project column."],
    endedAt: "2026-09-09T18:20:00.000Z",
    tasks: [{ name: "Apply the remote migrations." }],
  });
  return harness;
}

test("writes the enriched session to R2 with its facets", async (t) => {
  const { db, miniflare, bucket } = await enriched();
  t.after(() => miniflare.dispose());

  const key = await writeSessionKnowledge(db, (await bucket()) as any, EMAIL, "abc-123", {
    endedAt: "2026-09-09T18:20:00.000Z",
  });
  assert.equal(key, "sessions/fleet/abc-123.md");

  const object = await (await bucket()).get(key!);
  assert.ok(object);
  const body = await object.text();
  assert.match(body, /^---\ntype: session\ncategory: infra\nproject: fleet\ndate: 2026-09-09\nmachine: windows-box\n/);
  assert.match(body, /\ntags: #fleet #cloudflare #d1\n/);
  assert.match(body, /\n# Move the archive tier to D1\n/);
  assert.match(body, /\n## Follow-ups\n- Apply the remote migrations\./);
  assert.deepEqual(object.customMetadata, {
    type: "session",
    category: "infra",
    machine: "windows-box",
    kind: "interactive",
    ref: "36",
  });
});

test("purges the object when the session is removed", async (t) => {
  const { db, miniflare, bucket } = await enriched();
  t.after(() => miniflare.dispose());

  await writeSessionKnowledge(db, (await bucket()) as any, EMAIL, "abc-123", {});
  assert.ok(await (await bucket()).get("sessions/fleet/abc-123.md"));

  const removed = await deleteSessionKnowledge(db, (await bucket()) as any, EMAIL, `${EMAIL}::abc-123`);
  assert.equal(removed, "sessions/fleet/abc-123.md");
  assert.equal(await (await bucket()).get("sessions/fleet/abc-123.md"), null);
});

test("skips the write when the session is not in the archive", async (t) => {
  const { db, miniflare, bucket } = await enriched();
  t.after(() => miniflare.dispose());

  assert.equal(await writeSessionKnowledge(db, (await bucket()) as any, EMAIL, "missing", {}), null);
  assert.equal(await deleteSessionKnowledge(db, (await bucket()) as any, EMAIL, "missing"), null);
});
