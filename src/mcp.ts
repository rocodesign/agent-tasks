import type { Context } from "hono";
import { createDb } from "./db/client";
import { resolveApiKey } from "./auth";
import {
  ingestSnapshot,
  listSessionTasks,
  updateTaskStatus,
  endSession,
  latestActiveRawSession,
  setSessionTitle,
  buildTree,
} from "./store";

// Minimal, STATELESS MCP over Streamable HTTP (JSON-RPC 2.0), hosted on the Worker.
// Bound to ONE session via headers (X-Agent-Session-Id, X-Agent-Machine[-Id]); tools
// read/write only that session's tasks. Same per-account Bearer API key as the rest.
//
// (Future: an orchestrator role could add a fleet-wide read across sessions — not
// available yet.)

const PROTOCOL_VERSION = "2024-11-05";
const ICON: Record<string, string> = { completed: "✓", in_progress: "◉", cancelled: "✕", deferred: "⊘", pending: "◷" };

const REMOTE_INSTRUCTIONS = `This hosted server records what you're working on to the agent-tasks dashboard,
scoped to your current session.

START IMMEDIATELY — as soon as you begin working on ANY request, before doing anything
else, create at least one task and call report_tasks. This applies even when your first
step is to ask the user for clarification or more details: "ask the user about X" is
itself a task — report it first. Never take an action that isn't reflected by a reported
task; add the task, then act, and refine the list as the work unfolds.

- Extract your work into a concrete, named task list. Use report_tasks to set the full
  list (snapshot), update_task to change one task, list_tasks to read them back.
- Name the session with set_session_name so the card shows what you're working on (the
  project is detected automatically); rename it as the focus shifts.
- Mirror your internal TodoWrite widget exactly: same names + statuses, one task
  in_progress at a time. Send full snapshots, not deltas.
- If a result says the user DEFERRED a task, stop working on it and remove it.
- Call end_session when finished.

If the connection has no session/machine headers, pass session (and machine, for
report_tasks) in the tool arguments instead.`;

const TASK_ITEM = {
  type: "object",
  required: ["name", "status"],
  properties: {
    name: { type: "string", description: "Task name — identical to your internal todo item" },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
  },
};

const TOOL_DEFS = [
  {
    name: "report_tasks",
    description:
      "Set this session's task list (full snapshot). Session + machine come from the connection headers; " +
      "pass them in args only if the connection has none.",
    inputSchema: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: { type: "array", items: TASK_ITEM },
        session: {
          type: "object",
          properties: {
            id: { type: "string" },
            project: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["active", "idle", "ended"] },
          },
        },
        machine: {
          type: "object",
          properties: { id: { type: "string" }, hostname: { type: "string" }, os: { type: "string" }, label: { type: "string" } },
        },
      },
    },
  },
  {
    name: "update_task",
    description: "Update the status of one task in this session by name.",
    inputSchema: {
      type: "object",
      required: ["name", "status"],
      properties: {
        name: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
        sessionId: { type: "string", description: "Only needed if no session header is set" },
      },
    },
  },
  {
    name: "list_tasks",
    description: "List the tasks registered to this session (only this session's tasks).",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } } },
  },
  {
    name: "end_session",
    description: "Mark this session as ended (keeps its tasks).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, session: { type: "object", properties: { id: { type: "string" } } } },
    },
  },
  {
    name: "set_session_name",
    description:
      "Set a short, human-friendly name for this session — shown as the card title on the dashboard. " +
      "Use it to label what you're working on (e.g. 'Refactor auth flow'). The project is detected " +
      "automatically; this overrides it. Rename as the focus shifts.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Short session label" },
        sessionId: { type: "string", description: "Only needed if no machine header is set" },
      },
    },
  },
  {
    name: "view_fleet",
    description:
      "Read-only: list ALL cards across your whole account (every machine → session → tasks), " +
      "not just the current session. Use it to investigate the fleet or debug cross-session issues.",
    inputSchema: { type: "object", properties: {} },
  },
];

type Ctx = { explicitSessionId: string; machineId: string; hostname: string };

export async function handleMcp(c: Context): Promise<Response> {
  const db = createDb((c.env as any).DATABASE_URL);
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const email = await resolveApiKey(db, token);
  if (!email) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, 401);

  const ctx: Ctx = {
    // Honor an explicit session header if a client sets one; the server-assigned
    // Mcp-Session-Id is intentionally NOT used for binding (it can't match the hook's
    // session). Tools resolve the session from the machine instead.
    explicitSessionId: c.req.header("X-Agent-Session-Id") || c.req.header("X-Agent-Session") || "",
    machineId: c.req.header("X-Agent-Machine-Id") || c.req.header("X-Agent-Machine") || "",
    hostname: c.req.header("X-Agent-Hostname") || c.req.header("X-Agent-Machine") || "",
  };

  const msg = await c.req.json().catch(() => null);
  if (!msg || msg.jsonrpc !== "2.0") {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }, 400);
  }
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      // Assign a per-connection session id; the client echoes it back as Mcp-Session-Id
      // on subsequent requests, giving automatic per-session grouping (falls back to a
      // model-supplied session.id if the client doesn't echo it).
      // The session itself is created by the SessionStart hook (with project + title);
      // we just hand back a protocol session id for the connection.
      const newSessionId = crypto.randomUUID();
      return c.json(
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "agent-tasks", version: "0.1.0" },
            instructions: REMOTE_INSTRUCTIONS,
          },
        },
        200,
        { "Mcp-Session-Id": newSessionId },
      );
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return c.body(null, 202);

    case "ping":
      return c.json({ jsonrpc: "2.0", id, result: {} });

    case "tools/list":
      return c.json({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } });

    case "tools/call":
      return c.json({ jsonrpc: "2.0", id, result: await callTool(db, email, ctx, params?.name, params?.arguments ?? {}) });

    default:
      return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const errText = (t: string) => ({ isError: true, content: [{ type: "text", text: t }] });

// Resolve which session a tool acts on. Explicit id wins; otherwise the machine's
// most-recently-active session (the one the SessionStart hook created).
async function resolveRawSession(db: any, email: string, ctx: Ctx, args: any): Promise<string | null> {
  const explicit = ctx.explicitSessionId || args?.session?.id || args?.sessionId;
  if (explicit) return explicit;
  const machineId = ctx.machineId || ctx.hostname || args?.machine?.id;
  if (!machineId) return null;
  return await latestActiveRawSession(db, email, machineId);
}

async function callTool(db: any, email: string, ctx: Ctx, name: string, args: any) {
  if (name === "report_tasks") {
    const machineId = ctx.machineId || ctx.hostname || args?.machine?.id;
    const host = ctx.hostname || ctx.machineId || args?.machine?.hostname;
    if (!machineId || !host) return errText("machine required (set X-Agent-Machine header or pass machine.id + hostname)");
    // Attach to the machine's active session (created by the SessionStart hook) so tasks,
    // project and title share one card. Fall back to an explicit id, then a fresh one.
    const sid = (await resolveRawSession(db, email, ctx, args)) ?? crypto.randomUUID();
    const body = {
      machine: { id: machineId, hostname: host, os: args?.machine?.os ?? null, label: args?.machine?.label ?? null },
      session: { id: sid, project: args?.session?.project ?? null, title: args?.session?.title ?? null, status: args?.session?.status ?? "active" },
      tasks: Array.isArray(args?.tasks) ? args.tasks : [],
    };
    const out = await ingestSnapshot(db, email, body);
    if ("error" in out) return errText(out.error);
    const note = out.result.dismissed.length
      ? `\n\n⚠️ The user DEFERRED: ${out.result.dismissed.map((d) => `"${d}"`).join(", ")}. Stop working on them and remove them.`
      : "";
    return text(`Reported ${out.result.tasks} tasks for this session.${note}`);
  }

  if (name === "update_task") {
    const sid = await resolveRawSession(db, email, ctx, args);
    if (!sid) return errText("no active session on this machine");
    if (!args?.name || !args?.status) return errText("name and status are required");
    const r = await updateTaskStatus(db, email, sid, args.name, args.status);
    if (r.error) return errText(r.error);
    return text(r.deferred ? `"${args.name}" was deferred by the user — leave it dropped.` : `Updated "${args.name}" → ${r.status}.`);
  }

  if (name === "list_tasks") {
    const sid = await resolveRawSession(db, email, ctx, args);
    if (!sid) return errText("no active session on this machine");
    const tasks = await listSessionTasks(db, email, sid);
    if (!tasks.length) return text("No tasks for this session yet.");
    return text(tasks.map((t: any) => `${ICON[t.status] ?? "·"} ${t.name}`).join("\n"));
  }

  if (name === "end_session") {
    const sid = await resolveRawSession(db, email, ctx, args);
    if (!sid) return errText("no active session on this machine");
    await endSession(db, email, sid);
    return text("Session marked ended.");
  }

  if (name === "set_session_name") {
    if (!args?.name) return errText("name is required");
    const sid = await resolveRawSession(db, email, ctx, args);
    if (!sid) return errText("no active session on this machine");
    const r = await setSessionTitle(db, email, sid, String(args.name));
    if (r.error) return errText(r.error);
    return text(`Session named "${args.name}".`);
  }

  if (name === "view_fleet") return await viewFleet(db, email);

  return errText(`unknown tool: ${name}`);
}

// Read-only fleet view across the whole account — for investigation/debugging.
// Surfaces every session's raw id, status, project/title/name and tasks so collisions
// (two sessions on one card, missing project, etc.) are visible at a glance.
async function viewFleet(db: any, email: string) {
  const machines = await buildTree(db, email);
  if (!machines.length) return text("No machines reporting.");
  const lines: string[] = [];
  for (const m of machines) {
    const label = m.label ? ` (${m.label})` : "";
    lines.push(`▸ ${m.hostname}${label} — ${m.sessions.length} session(s)`);
    for (const s of m.sessions) {
      const head = s.title || baseName(s.project) || s.name;
      const done = s.tasks.filter((t: any) => t.status === "completed").length;
      lines.push(`  • ${head}  [${s.status}]  ${done}/${s.tasks.length} done  id=${s.shortId}`);
      const meta = [
        ...(s.title ? [`title=${JSON.stringify(s.title)}`] : []),
        `project=${s.project ?? "—"}`,
        `name=${s.name}`,
      ];
      lines.push(`    ${meta.join("  ·  ")}`);
      for (const t of s.tasks) lines.push(`    ${ICON[t.status] ?? "·"} ${t.name}`);
      if (!s.tasks.length) lines.push(`    (no tasks)`);
    }
  }
  return text(lines.join("\n"));
}

// Last path segment of a project path (handles / and \ separators).
function baseName(p: string | null): string | null {
  if (!p) return null;
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
