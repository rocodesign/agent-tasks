import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq } from "drizzle-orm";
import { createDb } from "./db/client";
import { accounts, apiKeys, verification } from "./db/schema";
import {
  ingestSnapshot,
  buildTree,
  computeVersion,
  dismissTask,
  listDismissals,
  endSession,
  endLatestSession,
  startSession,
  removeSession,
  reapStaleSessions,
  purgeOldEndedSessions,
} from "./store";
import {
  isAllowedEmail,
  generateOtp,
  generateApiKey,
  sha256Hex,
  sendOtpEmail,
  resolveApiKey,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
} from "./auth";

type Bindings = {
  DATABASE_URL: string;
  RESEND_API_KEY: string;
  RESEND_FROM?: string;
  ALLOWED_EMAILS?: string;
  ASSETS: Fetcher;
};
type Variables = { email: string };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("/api/*", cors());

// ---- API key auth for data endpoints (auth routes excluded) ---------------
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  const db = createDb(c.env.DATABASE_URL);
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const email = await resolveApiKey(db, token);
  if (!email) return c.json({ error: "unauthorized" }, 401);
  c.set("email", email);
  await next();
});

// ---- Public ---------------------------------------------------------------
app.get("/health", (c) => c.json({ ok: true }));

// ---- Auth: email OTP -> minted API key ------------------------------------
app.post("/api/auth/request-otp", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return c.json({ error: "valid email required" }, 400);

  // Fail closed + don't leak which emails are allowed: always return ok.
  if (!isAllowedEmail(c.env, email)) return c.json({ ok: true });

  const code = generateOtp();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  await db
    .insert(verification)
    .values({ identifier: email, value: `${code}:0`, expiresAt, createdAt: now })
    .onConflictDoUpdate({ target: verification.identifier, set: { value: `${code}:0`, expiresAt, createdAt: now } });

  try {
    await sendOtpEmail(c.env, email, code);
  } catch (e) {
    return c.json({ error: "failed to send email", detail: String(e) }, 502);
  }
  return c.json({ ok: true });
});

app.post("/api/auth/verify-otp", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body?.email ?? "").trim().toLowerCase();
  const code = String(body?.code ?? "").trim();
  if (!email || !code) return c.json({ error: "email and code required" }, 400);

  const rows = await db.select().from(verification).where(eq(verification.identifier, email)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "invalid_code" }, 400);

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(verification).where(eq(verification.identifier, email));
    return c.json({ error: "expired" }, 400);
  }

  const [stored, attemptsStr] = row.value.split(":");
  const attempts = parseInt(attemptsStr ?? "0", 10) || 0;
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await db.delete(verification).where(eq(verification.identifier, email));
    return c.json({ error: "too_many_attempts" }, 429);
  }
  if (stored !== code) {
    await db.update(verification).set({ value: `${stored}:${attempts + 1}` }).where(eq(verification.identifier, email));
    return c.json({ error: "invalid_code" }, 400);
  }

  // Success: consume code, ensure account, mint an API key (shown once).
  await db.delete(verification).where(eq(verification.identifier, email));
  await db.insert(accounts).values({ email }).onConflictDoNothing();
  const key = generateApiKey();
  const keyHash = await sha256Hex(key);
  await db.insert(apiKeys).values({ id: crypto.randomUUID(), email, keyHash, prefix: key.slice(0, 11) });

  return c.json({ ok: true, email, apiKey: key });
});

// ---- Ingest (account-scoped) ----------------------------------------------
app.post("/api/ingest", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => null);
  const out = await ingestSnapshot(db, c.get("email"), body);
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ ok: true, ...out.result });
});

// ---- Dismiss --------------------------------------------------------------
app.post("/api/dismiss", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body?.sessionId ?? "");
  const taskName = String(body?.taskName ?? "");
  if (!sessionId || !taskName) return c.json({ error: "sessionId and taskName are required" }, 400);
  const r = await dismissTask(db, c.get("email"), sessionId, taskName);
  if (r.error) return c.json({ error: r.error }, 404);
  return c.json({ ok: true });
});

app.get("/api/dismissals", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  return c.json({ dismissed: await listDismissals(db, c.get("email"), sessionId) });
});

// ---- Version + Tree -------------------------------------------------------
app.get("/api/version", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  return c.json({ version: await computeVersion(db, c.get("email")) });
});

app.get("/api/tree", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  return c.json({ machines: await buildTree(db, c.get("email")) });
});

// Register a session up front (e.g. from a SessionStart hook) so it shows on the
// dashboard immediately, even before any task is reported.
app.post("/api/session/start", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const machineId = String(body?.machineId ?? body?.machine?.id ?? "");
  const hostname = String(body?.hostname ?? body?.machine?.hostname ?? machineId);
  const sessionId = String(body?.sessionId ?? body?.session?.id ?? "");
  if (!machineId || !sessionId) return c.json({ error: "machineId and sessionId are required" }, 400);
  const out = await startSession(db, c.get("email"), {
    machineId,
    hostname,
    os: body?.os ?? body?.machine?.os ?? null,
    label: body?.label ?? body?.machine?.label ?? null,
    sessionId,
    project: body?.project ?? body?.session?.project ?? null,
    title: body?.title ?? body?.session?.title ?? null,
  });
  return c.json({ ok: true, ...out });
});

// End a session. Pass `sessionId` for a specific one, or `machineId` to end the
// most-recently-active session on that machine (used by the SessionEnd hook).
app.post("/api/session/end", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body?.sessionId ?? "");
  const machineId = String(body?.machineId ?? body?.machine?.id ?? "");
  const reason = String(body?.reason ?? "hook");
  if (sessionId) {
    await endSession(db, c.get("email"), sessionId, reason);
    return c.json({ ok: true });
  }
  if (machineId) {
    const r = await endLatestSession(db, c.get("email"), machineId, reason);
    return c.json({ ok: true, ended: r.ended });
  }
  return c.json({ error: "sessionId or machineId required" }, 400);
});

// Remove a card from the dashboard now (deletes the session + its tasks).
app.post("/api/session/remove", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const body = await c.req.json().catch(() => ({}));
  const sessionId = String(body?.sessionId ?? "");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  await removeSession(db, c.get("email"), sessionId);
  return c.json({ ok: true });
});

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// ---- Static UI (SPA) ------------------------------------------------------
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---- Scheduled reaper (cron; see [triggers] in wrangler.toml) --------------
// Sessions only become "ended" when a SessionEnd hook says so. A process that's
// killed/headless can't do that, so without
// this they'd sit "active" forever. This sweep ends silent sessions and purges old ones.
async function scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
  ctx.waitUntil(
    (async () => {
      const db = createDb(env.DATABASE_URL);
      const reaped = await reapStaleSessions(db);
      const purged = await purgeOldEndedSessions(db);
      console.log(`[reaper] ended ${reaped.ended} stale session(s), purged ${purged.removed} old`);
    })(),
  );
}

export default { fetch: app.fetch, scheduled };
