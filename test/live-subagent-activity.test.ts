import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveTree, ingestLive, startLive, type DurableState } from "../src/live-state.ts";

const EMAIL = "romeo@example.com";
const NO_FILTERS = { project: null, kind: null, delegation: null, machine: null };
const PARENT = `${EMAIL}::s1`;
const CHILD = "s1:agent:a1";
const STALE = "2020-01-01T00:00:00.000Z";

type Account = DurableState["accounts"][string];

function empty(): Account {
  return { machines: {}, version: 0 };
}

function withParent(status = "active", endedReason: string | null = null): Account {
  const account = empty();
  startLive(account, EMAIL, { machineId: "box", hostname: "box", sessionId: "s1" });
  const parent = card(account, PARENT);
  parent.status = status;
  parent.endedReason = endedReason;
  parent.lastActivityAt = STALE;
  parent.updatedAt = STALE;
  return account;
}

function card(account: Account, sessionId: string) {
  const session = Object.values(account.machines)
    .flatMap((machine) => Object.values(machine.sessions))
    .find((entry) => entry.id === sessionId);
  assert.ok(session, `no live card for ${sessionId}`);
  return session;
}

function startChild(account: Account) {
  return startLive(account, EMAIL, { machineId: "box", hostname: "box", sessionId: CHILD });
}

test("a subagent start carries its parent's last activity forward", () => {
  const account = withParent();

  startChild(account);

  assert.ok(card(account, PARENT).lastActivityAt > STALE);
});

test("a subagent snapshot revives a parent the reaper ended", () => {
  const account = withParent("ended", "reaper");

  const result = ingestLive(account, EMAIL, {
    machine: { id: "box", hostname: "box" },
    session: { id: CHILD },
    tasks: [{ name: "read the transcript" }],
  });
  assert.ok(!("error" in result));

  const parent = card(account, PARENT);
  assert.equal(parent.status, "active");
  assert.equal(parent.endedReason, null);
  assert.ok(parent.lastActivityAt > STALE);
});

test("a subagent event leaves a parent its own hook ended alone", () => {
  const account = withParent("ended", "hook");

  startChild(account);

  const parent = card(account, PARENT);
  assert.equal(parent.status, "ended");
  assert.equal(parent.endedReason, "hook");
});

test("a subagent with no parent card starts on its own", () => {
  const account = empty();

  const result = startChild(account);

  assert.deepEqual(result, { machineId: `${EMAIL}::box`, sessionId: `${EMAIL}::${CHILD}` });
  const [machine] = buildLiveTree(account, EMAIL, NO_FILTERS);
  assert.equal(machine.sessions.length, 1);
  assert.equal(machine.sessions[0].parentSessionId, PARENT);
});
