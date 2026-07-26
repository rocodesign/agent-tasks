import { eq } from "drizzle-orm";
import { createDb } from "./db/client";
import { accounts, apiKeys } from "./db/schema";
import {
  dismissTask,
  endLatestSession,
  endSession,
  ingestSnapshot,
  removeSession,
  startSession,
} from "./store";
import {
  generateApiKey,
  generateOtp,
  isAllowedEmail,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  sendOtpEmail,
  sha256Hex,
} from "./auth";

export type Bindings = {
  DATABASE_URL: string;
  RESEND_API_KEY: string;
  RESEND_FROM?: string;
  ALLOWED_EMAILS?: string;
  BOOTSTRAP_API_KEY?: string;
  LIVE_STATE: DurableObjectNamespace;
  ASSETS: Fetcher;
};

type LiveTask = {
  id: string;
  name: string;
  status: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type LiveSession = {
  id: string;
  machineId: string;
  project: string | null;
  title: string | null;
  status: string;
  endedReason: string | null;
  startedAt: string;
  lastActivityAt: string;
  updatedAt: string;
  tasks: LiveTask[];
};

type LiveMachine = {
  id: string;
  hostname: string;
  os: string | null;
  label: string | null;
  firstSeen: string;
  lastSeen: string;
  updatedAt: string;
  sessions: Record<string, LiveSession>;
};

type Verification = {
  code: string;
  attempts: number;
  expiresAt: number;
};

type ArchiveEvent = {
  id: string;
  kind: "api-key" | "start" | "ingest" | "dismiss" | "end" | "remove";
  email: string;
  body: any;
  queuedAt: number;
};

export type DurableState = {
  keys: Record<string, string>;
  verifications: Record<string, Verification>;
  accounts: Record<string, { machines: Record<string, LiveMachine>; version: number }>;
  archive: Record<string, ArchiveEvent>;
};

const STATE_KEY = "fleet-state-v1";
const ARCHIVE_INTERVAL_MS = 60 * 60_000;

export class LiveState {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Bindings,
  ) {}

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      const response = await this.route(request, state);
      return response;
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.load();
      await this.flushArchive(state);
    });
  }

  private async route(request: Request, state: DurableState): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/auth/request-otp" && request.method === "POST") {
      return this.requestOtp(request, state);
    }
    if (path === "/api/auth/verify-otp" && request.method === "POST") {
      return this.verifyOtp(request, state);
    }

    const email = await this.resolveEmail(request, state);
    if (!email) return json({ error: "unauthorized" }, 401);
    const account = ensureAccount(state, email);

    if (path === "/api/version" && request.method === "GET") {
      return json({ version: account.version });
    }
    if (path === "/api/tree" && request.method === "GET") {
      return json({ machines: buildLiveTree(account, email) });
    }
    if (path === "/api/ingest" && request.method === "POST") {
      const body: any = await request.json().catch(() => null);
      const result = ingestLive(account, email, body);
      if ("error" in result) return json({ error: result.error }, 400);
      queue(state, {
        id: `ingest:${email}:${String(body?.session?.id)}`,
        kind: "ingest",
        email,
        body,
      });
      await this.changed(state);
      return json({ ok: true, ...result });
    }
    if (path === "/api/session/start" && request.method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const result = startLive(account, email, body);
      if ("error" in result) return json({ error: result.error }, 400);
      queue(state, { id: `start:${email}:${result.sessionId}`, kind: "start", email, body });
      await this.changed(state);
      return json({ ok: true, ...result });
    }
    if (path === "/api/session/end" && request.method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const result = endLive(account, email, body);
      if ("error" in result) return json({ error: result.error }, 400);
      queue(state, {
        id: `end:${email}:${String(body?.sessionId ?? body?.machineId ?? Date.now())}`,
        kind: "end",
        email,
        body,
      });
      await this.persist(state);
      await this.ctx.storage.setAlarm(Date.now());
      return json({ ok: true, ...result });
    }
    if (path === "/api/dismiss" && request.method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const result = dismissLive(account, body);
      if ("error" in result) return json({ error: result.error }, 404);
      queue(state, {
        id: `dismiss:${email}:${body.sessionId}:${body.taskName}`,
        kind: "dismiss",
        email,
        body,
      });
      await this.changed(state);
      return json({ ok: true });
    }
    if (path === "/api/dismissals" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return json({ error: "sessionId required" }, 400);
      const session = findSession(account, sessionId);
      return json({
        dismissed: session?.tasks.filter((task) => task.status === "deferred").map((task) => task.name) ?? [],
      });
    }
    if (path === "/api/session/remove" && request.method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const sessionId = String(body?.sessionId ?? "");
      if (!sessionId) return json({ error: "sessionId required" }, 400);
      removeLive(account, sessionId);
      removeQueuedSessionEvents(state, email, sessionId);
      queue(state, { id: `remove:${email}:${sessionId}`, kind: "remove", email, body });
      await this.changed(state);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  }

  private async requestOtp(request: Request, state: DurableState): Promise<Response> {
    const body: any = await request.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);
    if (!isAllowedEmail(this.env, email)) return json({ ok: true });

    const code = generateOtp();
    state.verifications[email] = { code, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS };
    await this.persist(state);
    try {
      await sendOtpEmail(this.env, email, code);
    } catch (error) {
      return json({ error: "failed to send email", detail: String(error) }, 502);
    }
    return json({ ok: true });
  }

  private async verifyOtp(request: Request, state: DurableState): Promise<Response> {
    const body: any = await request.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    const code = String(body?.code ?? "").trim();
    if (!email || !code) return json({ error: "email and code required" }, 400);

    const verification = state.verifications[email];
    if (!verification) return json({ error: "invalid_code" }, 400);
    if (verification.expiresAt < Date.now()) {
      delete state.verifications[email];
      await this.persist(state);
      return json({ error: "expired" }, 400);
    }
    if (verification.attempts >= OTP_MAX_ATTEMPTS) {
      delete state.verifications[email];
      await this.persist(state);
      return json({ error: "too_many_attempts" }, 429);
    }
    if (verification.code !== code) {
      verification.attempts += 1;
      await this.persist(state);
      return json({ error: "invalid_code" }, 400);
    }

    delete state.verifications[email];
    ensureAccount(state, email);
    const apiKey = generateApiKey();
    const keyHash = await sha256Hex(apiKey);
    state.keys[keyHash] = email;
    queue(state, {
      id: `api-key:${keyHash}`,
      kind: "api-key",
      email,
      body: { id: crypto.randomUUID(), keyHash, prefix: apiKey.slice(0, 11) },
    });
    await this.changed(state);
    return json({ ok: true, email, apiKey });
  }

  private async resolveEmail(request: Request, state: DurableState): Promise<string | null> {
    const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const hash = await sha256Hex(token);
    const known = state.keys[hash];
    if (known) return known;

    if (this.env.BOOTSTRAP_API_KEY && token === this.env.BOOTSTRAP_API_KEY) {
      const email = firstAllowedEmail(this.env.ALLOWED_EMAILS);
      if (!email) return null;
      state.keys[hash] = email;
      ensureAccount(state, email);
      await this.persist(state);
      return email;
    }
    return null;
  }

  private async changed(state: DurableState): Promise<void> {
    await this.persist(state);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ARCHIVE_INTERVAL_MS);
    }
  }

  private load(): Promise<DurableState> {
    return this.ctx.storage.get<DurableState>(STATE_KEY).then((state) => state ?? emptyState());
  }

  private persist(state: DurableState): Promise<void> {
    return this.ctx.storage.put(STATE_KEY, state);
  }

  private async flushArchive(state: DurableState): Promise<void> {
    const events = Object.values(state.archive).sort((a, b) => a.queuedAt - b.queuedAt);
    if (!events.length) return;
    try {
      const db = createDb(this.env.DATABASE_URL);
      for (const email of new Set(events.map((event) => event.email))) {
        await db.insert(accounts).values({ email }).onConflictDoNothing();
      }
      for (const event of events) {
        await archiveEvent(db, event);
        delete state.archive[event.id];
      }
    } catch (error) {
      console.error("[archive] flush failed", error);
    } finally {
      await this.persist(state);
      if (Object.keys(state.archive).length) {
        await this.ctx.storage.setAlarm(Date.now() + ARCHIVE_INTERVAL_MS);
      }
    }
  }
}

function emptyState(): DurableState {
  return { keys: {}, verifications: {}, accounts: {}, archive: {} };
}

function ensureAccount(state: DurableState, email: string) {
  return (state.accounts[email] ??= { machines: {}, version: 0 });
}

function firstAllowedEmail(value?: string): string | null {
  return value?.split(",").map((entry) => entry.trim().toLowerCase()).find(Boolean) ?? null;
}

function queue(
  state: DurableState,
  event: Omit<ArchiveEvent, "queuedAt">,
): void {
  state.archive[event.id] = { ...event, queuedAt: Date.now() };
}

function removeQueuedSessionEvents(state: DurableState, email: string, sessionId: string): void {
  const raw = stripAccount(email, sessionId);
  for (const [id, event] of Object.entries(state.archive)) {
    if (event.email !== email) continue;
    const eventSession = String(event.body?.sessionId ?? event.body?.session?.id ?? "");
    if (eventSession === sessionId || eventSession === raw) delete state.archive[id];
  }
}

function ingestLive(account: DurableState["accounts"][string], email: string, body: any) {
  const machine = body?.machine;
  const session = body?.session;
  if (!machine?.id || !machine?.hostname || !session?.id) {
    return { error: "machine.id, machine.hostname and session.id are required" } as const;
  }
  const now = new Date().toISOString();
  const machineId = `${email}::${machine.id}`;
  const sessionId = `${email}::${session.id}`;
  const liveMachine = (account.machines[machineId] ??= {
    id: machineId,
    hostname: machine.hostname,
    os: machine.os ?? null,
    label: machine.label ?? null,
    firstSeen: now,
    lastSeen: now,
    updatedAt: now,
    sessions: {},
  });
  Object.assign(liveMachine, {
    hostname: machine.hostname,
    os: machine.os ?? null,
    label: machine.label ?? null,
    lastSeen: now,
    updatedAt: now,
  });
  const previous = liveMachine.sessions[sessionId];
  const deferred = new Set(previous?.tasks.filter((task) => task.status === "deferred").map((task) => task.name) ?? []);
  const tasks: LiveTask[] = (Array.isArray(body?.tasks) ? body.tasks : []).map((task: any, position: number) => {
    const name = String(task?.name ?? task?.content ?? "").slice(0, 2000);
    return {
      id: `${sessionId}::${position}`,
      name,
      status: deferred.has(name) ? "deferred" : normalizeTaskStatus(task?.status),
      position,
      createdAt: now,
      updatedAt: now,
    };
  });
  liveMachine.sessions[sessionId] = {
    id: sessionId,
    machineId,
    project: session.project ?? previous?.project ?? null,
    title: session.title ?? previous?.title ?? null,
    status: normalizeSessionStatus(session.status),
    endedReason: null,
    startedAt: previous?.startedAt ?? now,
    lastActivityAt: now,
    updatedAt: now,
    tasks,
  };
  account.version = Date.now();
  return { tasks: tasks.length, dismissed: tasks.filter((task) => task.status === "deferred").map((task) => task.name), machineId, sessionId };
}

function startLive(account: DurableState["accounts"][string], email: string, body: any) {
  const rawMachineId = String(body?.machineId ?? body?.machine?.id ?? "");
  const hostname = String(body?.hostname ?? body?.machine?.hostname ?? rawMachineId);
  const rawSessionId = String(body?.sessionId ?? body?.session?.id ?? "");
  if (!rawMachineId || !rawSessionId) return { error: "machineId and sessionId are required" } as const;
  const now = new Date().toISOString();
  const machineId = `${email}::${rawMachineId}`;
  const sessionId = `${email}::${rawSessionId}`;
  const machine = (account.machines[machineId] ??= {
    id: machineId,
    hostname,
    os: body?.os ?? body?.machine?.os ?? null,
    label: body?.label ?? body?.machine?.label ?? null,
    firstSeen: now,
    lastSeen: now,
    updatedAt: now,
    sessions: {},
  });
  machine.lastSeen = now;
  machine.updatedAt = now;
  const previous = machine.sessions[sessionId];
  machine.sessions[sessionId] = {
    id: sessionId,
    machineId,
    project: body?.project ?? body?.session?.project ?? previous?.project ?? null,
    title: body?.title ?? body?.session?.title ?? previous?.title ?? null,
    status: "active",
    endedReason: null,
    startedAt: previous?.startedAt ?? now,
    lastActivityAt: now,
    updatedAt: now,
    tasks: previous?.tasks ?? [],
  };
  account.version = Date.now();
  return { machineId, sessionId };
}

function endLive(account: DurableState["accounts"][string], email: string, body: any) {
  const rawSessionId = String(body?.sessionId ?? "");
  const rawMachineId = String(body?.machineId ?? body?.machine?.id ?? "");
  if (!rawSessionId && !rawMachineId) return { error: "sessionId or machineId required" } as const;
  let session: LiveSession | undefined;
  if (rawSessionId) {
    session = findSession(account, `${email}::${rawSessionId}`) ?? findSession(account, rawSessionId);
  } else {
    const machine = account.machines[`${email}::${rawMachineId}`];
    session = Object.values(machine?.sessions ?? {})
      .filter((candidate) => candidate.status !== "ended")
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  }
  if (session) {
    session.status = "ended";
    session.endedReason = String(body?.reason ?? "hook");
    session.updatedAt = new Date().toISOString();
  }
  account.version = Date.now();
  return { ended: session?.id ?? null };
}

function dismissLive(account: DurableState["accounts"][string], body: any) {
  const sessionId = String(body?.sessionId ?? "");
  const taskName = String(body?.taskName ?? "");
  if (!sessionId || !taskName) return { error: "sessionId and taskName are required" } as const;
  const session = findSession(account, sessionId);
  if (!session) return { error: "not_found" } as const;
  const task = session.tasks.find((candidate) => candidate.name === taskName);
  if (task) {
    task.status = "deferred";
    task.updatedAt = new Date().toISOString();
  }
  account.version = Date.now();
  return {};
}

function removeLive(account: DurableState["accounts"][string], sessionId: string): void {
  for (const machine of Object.values(account.machines)) {
    delete machine.sessions[sessionId];
  }
  account.version = Date.now();
}

function findSession(account: DurableState["accounts"][string], sessionId: string): LiveSession | undefined {
  for (const machine of Object.values(account.machines)) {
    const session = machine.sessions[sessionId];
    if (session) return session;
  }
  return undefined;
}

function buildLiveTree(account: DurableState["accounts"][string], email: string) {
  return Object.values(account.machines)
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
    .map((machine) => ({
      ...machine,
      sessions: Object.values(machine.sessions)
        .map((session) => ({
          ...session,
          name: sessionName(stripAccount(email, session.id)),
          shortId: stripAccount(email, session.id),
        }))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    }));
}

async function archiveEvent(db: ReturnType<typeof createDb>, event: ArchiveEvent): Promise<void> {
  switch (event.kind) {
    case "api-key":
      await db.insert(apiKeys).values({ ...event.body, email: event.email }).onConflictDoNothing();
      break;
    case "start":
      await startSession(db, event.email, {
        machineId: String(event.body?.machineId ?? event.body?.machine?.id ?? ""),
        hostname: String(event.body?.hostname ?? event.body?.machine?.hostname ?? event.body?.machineId ?? ""),
        os: event.body?.os ?? event.body?.machine?.os ?? null,
        label: event.body?.label ?? event.body?.machine?.label ?? null,
        sessionId: String(event.body?.sessionId ?? event.body?.session?.id ?? ""),
        project: event.body?.project ?? event.body?.session?.project ?? null,
        title: event.body?.title ?? event.body?.session?.title ?? null,
      });
      break;
    case "ingest":
      await ingestSnapshot(db, event.email, event.body);
      break;
    case "dismiss":
      await dismissTask(db, event.email, String(event.body.sessionId), String(event.body.taskName));
      break;
    case "end":
      if (event.body?.sessionId) {
        await endSession(db, event.email, String(event.body.sessionId), String(event.body?.reason ?? "hook"));
      } else {
        await endLatestSession(db, event.email, String(event.body?.machineId ?? event.body?.machine?.id ?? ""), String(event.body?.reason ?? "hook"));
      }
      break;
    case "remove":
      await removeSession(db, event.email, String(event.body.sessionId));
      break;
  }
}

function stripAccount(email: string, id: string): string {
  const prefix = `${email}::`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function normalizeTaskStatus(value: unknown): string {
  const status = String(value ?? "").toLowerCase();
  if (["in_progress", "in-progress", "active", "doing"].includes(status)) return "in_progress";
  if (["completed", "complete", "done"].includes(status)) return "completed";
  if (["cancelled", "canceled", "skipped"].includes(status)) return "cancelled";
  if (["deferred", "dropped", "dismissed"].includes(status)) return "deferred";
  return "pending";
}

function normalizeSessionStatus(value: unknown): string {
  return String(value ?? "").toLowerCase() === "idle" ? "idle" : "active";
}

const ADJECTIVES = ["amber", "brisk", "calm", "clever", "cobalt", "crimson", "dusky", "eager", "fleet", "gentle", "ivory", "jade", "keen", "lively", "mellow", "noble", "opal", "plucky", "quiet", "rapid", "sage", "swift", "teal", "umber", "vivid", "witty", "zesty", "bright", "bold", "lunar"];
const NOUNS = ["otter", "falcon", "cedar", "comet", "delta", "ember", "fjord", "grove", "harbor", "ibis", "jasper", "kestrel", "lynx", "meadow", "nimbus", "onyx", "pinion", "quartz", "raven", "summit", "tundra", "vertex", "willow", "yarrow", "zephyr", "badger", "cove", "drift", "heron", "maple"];

function sessionName(seed: string): string {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${ADJECTIVES[hash % ADJECTIVES.length]}-${NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length]}`;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
