import { createDb } from "./db/client.ts";
import { accounts, apiKeys } from "./db/schema.ts";
import {
  completeTask,
  dismissTask,
  endLatestSession,
  endSession,
  enrichSession,
  titleSession,
  ingestSnapshot,
  listHistorySessions,
  namespaced,
  purgeOldEndedSessions,
  purgeProject,
  reapStaleSessions,
  removeSession,
  startSession,
} from "./store.ts";
import {
  mergeSessionMeta,
  normalizeProvider,
  pickSessionMeta,
  sessionRelation,
  type SessionMeta,
  type SessionProvider,
} from "./session-metadata.ts";
import {
  generateApiKey,
  generateOtp,
  isAllowedEmail,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  sendOtpEmail,
  sha256Hex,
} from "./auth.ts";
import { hasScope, resolveIdentity } from "./identity.ts";
import { deleteSessionKnowledge, projectSlug, writeSessionKnowledge } from "./knowledge.ts";
import { purgeOldEvents } from "./events.ts";
import {
  matchesMachineFilter,
  matchesSessionFilters,
  readSessionFilters,
  type SessionFilters,
} from "./session-filters.ts";

export type Bindings = {
  DB: D1Database;
  KNOWLEDGE: R2Bucket;
  RESEND_API_KEY: string;
  RESEND_FROM?: string;
  ALLOWED_EMAILS?: string;
  BOOTSTRAP_API_KEY?: string;
  SHELL_URL?: string;
  SHELL?: Fetcher;
  AI: Ai;
  AI_SEARCH?: string;
  LIVE_STATE: DurableObjectNamespace;
  ASSETS: Fetcher;
};

type LiveTask = {
  id: string;
  name: string;
  status: string;
  source?: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type LiveSession = SessionMeta & {
  id: string;
  machineId: string;
  project: string | null;
  title: string | null;
  provider: SessionProvider | null;
  summary?: string | null;
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
  kind: "api-key" | "start" | "ingest" | "dismiss" | "complete" | "end" | "remove" | "enrich" | "title";
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

    // Cron-only entry point: the public worker forwards nothing but /api/*, so this
    // path is unreachable from outside and needs no bearer key.
    if (path === "/internal/maintenance" && request.method === "POST") {
      return this.maintenance(state);
    }

    const email = await this.resolveEmail(request, state);
    if (!email) return json({ error: "unauthorized" }, 401);
    const account = ensureAccount(state, email);

    if (path === "/api/version" && request.method === "GET") {
      return json({ version: account.version });
    }
    if (path === "/api/tree" && request.method === "GET") {
      return json({ machines: buildLiveTree(account, email, readSessionFilters(url)) });
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
    if (path === "/api/session/title" && request.method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const result = titleLive(account, email, body);
      if ("error" in result) return json({ error: result.error }, 400);
      queue(state, {
        id: `title:${email}:${String(body?.sessionId)}`,
        kind: "title",
        email,
        body,
      });
      await this.changed(state);
      return json({ ok: true, ...result });
    }
    if (path === "/api/session/enrich" && request.method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const result = enrichLive(account, email, body);
      if ("error" in result) return json({ error: result.error }, 400);
      queue(state, {
        id: `enrich:${email}:${String(body?.sessionId)}`,
        kind: "enrich",
        email,
        body,
      });
      // Enrichment lands after SessionEnd already flushed — flush again promptly so
      // the archive row gets its summary without waiting out the hourly alarm.
      await this.persist(state);
      await this.ctx.storage.setAlarm(Date.now());
      return json({ ok: true, ...result });
    }
    if (path === "/api/history/sessions" && request.method === "GET") {
      return this.historySessions(url, email);
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
    if (path === "/api/task/complete" && request.method === "POST") {
      const body: any = await request.json().catch(() => ({}));
      const result = completeLive(account, email, body);
      if ("error" in result) return json({ error: result.error }, 400);
      queue(state, {
        id: `complete:${email}:${body.sessionId}:${body.taskName}`,
        kind: "complete",
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
    if (path === "/api/project/purge" && request.method === "POST") {
      return this.purgeProject(request, state, email);
    }
    return json({ error: "not_found" }, 404);
  }

  // A drop removes what cannot be rebuilt, so it needs the orchestrate scope rather than
  // the publish scope every other write here takes, and the caller repeats the slug.
  private async purgeProject(request: Request, state: DurableState, email: string): Promise<Response> {
    const identity = await resolveIdentity(this.env, (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!identity || !hasScope(identity, "orchestrate")) {
      return json({ error: "this call needs the fleet orchestrate scope" }, 403);
    }
    const body: any = await request.json().catch(() => ({}));
    const slug = String(body?.project ?? "").trim();
    if (!slug) return json({ error: "project required" }, 400);
    if (String(body?.confirm ?? "") !== slug) {
      return json({ error: "repeat the project in confirm to purge it" }, 400);
    }

    let result;
    try {
      result = await purgeProject(createDb(this.env.DB), this.env.KNOWLEDGE, email, slug);
    } catch (error) {
      return json({ error: "purge_failed", detail: String(error) }, 500);
    }

    const account = ensureAccount(state, email);
    let live = 0;
    for (const machine of Object.values(account.machines)) {
      for (const session of Object.values(machine.sessions)) {
        if (projectSlug(session.projectKey ?? null, session.project) !== slug) continue;
        removeLive(account, session.id);
        removeQueuedSessionEvents(state, email, session.id);
        live += 1;
      }
    }
    // A queued archive write would resurrect a purged session on the next flush.
    for (const [id, event] of Object.entries(state.archive)) {
      if (event.email === email && result.sessions.includes(namespaced(email, String(event.body?.sessionId ?? event.body?.session?.id ?? "")))) {
        delete state.archive[id];
      }
    }
    account.version = Date.now();
    await this.changed(state);
    return json({ ...result, sessions: result.sessions.length, live });
  }

  // Durable session history for the orchestrator: summarized sessions from D1, newest
  // first, with their generated follow-up tasks. Filters: ?project=, ?kind=, ?delegation=,
  // ?machine=, ?since= (ISO date), ?all=1 (include unsummarized), ?limit= (default 50, max 500).
  private async historySessions(url: URL, email: string): Promise<Response> {
    try {
      const rows = await listHistorySessions(createDb(this.env.DB), email, {
        ...readSessionFilters(url),
        since: url.searchParams.get("since"),
        all: url.searchParams.get("all") === "1",
        limit: Number(url.searchParams.get("limit") ?? 50) || 50,
      });
      return json({ sessions: rows.map((row) => ({ ...row, shortId: stripAccount(email, row.id) })) });
    } catch (error) {
      return json({ error: "history_failed", detail: String(error) }, 500);
    }
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

  // A GET reads the live tree and a POST writes to it, so the two fleet scopes map
  // straight onto the method. Keys minted here predate scopes and carry both.
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

    const identity = await resolveIdentity(this.env, token);
    if (!identity) return null;
    if (!hasScope(identity, request.method === "GET" ? "read" : "publish")) return null;
    if (!state.accounts[identity.email]) {
      ensureAccount(state, identity.email);
      await this.persist(state);
    }
    return identity.email;
  }

  // Scheduled maintenance: reap silent sessions and prune the live tree. Codex (and
  // any killed process) never fires SessionEnd, so without this both the DO state and
  // Postgres accumulate "active" sessions forever.
  private async maintenance(state: DurableState): Promise<Response> {
    const pruned = pruneLive(state);
    let reaped = 0;
    let purged = 0;
    try {
      const db = createDb(this.env.DB);
      reaped = (await reapStaleSessions(db)).ended;
      purged = (await purgeOldEndedSessions(db)).removed;
      await purgeOldEvents(db);
    } catch (error) {
      // Postgres maintenance is retried by the next cron; live pruning already ran.
      console.error("[maintenance] postgres pass failed", error);
    }
    await this.flushArchive(state);
    return json({ ok: true, ...pruned, reaped, purged });
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
      const db = createDb(this.env.DB);
      for (const email of new Set(events.map((event) => event.email))) {
        await db.insert(accounts).values({ email }).onConflictDoNothing();
      }
      for (const event of events) {
        await archiveEvent(db, event, this.env);
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
  const provider = normalizeProvider(session.provider ?? body?.provider) ?? previous?.provider ?? null;
  const deferred = new Set(previous?.tasks.filter((task) => task.status === "deferred").map((task) => task.name) ?? []);
  const tasks: LiveTask[] = (Array.isArray(body?.tasks) ? body.tasks : []).map((task: any, position: number) => {
    const name = String(task?.name ?? task?.content ?? "").slice(0, 2000);
    return {
      id: `${sessionId}::${position}`,
      name,
      status: deferred.has(name) ? "deferred" : normalizeTaskStatus(task?.status),
      source: "live",
      position,
      createdAt: now,
      updatedAt: now,
    };
  });
  // Snapshots replace only the live TodoWrite mirror; generated tasks ride along.
  tasks.push(...(previous?.tasks.filter((task) => task.source === "generated") ?? []));
  liveMachine.sessions[sessionId] = {
    ...mergeSessionMeta(previous, session, body),
    id: sessionId,
    machineId,
    project: session.project ?? previous?.project ?? null,
    title: session.title ?? previous?.title ?? null,
    provider,
    summary: previous?.summary ?? null,
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
  const provider = normalizeProvider(body?.provider ?? body?.session?.provider) ?? previous?.provider ?? null;
  machine.sessions[sessionId] = {
    ...mergeSessionMeta(previous, body, body?.session),
    id: sessionId,
    machineId,
    project: body?.project ?? body?.session?.project ?? previous?.project ?? null,
    title: body?.title ?? body?.session?.title ?? previous?.title ?? null,
    provider,
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

// Early title from the first-prompt hook. Fires seconds into a session, so the card
// stops showing the raw session name almost immediately. A digest title (summary
// present) always outranks it, which also covers out-of-order delivery.
function titleLive(account: DurableState["accounts"][string], email: string, body: any) {
  const rawSessionId = String(body?.sessionId ?? "");
  const title = String(body?.title ?? "").slice(0, 300);
  if (!rawSessionId || !title) return { error: "sessionId and title required" } as const;
  const session = findSession(account, `${email}::${rawSessionId}`) ?? findSession(account, rawSessionId);
  if (session && !session.summary) {
    session.title = title;
    session.updatedAt = new Date().toISOString();
    account.version = Date.now();
  }
  return { titled: session?.id ?? null };
}

function enrichLive(account: DurableState["accounts"][string], email: string, body: any) {
  const rawSessionId = String(body?.sessionId ?? "");
  if (!rawSessionId) return { error: "sessionId required" } as const;
  const session = findSession(account, `${email}::${rawSessionId}`) ?? findSession(account, rawSessionId);
  // The session may already be gone from live state (ended cards age out) — that's
  // fine, the archive event still enriches Postgres.
  if (session) {
    const now = new Date().toISOString();
    Object.assign(session, pickSessionMeta(body));
    if (body?.title) session.title = String(body.title).slice(0, 300);
    if (body?.summary) session.summary = String(body.summary).slice(0, 8000);
    if (Array.isArray(body?.tasks)) {
      const settled = new Map(
        session.tasks
          .filter((task) => task.source === "generated" && (task.status === "completed" || task.status === "deferred"))
          .map((task) => [task.name, task.status]),
      );
      session.tasks = session.tasks.filter((task) => task.source !== "generated");
      session.tasks.push(
        ...body.tasks
          .map((task: any, position: number) => {
            const name = String(task?.name ?? task?.content ?? "").slice(0, 2000);
            return {
              id: `${session.id}::gen::${position}`,
              name,
              status: settled.get(name) ?? normalizeTaskStatus(task?.status),
              source: "generated",
              position,
              createdAt: now,
              updatedAt: now,
            };
          })
          .filter((task: LiveTask) => task.name),
      );
    }
    session.updatedAt = now;
    account.version = Date.now();
  }
  return { enriched: session?.id ?? null };
}

function completeLive(account: DurableState["accounts"][string], email: string, body: any) {
  const sessionId = String(body?.sessionId ?? "");
  const taskName = String(body?.taskName ?? "");
  if (!sessionId || !taskName) return { error: "sessionId and taskName are required" } as const;
  const session = findSession(account, `${email}::${sessionId}`) ?? findSession(account, sessionId);
  // Live state drops ended cards after an hour; the archive event still completes the task.
  if (!session) return {};
  const task = session.tasks.find((candidate) => candidate.name === taskName);
  if (task) {
    task.status = "completed";
    task.updatedAt = new Date().toISOString();
  }
  account.version = Date.now();
  return {};
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
  for (const [machineId, machine] of Object.entries(account.machines)) {
    delete machine.sessions[sessionId];
    if (Object.keys(machine.sessions).length === 0) {
      delete account.machines[machineId];
    }
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

// Mirrors the Postgres reaper: a session silent past REAP_AFTER_MS is marked ended,
// and ended cards leave the live tree an hour later (Postgres keeps the durable row).
const LIVE_REAP_AFTER_MS = 45 * 60_000;
const LIVE_DROP_ENDED_AFTER_MS = 60 * 60_000;

function pruneLive(state: DurableState) {
  const now = Date.now();
  let reapedLive = 0;
  let droppedLive = 0;
  for (const account of Object.values(state.accounts)) {
    let changed = 0;
    for (const [machineId, machine] of Object.entries(account.machines)) {
      for (const [sessionId, session] of Object.entries(machine.sessions)) {
        const lastActivity = Date.parse(session.lastActivityAt ?? session.updatedAt) || 0;
        if (session.status !== "ended" && now - lastActivity > LIVE_REAP_AFTER_MS) {
          session.status = "ended";
          session.endedReason = "reaper";
          session.updatedAt = new Date().toISOString();
          reapedLive += 1;
          changed += 1;
        } else if (session.status === "ended" && now - (Date.parse(session.updatedAt) || 0) > LIVE_DROP_ENDED_AFTER_MS) {
          delete machine.sessions[sessionId];
          droppedLive += 1;
          changed += 1;
        }
      }
      if (Object.keys(machine.sessions).length === 0) delete account.machines[machineId];
    }
    if (changed) account.version = Date.now();
  }
  return { reapedLive, droppedLive };
}

function buildLiveTree(account: DurableState["accounts"][string], email: string, filters: SessionFilters) {
  return Object.values(account.machines)
    .filter((machine) => matchesMachineFilter(machine, email, filters.machine))
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
    .map((machine) => ({
      ...machine,
      sessions: Object.values(machine.sessions)
        .filter((session) => matchesSessionFilters(session, filters))
        .map((session) => ({
          ...session,
          provider: session.provider ?? null,
          name: sessionName(stripAccount(email, session.id)),
          shortId: stripAccount(email, session.id),
          ...sessionRelation(session.id),
        }))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    }))
    .filter((machine) => machine.sessions.length > 0);
}

async function archiveEvent(db: ReturnType<typeof createDb>, event: ArchiveEvent, env: Bindings): Promise<void> {
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
        provider: event.body?.provider ?? event.body?.session?.provider ?? null,
        meta: pickSessionMeta(event.body, event.body?.session),
      });
      break;
    case "ingest":
      await ingestSnapshot(db, event.email, event.body);
      break;
    case "dismiss":
      await dismissTask(db, event.email, String(event.body.sessionId), String(event.body.taskName));
      break;
    case "complete":
      await completeTask(db, event.email, String(event.body.sessionId), String(event.body.taskName));
      break;
    case "end":
      if (event.body?.sessionId) {
        await endSession(db, event.email, String(event.body.sessionId), String(event.body?.reason ?? "hook"));
      } else {
        await endLatestSession(db, event.email, String(event.body?.machineId ?? event.body?.machine?.id ?? ""), String(event.body?.reason ?? "hook"));
      }
      break;
    case "remove":
      if (env.KNOWLEDGE) await deleteSessionKnowledge(db, env.KNOWLEDGE, event.email, String(event.body.sessionId));
      await removeSession(db, event.email, String(event.body.sessionId));
      break;
    case "enrich": {
      const enriched = await enrichSession(db, event.email, event.body);
      if (enriched.enriched && env.KNOWLEDGE) {
        await writeSessionKnowledge(db, env.KNOWLEDGE, event.email, enriched.enriched, event.body);
      }
      break;
    }
    case "title":
      await titleSession(db, event.email, event.body);
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
