import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { accounts, machineProcesses } from "../src/db/schema.ts";
import { isOnline, listMachines, processesByMachine, readHeartbeat, recordHeartbeat } from "../src/processes.ts";
import { freshDb } from "./helpers/d1.ts";

const EMAIL = "romeo@example.com";

async function seeded(t: any) {
  const harness = await freshDb();
  t.after(() => harness.miniflare.dispose());
  await harness.db.insert(accounts).values({ email: EMAIL });
  return harness;
}

const beat = (overrides: Record<string, unknown> = {}) => ({
  machine: "vpsp",
  process: "deputy",
  intervalMs: 15000,
  ...overrides,
});

test("a heartbeat names a machine, a known process and an interval", () => {
  assert.deepEqual(readHeartbeat(beat()), { machine: "vpsp", process: "deputy", intervalMs: 15000, version: null });
  assert.deepEqual(readHeartbeat(beat({ version: "1.4.0" })).version, "1.4.0");
  assert.ok("error" in readHeartbeat(beat({ machine: "../etc" })));
  assert.ok("error" in readHeartbeat(beat({ machine: "" })));
  assert.ok("error" in readHeartbeat(beat({ process: "summarizer" })));
  assert.ok("error" in readHeartbeat(beat({ intervalMs: 0 })));
  assert.ok("error" in readHeartbeat(beat({ intervalMs: "soon" })));
  assert.ok("error" in readHeartbeat(beat({ intervalMs: 48 * 3_600_000 })));
});

test("a process is online until three of its own intervals pass", () => {
  const now = Date.now();
  assert.equal(isOnline(new Date(now - 20_000), 15000, now), true);
  assert.equal(isOnline(new Date(now - 44_000), 15000, now), true);
  assert.equal(isOnline(new Date(now - 46_000), 15000, now), false);
  assert.equal(isOnline(null, 15000, now), false);
  assert.equal(isOnline(new Date(now - 46_000), 300_000, now), true);
});

test("a repeated beat rewrites one row rather than adding history", async (t) => {
  const { db } = await seeded(t);
  await recordHeartbeat(db, EMAIL, readHeartbeat(beat()) as any);
  await recordHeartbeat(db, EMAIL, readHeartbeat(beat({ version: "1.4.1" })) as any);

  const rows = await db
    .select()
    .from(machineProcesses)
    .where(and(eq(machineProcesses.accountEmail, EMAIL), eq(machineProcesses.machine, "vpsp")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, "1.4.1");
  assert.equal(rows[0].intervalMs, 15000);
});

test("machines list their own processes, newest beat first", async (t) => {
  const { db } = await seeded(t);
  await recordHeartbeat(db, EMAIL, readHeartbeat(beat()) as any);
  await recordHeartbeat(db, EMAIL, readHeartbeat(beat({ process: "relay", intervalMs: 30000 })) as any);
  await recordHeartbeat(db, EMAIL, readHeartbeat(beat({ machine: "vps2", process: "sidecar", intervalMs: 300000 })) as any);

  const machines = await listMachines(db, EMAIL);
  assert.deepEqual(machines.map((machine) => machine.machine), ["vps2", "vpsp"]);
  assert.deepEqual(machines[1].processes.map((entry) => entry.process), ["deputy", "relay"]);
  assert.equal(machines[1].processes[0].online, true);
  assert.equal(machines[1].processes[1].intervalMs, 30000);
  assert.ok(machines[1].lastSeen);
});

test("a process that stopped beating is offline, not absent", async (t) => {
  const { db } = await seeded(t);
  await recordHeartbeat(db, EMAIL, readHeartbeat(beat()) as any);
  await db
    .update(machineProcesses)
    .set({ lastSeen: new Date(Date.now() - 10 * 60_000) })
    .where(eq(machineProcesses.machine, "vpsp"));

  const [machine] = await listMachines(db, EMAIL);
  assert.equal(machine.processes.length, 1);
  assert.equal(machine.processes[0].online, false);
});

test("one account never sees another's processes", async (t) => {
  const { db } = await seeded(t);
  await db.insert(accounts).values({ email: "stranger@example.com" });
  await recordHeartbeat(db, EMAIL, readHeartbeat(beat()) as any);
  await recordHeartbeat(db, "stranger@example.com", readHeartbeat(beat({ machine: "theirs" })) as any);

  assert.deepEqual((await listMachines(db, EMAIL)).map((machine) => machine.machine), ["vpsp"]);
  assert.deepEqual([...(await processesByMachine(db, "stranger@example.com")).keys()], ["theirs"]);
});
