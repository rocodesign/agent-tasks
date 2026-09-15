import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { accounts } from "../src/db/schema.ts";
import { LiveState } from "../src/live-state.ts";
import { MachineRelay } from "../src/machine-relay.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";
const OTHER = "stranger@example.com";
const TOKEN = "at_watch_token";
const STATE_KEY = "fleet-state-v1";

type FakeSocket = { sent: string[]; send: (text: string) => void };
type Attached = { socket: FakeSocket; tags: string[] };

function socket(): FakeSocket {
  const sent: string[] = [];
  return { sent, send: (text: string) => void sent.push(text) };
}

function fakeCtx(attached: Attached[], stored: Record<string, any> = {}): any {
  let alarm: number | null = null;
  return {
    storage: {
      get: async (key: string) => stored[key],
      put: async (key: string, value: any) => void (stored[key] = value),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => void (alarm = at),
    },
    blockConcurrencyWhile: (work: () => Promise<any>) => work(),
    acceptWebSocket: (ws: FakeSocket, tags: string[]) => void attached.push({ socket: ws, tags }),
    getWebSockets: (tag?: string) =>
      attached.filter((entry) => !tag || entry.tags.includes(tag)).map((entry) => entry.socket),
    getTags: (ws: FakeSocket) => attached.find((entry) => entry.socket === ws)?.tags ?? [],
  };
}

function watchers(mine: FakeSocket, theirs: FakeSocket): Attached[] {
  return [
    { socket: mine, tags: ["watch", `watch:${EMAIL}`] },
    { socket: theirs, tags: ["watch", `watch:${OTHER}`] },
  ];
}

function seeded(keyHash: string) {
  return {
    keys: { [keyHash]: EMAIL },
    verifications: {},
    accounts: { [EMAIL]: { machines: {}, version: 7 }, [OTHER]: { machines: {}, version: 3 } },
    archive: {},
  };
}

test("a session start tells that account's watchers the tree moved, and nobody else's", async (t) => {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });

  const mine = socket();
  const theirs = socket();
  const state = seeded(await sha256Hex(TOKEN));
  const live = new LiveState(fakeCtx(watchers(mine, theirs), { [STATE_KEY]: state }), { DB: harness.binding } as any);

  const response = await live.fetch(
    new Request("https://live-state/api/session/start", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "box", hostname: "box", sessionId: "s1" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(theirs.sent, []);
  assert.equal(mine.sent.length, 1);
  const frame = JSON.parse(mine.sent[0]);
  assert.equal(frame.kind, "tree");
  assert.ok(frame.version > 7, `version ${frame.version} did not move`);
});

test("a read leaves the watchers alone", async (t) => {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });

  const mine = socket();
  const theirs = socket();
  const state = seeded(await sha256Hex(TOKEN));
  const live = new LiveState(fakeCtx(watchers(mine, theirs), { [STATE_KEY]: state }), { DB: harness.binding } as any);

  const response = await live.fetch(
    new Request("https://live-state/api/version", { headers: { authorization: `Bearer ${TOKEN}` } }),
  );

  assert.deepEqual(await response.json(), { version: 7 });
  assert.deepEqual(mine.sent, []);
  assert.deepEqual(theirs.sent, []);
});

test("an internal notify reaches that account's watchers as an events frame", async () => {
  const mine = socket();
  const theirs = socket();
  const live = new LiveState(fakeCtx(watchers(mine, theirs)), {} as any);

  const response = await live.fetch(
    new Request("https://live-state/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        project: "majordomo",
        delegation: "d-20260915-push",
        recipients: ["romeo-rtx"],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(theirs.sent, []);
  assert.deepEqual(JSON.parse(mine.sent[0]), {
    kind: "events",
    project: "majordomo",
    delegation: "d-20260915-push",
    recipients: ["romeo-rtx"],
  });
});

test("a nudge reaches the deputy and no console, and takes no websocket", async () => {
  const source = socket();
  const client = socket();
  const relay = new MachineRelay(
    fakeCtx([
      { socket: source, tags: ["source"] },
      { socket: client, tags: ["c-abc", "client"] },
    ]),
    {} as any,
  );

  const response = await relay.fetch(
    new Request("https://machine-relay/internal/nudge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "romeo-rtx" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(client.sent, []);
  assert.deepEqual(JSON.parse(source.sent[0]), {
    jsonrpc: "2.0",
    method: "fleet/events",
    params: { recipient: "romeo-rtx" },
  });
});

test("a nudge for a machine with no deputy attached is answered, not refused", async () => {
  const relay = new MachineRelay(fakeCtx([]), {} as any);

  const response = await relay.fetch(
    new Request("https://machine-relay/internal/nudge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "vps2" }),
    }),
  );

  assert.equal(response.status, 200);
});
