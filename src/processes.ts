import { eq } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import { accounts, machineProcesses } from "./db/schema.ts";
import { MACHINE_SHAPE } from "./identity.ts";

export const PROCESS_NAMES = ["deputy", "relay", "sidecar"] as const;
export type ProcessName = (typeof PROCESS_NAMES)[number];

export const MIN_INTERVAL_MS = 1_000;
export const MAX_INTERVAL_MS = 24 * 3_600_000;
// Two beats may be lost to a slow poll or a restart without the process being gone.
const MISSED_BEATS = 3;

export type Heartbeat = { machine: string; process: ProcessName; intervalMs: number; version: string | null };

export type ProcessStatus = {
  process: string;
  lastSeen: string | null;
  intervalMs: number;
  online: boolean;
  version: string | null;
};

export type MachineStatus = { machine: string; lastSeen: string | null; processes: ProcessStatus[] };

export function readHeartbeat(body: any): Heartbeat | { error: string } {
  const machine = String(body?.machine ?? "").trim();
  const process = String(body?.process ?? "").trim();
  const intervalMs = Number(body?.intervalMs);
  if (!MACHINE_SHAPE.test(machine)) return { error: "that is not a machine name" };
  if (!(PROCESS_NAMES as readonly string[]).includes(process)) {
    return { error: `process must be one of ${PROCESS_NAMES.join(", ")}` };
  }
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    return { error: `intervalMs must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}` };
  }
  const version = String(body?.version ?? "").trim().slice(0, 80);
  return { machine, process: process as ProcessName, intervalMs: Math.trunc(intervalMs), version: version || null };
}

export async function recordHeartbeat(db: DB, email: string, beat: Heartbeat): Promise<void> {
  const lastSeen = new Date();
  await db.insert(accounts).values({ email }).onConflictDoNothing();
  await db
    .insert(machineProcesses)
    .values({ accountEmail: email, ...beat, lastSeen })
    .onConflictDoUpdate({
      target: [machineProcesses.accountEmail, machineProcesses.machine, machineProcesses.process],
      set: { lastSeen, intervalMs: beat.intervalMs, version: beat.version },
    });
}

export function isOnline(lastSeen: Date | null, intervalMs: number, now = Date.now()): boolean {
  if (!lastSeen) return false;
  return now - lastSeen.getTime() < MISSED_BEATS * intervalMs;
}

export async function processesByMachine(db: DB, email: string, now = Date.now()): Promise<Map<string, ProcessStatus[]>> {
  const rows = await db
    .select()
    .from(machineProcesses)
    .where(eq(machineProcesses.accountEmail, email));
  const byMachine = new Map<string, ProcessStatus[]>();
  for (const row of rows) {
    const list = byMachine.get(row.machine) ?? [];
    list.push({
      process: row.process,
      lastSeen: row.lastSeen?.toISOString() ?? null,
      intervalMs: row.intervalMs,
      online: isOnline(row.lastSeen ?? null, row.intervalMs, now),
      version: row.version ?? null,
    });
    byMachine.set(row.machine, list);
  }
  for (const list of byMachine.values()) list.sort((a, b) => a.process.localeCompare(b.process));
  return byMachine;
}

export async function listMachines(db: DB, email: string, now = Date.now()): Promise<MachineStatus[]> {
  const byMachine = await processesByMachine(db, email, now);
  return [...byMachine]
    .map(([machine, processes]) => ({
      machine,
      lastSeen: processes.map((entry) => entry.lastSeen).filter(Boolean).sort().pop() ?? null,
      processes,
    }))
    .sort((a, b) => a.machine.localeCompare(b.machine));
}
