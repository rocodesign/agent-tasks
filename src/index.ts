import { Hono } from "hono";
import { cors } from "hono/cors";
import { LiveState, type Bindings } from "./live-state";

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", cors());
app.get("/health", (c) => c.json({ ok: true }));
app.all("/api/*", (c) => {
  const object = c.env.LIVE_STATE.get(c.env.LIVE_STATE.idFromName("fleet"));
  return object.fetch(c.req.raw);
});
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export { LiveState };
export default { fetch: app.fetch };
