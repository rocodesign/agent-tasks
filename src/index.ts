import { Hono } from "hono";
import { cors } from "hono/cors";
import { LiveState, type Bindings } from "./live-state.ts";
import { resolveKeyEmail, runSearch } from "./search.ts";
import { createDb } from "./db/client.ts";
import { listEvents, publishEvent, MAX_BODY, POST_TYPES } from "./events.ts";

const app = new Hono<{ Bindings: Bindings }>();

const bearer = (header?: string) => (header ?? "").replace(/^Bearer\s+/i, "");

app.use("/api/*", cors());
app.get("/health", (c) => c.json({ ok: true }));
// Search runs outside the Durable Object: the object serializes every request, and a
// retrieval call would block session writes for its whole duration.
app.post("/api/search", async (c) => {
  const email = await resolveKeyEmail(c.env, bearer(c.req.header("authorization")));
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  if (!body?.query) return c.json({ error: "query is required" }, 400);
  try {
    return c.json(await runSearch(c.env, body));
  } catch (error: any) {
    return c.json({ error: "search_failed", detail: String(error?.message ?? error) }, 500);
  }
});
// The event stream runs beside search, outside the Durable Object, for the same reason:
// a subscriber polling must never queue behind a session write.
app.post("/api/events", async (c) => {
  const email = await resolveKeyEmail(c.env, bearer(c.req.header("authorization")));
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  const project = String(body?.project ?? "").trim();
  const type = String(body?.type ?? "").trim();
  const text = String(body?.body ?? "").trim();
  const producer = String(body?.producer ?? "").trim();
  const eventKey = String(body?.eventKey ?? "").trim();
  if (!project || !producer || !eventKey || !text) return c.json({ error: "project, producer, eventKey and body are required" }, 400);
  if (!(POST_TYPES as readonly string[]).includes(type)) return c.json({ error: `type must be one of ${POST_TYPES.join(", ")}` }, 400);
  if (text.length > MAX_BODY) return c.json({ error: "body too large" }, 413);
  if (/```/.test(text)) return c.json({ error: "the stream carries prose, not code" }, 400);
  try {
    const result = await publishEvent(createDb(c.env.DB), {
      accountEmail: email,
      project,
      type,
      producer,
      eventKey,
      sessionId: body?.sessionId ?? null,
      delegation: body?.delegation ?? null,
      machineId: body?.machineId ?? null,
      recipient: body?.recipient ?? null,
      replyTo: body?.replyTo ?? null,
      body: text,
    });
    return c.json(result, result.duplicate ? 200 : 201);
  } catch (error: any) {
    return c.json({ error: "publish_failed", detail: String(error?.message ?? error), retryable: true }, 503);
  }
});

app.get("/api/events", async (c) => {
  const email = await resolveKeyEmail(c.env, bearer(c.req.header("authorization")));
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const project = (c.req.query("project") ?? "").trim();
  if (!project) return c.json({ error: "project is required" }, 400);
  try {
    const page = await listEvents(createDb(c.env.DB), email, {
      project,
      after: Number(c.req.query("after") ?? 0) || 0,
      limit: Number(c.req.query("limit") ?? 50) || 50,
    });
    return c.json({ project, ...page });
  } catch (error: any) {
    // A failed query must never look like an empty stream: the cursor would advance past unseen rows.
    return c.json({ error: "read_failed", detail: String(error?.message ?? error), retryable: true }, 503);
  }
});

app.all("/api/*", (c) => {
  const object = c.env.LIVE_STATE.get(c.env.LIVE_STATE.idFromName("fleet"));
  return object.fetch(c.req.raw);
});
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export { LiveState };
export default {
  fetch: app.fetch,
  // Cron: reap silent sessions (Codex never fires SessionEnd), prune the live tree,
  // and flush the archive queue. /internal/* is not reachable through fetch above.
  scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const object = env.LIVE_STATE.get(env.LIVE_STATE.idFromName("fleet"));
    ctx.waitUntil(object.fetch(new Request("https://live-state/internal/maintenance", { method: "POST" })));
  },
};
