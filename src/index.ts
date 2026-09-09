import { Hono } from "hono";
import { cors } from "hono/cors";
import { LiveState, type Bindings } from "./live-state.ts";
import { resolveKeyEmail, runSearch } from "./search.ts";

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", cors());
app.get("/health", (c) => c.json({ ok: true }));
// Search runs outside the Durable Object: the object serializes every request, and a
// retrieval call would block session writes for its whole duration.
app.post("/api/search", async (c) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const email = await resolveKeyEmail(c.env, token);
  if (!email) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}) as any);
  if (!body?.query) return c.json({ error: "query is required" }, 400);
  try {
    return c.json(await runSearch(c.env, body));
  } catch (error: any) {
    return c.json({ error: "search_failed", detail: String(error?.message ?? error) }, 500);
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
