import assert from "node:assert/strict";
import test from "node:test";
import { accounts } from "../src/db/schema.ts";
import { ASSIGNMENT_TYPE, DEPUTY_TYPES, listEvents, ORCHESTRATOR_TYPES, POST_TYPES, publishEvent } from "../src/events.ts";
import {
  assignLaunch,
  LaunchConflict,
  launchPromptKey,
  mintLaunchId,
  readLaunchPrompt,
  sha256Hex,
  storeLaunchPrompt,
} from "../src/launch.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";
const LAUNCH = "l-20260909-aabbccdd";
const PROMPT = "Repair the floor-plan selector.";

async function seeded(t: any) {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });
  return { ...harness, r2: (await harness.bucket()) as unknown as R2Bucket };
}

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    launchId: LAUNCH,
    project: "bella",
    machine: "romeo-rtx",
    prompt: PROMPT,
    delegation: "d-20260909-floorplan",
    cwd: "D:/Work/bella",
    ...overrides,
  } as any;
}

test("a minted launch id carries its day and is not repeated", () => {
  const id = mintLaunchId(new Date("2026-09-09T10:00:00Z"));
  assert.match(id, /^l-20260909-[0-9a-f]{8}$/);
  assert.notEqual(id, mintLaunchId(new Date("2026-09-09T10:00:00Z")));
});

test("an assignment is never postable through the generic route", () => {
  const postable = [...POST_TYPES, ...DEPUTY_TYPES, ...ORCHESTRATOR_TYPES] as readonly string[];
  assert.equal(postable.includes(ASSIGNMENT_TYPE), false);
});

test("the prompt reaches R2 before the event that names it", async (t) => {
  const { db, r2 } = await seeded(t);
  const result = await assignLaunch(db, r2, EMAIL, assignment());

  assert.equal(await readLaunchPrompt(r2, LAUNCH), PROMPT);
  assert.equal(result.promptKey, launchPromptKey(LAUNCH));
  assert.equal(result.sha256, await sha256Hex(PROMPT));

  const page = await listEvents(db, EMAIL, { recipients: ["romeo-rtx"] });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].type, ASSIGNMENT_TYPE);
  assert.equal(page.events[0].launch, LAUNCH);
  assert.deepEqual(JSON.parse(page.events[0].body), {
    launchId: LAUNCH,
    cwd: "D:/Work/bella",
    promptKey: result.promptKey,
    sha256: result.sha256,
  });
});

test("a redelivered assignment is one event and one prompt", async (t) => {
  const { db, r2 } = await seeded(t);
  const first = await assignLaunch(db, r2, EMAIL, assignment());
  const second = await assignLaunch(db, r2, EMAIL, assignment());
  assert.equal(second.duplicate, true);
  assert.equal(second.eventId, first.eventId);
  assert.equal((await listEvents(db, EMAIL, { recipients: ["romeo-rtx"] })).events.length, 1);
});

test("one launch cannot be assigned twice under different parameters", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await assert.rejects(
    () => assignLaunch(db, r2, EMAIL, assignment({ machine: "vps2" })),
    (error: any) => error instanceof LaunchConflict && error.status === 409,
  );
  const page = await listEvents(db, EMAIL, { recipients: ["vps2"] });
  assert.equal(page.events.length, 0);
});

test("a second producer cannot assign a launch that already exists", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  // The generic key is (account, producer, event key), so only the assignment index stops this.
  await assert.rejects(() =>
    publishEvent(db, {
      accountEmail: EMAIL,
      project: "bella",
      type: ASSIGNMENT_TYPE,
      producer: "someone-else",
      eventKey: LAUNCH,
      recipient: "vps2",
      launch: LAUNCH,
      body: "{}",
    }),
  );
  assert.equal((await listEvents(db, EMAIL, { recipients: ["vps2"] })).events.length, 0);
});

test("an issued prompt cannot be rewritten under the same launch", async (t) => {
  const { db, r2 } = await seeded(t);
  await assignLaunch(db, r2, EMAIL, assignment());
  await assert.rejects(
    () => assignLaunch(db, r2, EMAIL, assignment({ prompt: "Do something else entirely." })),
    (error: any) => error instanceof LaunchConflict && error.status === 409,
  );
  assert.equal(await readLaunchPrompt(r2, LAUNCH), PROMPT);
});

test("a prompt that already exists byte for byte is not a conflict", async (t) => {
  const { r2 } = await seeded(t);
  const first = await storeLaunchPrompt(r2, LAUNCH, "same");
  const second = await storeLaunchPrompt(r2, LAUNCH, "same");
  assert.equal(first.sha256, second.sha256);
});

test("a launch id that does not match the pattern is refused before anything is written", async (t) => {
  const { db, r2 } = await seeded(t);
  await assert.rejects(
    () => assignLaunch(db, r2, EMAIL, assignment({ launchId: "../../etc/passwd" })),
    (error: any) => error instanceof LaunchConflict && error.status === 400,
  );
  assert.equal(await readLaunchPrompt(r2, "../../etc/passwd"), null);
});

test("an assignment that would not survive the body limit is refused, not truncated", async (t) => {
  const { db, r2 } = await seeded(t);
  await assert.rejects(
    () => assignLaunch(db, r2, EMAIL, assignment({ cwd: "x".repeat(600) })),
    (error: any) => error instanceof LaunchConflict && error.status === 400,
  );
});

test("a consumer hears its launch, its session and its delegation in one query", async (t) => {
  const { db } = await seeded(t);
  const common = { accountEmail: EMAIL, project: "bella", type: "status", producer: "majordomo", body: "x" };
  await publishEvent(db, { ...common, eventKey: "a", recipient: LAUNCH } as any);
  await publishEvent(db, { ...common, eventKey: "b", recipient: "s-1" } as any);
  await publishEvent(db, { ...common, eventKey: "c", recipient: "d-20260909-floorplan" } as any);
  await publishEvent(db, { ...common, eventKey: "d", recipient: "someone-else" } as any);
  await publishEvent(db, { ...common, eventKey: "e" } as any);

  const page = await listEvents(db, EMAIL, { recipients: [LAUNCH, "s-1", "d-20260909-floorplan"] });
  assert.deepEqual(page.events.map((event) => event.recipient), [LAUNCH, "s-1", "d-20260909-floorplan"]);
});

test("a message scoped to a replaced launch never reaches the one that replaced it", async (t) => {
  const { db } = await seeded(t);
  const common = { accountEmail: EMAIL, project: "bella", type: "status", producer: "majordomo", body: "x" };
  const delegation = "d-20260909-floorplan";
  await publishEvent(db, { ...common, eventKey: "old", recipient: delegation, launch: "l-20260909-11111111" } as any);
  await publishEvent(db, { ...common, eventKey: "broadcast", recipient: delegation } as any);
  await publishEvent(db, { ...common, eventKey: "mine", recipient: delegation, launch: LAUNCH } as any);

  const page = await listEvents(db, EMAIL, { recipients: [delegation, LAUNCH], launches: [LAUNCH] });
  assert.deepEqual(page.events.map((event) => event.launch), [null, LAUNCH]);
});

test("a recipient query keeps the cursor discipline", async (t) => {
  const { db } = await seeded(t);
  const common = { accountEmail: EMAIL, project: "bella", type: "status", producer: "majordomo", body: "x", recipient: "box" };
  for (let index = 0; index < 3; index += 1) await publishEvent(db, { ...common, eventKey: `k${index}` } as any);

  const first = await listEvents(db, EMAIL, { recipients: ["box"], limit: 2 });
  assert.equal(first.hasMore, true);
  const second = await listEvents(db, EMAIL, { recipients: ["box"], after: first.nextAfter });
  assert.equal(second.events.length, 1);
  const empty = await listEvents(db, EMAIL, { recipients: ["box"], after: second.nextAfter });
  assert.equal(empty.nextAfter, second.nextAfter);
});

test("a query with no project and no recipient is refused", async (t) => {
  const { db } = await seeded(t);
  await assert.rejects(() => listEvents(db, EMAIL, {}), /project or a recipient/);
});

test("more recipients than the parameter budget is refused", async (t) => {
  const { db } = await seeded(t);
  const many = Array.from({ length: 21 }, (_value, index) => `r${index}`);
  await assert.rejects(() => listEvents(db, EMAIL, { recipients: many }), /at most 20 recipients/);
});

test("a project filter cannot hide a message addressed to the consumer", async (t) => {
  const { db } = await seeded(t);
  await assert.rejects(
    () => listEvents(db, EMAIL, { project: "bella", recipients: ["box"] }),
    /cannot also filter by project/,
  );
});
