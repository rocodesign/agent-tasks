import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { LiveState, type Bindings } from "./live-state.ts";
import { runSearch, scopeSearch } from "./search.ts";
import { hasScope, reachesProject, resolveIdentity, type FleetScope, type Identity } from "./identity.ts";
import { createDb } from "./db/client.ts";
import {
  ASSIGNMENT_PRODUCER,
  assignmentAge,
  CLAIM_WINDOW_MS,
  DEPUTY_TYPES,
  listEvents,
  MAX_BODY,
  MAX_RECIPIENTS,
  ORCHESTRATOR_TYPES,
  POST_TYPES,
  publishEvent,
} from "./events.ts";
import { assignLaunch, LaunchConflict, MAX_PROMPT, readLaunchPrompt } from "./launch.ts";
import { MachineRelay } from "./machine-relay.ts";
import { relayRole } from "./relay.ts";

const MACHINE_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

const app = new Hono<{ Bindings: Bindings }>();

const bearer = (header?: string) => (header ?? "").replace(/^Bearer\s+/i, "");
// One credential vocabulary for every caller: a shell JWT, a service token, or a legacy
// api key all arrive here as an identity carrying fleet scopes.
async function identify(c: Context<{ Bindings: Bindings }>, scope: FleetScope): Promise<Identity | Response> {
  const identity = await resolveIdentity(c.env, bearer(c.req.header("authorization")));
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  if (!hasScope(identity, scope)) return c.json({ error: `this call needs the fleet ${scope} scope` }, 403);
  return identity;
}
// delegation.assigned is missing on purpose: an assignment exists only through /api/launch,
// where the prompt and the launch identity are checked.
const POSTABLE = [...POST_TYPES, ...DEPUTY_TYPES, ...ORCHESTRATOR_TYPES] as readonly string[];

app.use("/api/*", cors());
app.get("/health", (c) => c.json({ ok: true }));
// Search runs outside the Durable Object: the object serializes every request, and a
// retrieval call would block session writes for its whole duration.
app.post("/api/search", async (c) => {
  const identity = await identify(c, "read");
  if (identity instanceof Response) return identity;
  const body = await c.req.json().catch(() => ({}) as any);
  if (!body?.query) return c.json({ error: "query is required" }, 400);
  const scoped = scopeSearch(body, identity.projects);
  if (!scoped.ok) return c.json({ error: scoped.error }, scoped.status);
  try {
    return c.json(await runSearch(c.env, scoped.request));
  } catch (error: any) {
    return c.json({ error: "search_failed", detail: String(error?.message ?? error) }, 500);
  }
});
// The event stream runs beside search, outside the Durable Object, for the same reason:
// a subscriber polling must never queue behind a session write.
app.post("/api/events", async (c) => {
  const identity = await identify(c, "publish");
  if (identity instanceof Response) return identity;
  const body = await c.req.json().catch(() => ({}) as any);
  const project = String(body?.project ?? "").trim();
  const type = String(body?.type ?? "").trim();
  const text = String(body?.body ?? "").trim();
  const producer = String(body?.producer ?? "").trim();
  const eventKey = String(body?.eventKey ?? "").trim();
  if (!project || !producer || !eventKey || !text) return c.json({ error: "project, producer, eventKey and body are required" }, 400);
  if (!reachesProject(identity, project)) {
    return c.json({ error: `this credential cannot write to the project ${project}` }, 403);
  }
  if (!POSTABLE.includes(type)) return c.json({ error: `type must be one of ${POSTABLE.join(", ")}` }, 400);
  if ((ORCHESTRATOR_TYPES as readonly string[]).includes(type) && !hasScope(identity, "orchestrate")) {
    return c.json({ error: "this type needs the fleet orchestrate scope" }, 403);
  }
  // The assignment producer is reserved, or an ordinary post could take the key an
  // assignment needs and make the real assignment look like a duplicate.
  if (producer === ASSIGNMENT_PRODUCER) return c.json({ error: `producer ${ASSIGNMENT_PRODUCER} is reserved` }, 403);
  if (text.length > MAX_BODY) return c.json({ error: "body too large" }, 413);
  if (/```/.test(text)) return c.json({ error: "the stream carries prose, not code" }, 400);
  const db = createDb(c.env.DB);
  // A claim is answered against this clock, not the machine's: a deputy that was offline
  // for a day would otherwise read its own stale time and start reassigned work.
  if (type === "launch.claimed") {
    const age = await assignmentAge(db, identity.email, String(body?.launch ?? ""));
    if (age === null) return c.json({ error: "no such assignment" }, 404);
    if (age > CLAIM_WINDOW_MS) return c.json({ error: "the assignment expired" }, 409);
  }
  try {
    const result = await publishEvent(db, {
      accountEmail: identity.email,
      project,
      type,
      producer,
      eventKey,
      sessionId: body?.sessionId ?? null,
      delegation: body?.delegation ?? null,
      machineId: body?.machineId ?? null,
      recipient: body?.recipient ?? null,
      launch: body?.launch ?? null,
      replyTo: body?.replyTo ?? null,
      body: text,
    });
    return c.json(result, result.duplicate ? 200 : 201);
  } catch (error: any) {
    return c.json({ error: "publish_failed", detail: String(error?.message ?? error), retryable: true }, 503);
  }
});

// Assigning work is one call so the prompt always reaches R2 before the event that names
// it. The launch id is the idempotency key, so a repeat returns the first assignment.
app.post("/api/launch", async (c) => {
  const identity = await identify(c, "orchestrate");
  if (identity instanceof Response) return identity;
  const body = await c.req.json().catch(() => ({}) as any);
  const project = String(body?.project ?? "").trim();
  const machine = String(body?.machine ?? "").trim();
  const launchId = String(body?.launchId ?? "").trim();
  const prompt = String(body?.prompt ?? "");
  if (!project || !machine || !launchId || !prompt.trim()) {
    return c.json({ error: "launchId, project, machine and prompt are required" }, 400);
  }
  if (!reachesProject(identity, project)) {
    return c.json({ error: `this credential cannot assign work in the project ${project}` }, 403);
  }
  if (prompt.length > MAX_PROMPT) return c.json({ error: "prompt too large" }, 413);
  try {
    const result = await assignLaunch(createDb(c.env.DB), c.env.KNOWLEDGE, identity.email, {
      launchId,
      project,
      machine,
      prompt,
      delegation: body?.delegation ?? null,
      cwd: body?.cwd ?? null,
    });
    return c.json(result, result.duplicate ? 200 : 201);
  } catch (error: any) {
    if (error instanceof LaunchConflict) return c.json({ error: error.message }, error.status as 400 | 409 | 413);
    return c.json({ error: "assign_failed", detail: String(error?.message ?? error), retryable: true }, 503);
  }
});

app.get("/api/launch/:id/prompt", async (c) => {
  const identity = await identify(c, "read");
  if (identity instanceof Response) return identity;
  const prompt = await readLaunchPrompt(c.env.KNOWLEDGE, c.req.param("id"));
  if (prompt === null) return c.json({ error: "not found" }, 404);
  return c.text(prompt, 200, { "content-type": "text/markdown; charset=utf-8" });
});

app.get("/api/events", async (c) => {
  const identity = await identify(c, "read");
  if (identity instanceof Response) return identity;
  const project = (c.req.query("project") ?? "").trim();
  const list = (name: string) => (c.req.query(name) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const recipients = list("recipient");
  const launches = list("launch");
  if (!project && !recipients.length) return c.json({ error: "project or recipient is required" }, 400);
  if (project && recipients.length) return c.json({ error: "a recipient query cannot also filter by project" }, 400);
  if (recipients.length > MAX_RECIPIENTS) return c.json({ error: `at most ${MAX_RECIPIENTS} recipients` }, 400);
  if (project && !reachesProject(identity, project)) {
    return c.json({ error: `this credential cannot read the project ${project}` }, 403);
  }
  try {
    const page = await listEvents(createDb(c.env.DB), identity.email, {
      project: project || undefined,
      recipients,
      launches,
      projects: identity.projects,
      after: Number(c.req.query("after") ?? 0) || 0,
      limit: Number(c.req.query("limit") ?? 50) || 50,
    });
    return c.json({ project: project || null, recipients, launches, ...page });
  } catch (error: any) {
    // A failed query must never look like an empty stream: the cursor would advance past unseen rows.
    return c.json({ error: "read_failed", detail: String(error?.message ?? error), retryable: true }, 503);
  }
});

// The console reaches a machine's Codex app server through this socket. Fleet carries the
// frames and stores none of them: a thread and its transcript live on the machine.
async function relay(c: Context<{ Bindings: Bindings }>, asked: string | null) {
  const role = relayRole(c.req.query("role"));
  const identity = await identify(c, role === "source" ? "publish" : "read");
  if (identity instanceof Response) return identity;

  // A deputy never names its own machine. Its token already does, and a name in the path
  // could only ever disagree with it. A person's token names no machine, so nobody can
  // pose as a deputy from the browser.
  const machine = role === "source" ? identity.machine : asked;
  if (!machine) {
    return c.json({ error: role === "source" ? "this token names no machine" : "name a machine" }, 403);
  }
  if (!MACHINE_SHAPE.test(machine)) return c.json({ error: "that is not a machine name" }, 400);

  // The relay is addressed by machine, and the app server has no idea what a project is,
  // so a narrowed credential cannot be held to its list once a frame is through.
  if (role === "client" && identity.projects !== null) {
    return c.json({ error: "a project-scoped credential cannot open a machine relay" }, 403);
  }
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "this route takes a websocket" }, 426);
  }

  const object = c.env.RELAY.get(c.env.RELAY.idFromName(`${identity.email}::${machine}`));
  // The handshake must stay the request the runtime built. Upgrade and Sec-WebSocket-Key
  // are forbidden header names, so copying the fields into a fresh Request loses them.
  const forwarded = new Request(c.req.raw);
  forwarded.headers.set("upgrade", "websocket");
  forwarded.headers.set("connection", "Upgrade");
  forwarded.headers.set("x-relay-role", role);
  forwarded.headers.set("x-relay-machine", machine);
  forwarded.headers.set("x-relay-scopes", identity.scopes.join(","));
  return object.fetch(forwarded);
}

app.get("/api/relay", (c) => relay(c, null));
app.get("/api/relay/:machine", (c) => relay(c, c.req.param("machine")));

app.all("/api/*", (c) => {
  const object = c.env.LIVE_STATE.get(c.env.LIVE_STATE.idFromName("fleet"));
  return object.fetch(c.req.raw);
});
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export { LiveState, MachineRelay };
export default {
  fetch: app.fetch,
  // Cron: reap silent sessions (Codex never fires SessionEnd), prune the live tree,
  // and flush the archive queue. /internal/* is not reachable through fetch above.
  scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const object = env.LIVE_STATE.get(env.LIVE_STATE.idFromName("fleet"));
    ctx.waitUntil(object.fetch(new Request("https://live-state/internal/maintenance", { method: "POST" })));
  },
};
