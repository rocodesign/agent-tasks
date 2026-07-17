#!/usr/bin/env node
/**
 * agent-tasks MCP server (local stdio).
 *
 * Bound to ONE session: every tool reads/writes only THIS session's tasks, which
 * appear on the agent-tasks dashboard. Machine identity + session id are filled in
 * automatically; the agent only supplies the task list.
 *
 * (Future: an orchestrator role could add a fleet-wide read across sessions — not
 * available yet.)
 *
 * Env:
 *   AGENT_TASKS_URL         base URL (default https://fleet.copaciu.com)
 *   AGENT_TASKS_KEY         per-account API key (required) — from the dashboard
 *   AGENT_TASKS_SESSION_ID  override the session id (else CLAUDE_SESSION_ID, else random)
 *   AGENT_TASKS_PROJECT     default project/cwd label (else process.cwd())
 *   AGENT_TASKS_LABEL       optional machine label
 *
 * NOTE: stdio is the MCP protocol channel — never write to stdout. Logs go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";

const BASE = (process.env.AGENT_TASKS_URL ?? "https://fleet.copaciu.com").replace(/\/+$/, "");
const KEY = process.env.AGENT_TASKS_KEY ?? "";
const SESSION_ID =
  process.env.AGENT_TASKS_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? randomUUID();
const CONNECT_TIMEOUT_MS = parseConnectTimeout(process.env.AGENT_TASKS_CONNECT_TIMEOUT_MS);

let project = process.env.AGENT_TASKS_PROJECT ?? process.cwd();
const ICON: Record<string | number, string> = { 0: "◷", 1: "◉", 2: "✓", 3: "✕", completed: "✓", in_progress: "◉", cancelled: "✕", deferred: "⊘", pending: "◷" };

const INSTRUCTIONS = `agent-tasks: report THIS session's tasks to ${BASE}.
Report only BIG CHUNKS of work (not every small detail). Use NUMBERS: 0=pending, 1=in_progress, 2=completed, 3=cancelled
Tools: report_tasks, update_task, list_tasks.
Machine/session IDs auto-filled.`;

const server = new McpServer({ name: "agent-tasks", version: "0.1.0" }, { instructions: INSTRUCTIONS });

type TaskInput = { name: string; status: number | string };

function authHeaders(extra?: Record<string, string>) {
  return { authorization: `Bearer ${KEY}`, ...extra };
}

function parseConnectTimeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

async function requireBackendConnection(): Promise<void> {
  if (!KEY) throw new Error("AGENT_TASKS_KEY is not set");

  let response: Response;
  try {
    response = await fetch(`${BASE}/api/version`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`cannot reach ${BASE}: ${String(error)}`);
  }

  if (!response.ok) {
    // Consume the response before exiting so keep-alive resources can be released.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`connection check failed: HTTP ${response.status}`);
  }
}

async function ingestDirect(
  tasks: TaskInput[],
  opts: { project?: string; title?: string; sessionStatus?: string | number } = {},
): Promise<{ ok: boolean; status?: number; text?: string; error?: string }> {
  if (!KEY) return { ok: false, error: "AGENT_TASKS_KEY is not set" };
  const payload = {
    machine: { id: hostname(), hostname: hostname(), os: platform(), label: process.env.AGENT_TASKS_LABEL ?? null },
    session: { id: SESSION_ID, project: opts.project ?? project, title: opts.title ?? null, status: opts.sessionStatus ?? "active" },
    tasks,
  };
  try {
    const res = await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function ingest(
  tasks: TaskInput[],
  opts: { project?: string; title?: string; sessionStatus?: string | number } = {},
) {
  return ingestDirect(tasks, opts);
}

// ---- report_tasks ---------------------------------------------------------
server.registerTool(
  "report_tasks",
  {
    title: "Report task list",
    description:
      "Set THIS session's task list (full snapshot, not deltas). Mirror your internal TodoWrite widget exactly " +
      "(same names + statuses, one task in_progress). Appears on the dashboard. Call after every change.",
    inputSchema: {
      tasks: z
        .array(
          z.object({
            name: z.string().describe("Task name — identical to your internal todo item"),
            status: z.union([z.number().min(0).max(3), z.enum(["pending", "in_progress", "completed", "cancelled"])]).describe("Status: 0=pending, 1=in_progress, 2=completed, 3=cancelled"),
          }),
        )
        .describe("The full current task list (snapshot)"),
      project: z.string().optional().describe("Project/cwd; defaults to the server's cwd"),
      title: z.string().optional(),
      sessionStatus: z.union([z.number().min(0).max(2), z.enum(["active", "idle", "ended"])]).optional(),
    },
  },
  async ({ tasks, project: p, title, sessionStatus }) => {
    if (p) project = p;
    const r = await ingest(tasks, { project: p, title, sessionStatus });
    if (!r.ok) return { isError: true, content: [{ type: "text", text: `Failed: ${r.error ?? `${r.status} ${r.text}`}` }] };
    let dismissed: string[] = [];
    try {
      dismissed = JSON.parse(r.text ?? "{}").dismissed ?? [];
    } catch {
      /* ignore */
    }
    const done = tasks.filter((t) => t.status === "completed" || t.status === 2).length;
    const note = dismissed.length
      ? `\n\n⚠️ The user DEFERRED: ${dismissed.map((d) => `"${d}"`).join(", ")}. Stop working on them and remove them from your list.`
      : "";
    return { content: [{ type: "text", text: `Reported ${tasks.length} tasks (${done} done) for this session.${note}` }] };
  },
);

// ---- update_task ----------------------------------------------------------
server.registerTool(
  "update_task",
  {
    title: "Update a task",
    description:
      "Update the status of ONE task in this session by name. The change shows on the dashboard. " +
      "Use when a single task changes without resending the whole list.",
    inputSchema: {
      name: z.string().describe("Exact task name to update"),
      status: z.union([z.number().min(0).max(3), z.enum(["pending", "in_progress", "completed", "cancelled"])]),
    },
  },
  async ({ name, status }) => {
    if (!KEY) return { isError: true, content: [{ type: "text", text: "AGENT_TASKS_KEY is not set" }] };
    try {
      const res = await fetch(`${BASE}/api/tasks/update`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ sessionId: SESSION_ID, name, status }),
      });
      const text = await res.text();
      if (!res.ok) return { isError: true, content: [{ type: "text", text: `Failed: ${res.status} ${text}` }] };
      const deferred = (() => {
        try {
          return JSON.parse(text).deferred;
        } catch {
          return false;
        }
      })();
      return {
        content: [
          { type: "text", text: deferred ? `"${name}" was DEFERRED by the user — leave it dropped.` : `Updated "${name}" → ${status}.` },
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Failed: ${String(e)}` }] };
    }
  },
);

// ---- list_tasks (this session only) ---------------------------------------
server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description: "List the tasks registered to THIS session (only this session's tasks).",
    inputSchema: {},
  },
  async () => {
    if (!KEY) return { isError: true, content: [{ type: "text", text: "AGENT_TASKS_KEY is not set" }] };
    try {
      const res = await fetch(`${BASE}/api/tasks?sessionId=${encodeURIComponent(SESSION_ID)}`, { headers: authHeaders() });
      if (!res.ok) return { isError: true, content: [{ type: "text", text: `Failed: ${res.status} ${await res.text()}` }] };
      const tasks: TaskInput[] = (await res.json()).tasks ?? [];
      if (!tasks.length) return { content: [{ type: "text", text: "No tasks for this session yet." }] };
      return { content: [{ type: "text", text: tasks.map((t) => `${ICON[t.status] ?? "·"} ${t.name}`).join("\n") }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Failed: ${String(e)}` }] };
    }
  },
);

// ---- end_session ----------------------------------------------------------
server.registerTool(
  "end_session",
  { title: "End session", description: "Mark this session as ended (keeps its tasks). Call when the work is complete.", inputSchema: {} },
  async () => {
    if (!KEY) return { isError: true, content: [{ type: "text", text: "AGENT_TASKS_KEY is not set" }] };
    try {
      const res = await fetch(`${BASE}/api/session/end`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ sessionId: SESSION_ID }),
      });
      if (!res.ok) return { isError: true, content: [{ type: "text", text: `Failed: ${res.status} ${await res.text()}` }] };
      return { content: [{ type: "text", text: "Session marked ended." }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Failed: ${String(e)}` }] };
    }
  },
);

async function main() {
  // Do not open the MCP transport until the authenticated backend is available.
  // Until server.connect runs, the client receives no instructions, capabilities, or
  // tool definitions, so a disconnected instance advertises no functionality.
  await requireBackendConnection();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[agent-tasks-mcp] connected. base=${BASE} session=${SESSION_ID}`);
}

main().catch((e) => {
  console.error("[agent-tasks-mcp] fatal:", e);
  process.exit(1);
});
