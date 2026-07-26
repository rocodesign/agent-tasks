#!/usr/bin/env node

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://fleet.copaciu.com";
const DEFAULT_TIMEOUT_MS = 3000;

export async function processHook(input, env = process.env) {
  const key = env.AGENT_TASKS_KEY;
  const sessionId = stringValue(input?.session_id);
  if (!key || !sessionId) return;

  const stateDir = env.AGENT_TASKS_STATE_DIR || join(tmpdir(), "agent-tasks-hooks");
  await mkdir(stateDir, { recursive: true });
  const statePath = join(stateDir, `${Buffer.from(sessionId).toString("base64url")}.json`);

  await withLock(statePath, async () => {
    const event = stringValue(input?.hook_event_name);
    const current = await readState(statePath, sessionId, input?.cwd);

    if (event === "SessionStart") {
      current.cwd = stringValue(input?.cwd) || current.cwd;
      if (input?.source === "startup" || input?.source === "clear") current.tasks = [];
      await writeState(statePath, current);
      await post(env, key, "/api/session/start", sessionPayload(current, env));
      return;
    }

    if (event === "SessionEnd") {
      await post(env, key, "/api/session/end", { sessionId, reason: "hook" }, 900);
      await rm(statePath, { force: true });
      return;
    }

    const changed = applyTaskEvent(current, input);
    if (!changed) return;

    current.cwd = stringValue(input?.cwd) || current.cwd;
    await writeState(statePath, current);
    await post(env, key, "/api/ingest", {
      machine: machinePayload(env),
      session: {
        id: current.sessionId,
        project: current.cwd,
        status: "active",
      },
      tasks: current.tasks.map(({ name, status }) => ({ name, status })),
    });
  });
}

function applyTaskEvent(state, input) {
  const event = stringValue(input?.hook_event_name);

  if (event === "TaskCreated") {
    upsertTask(state, {
      id: stringValue(input?.task_id),
      name: stringValue(input?.task_subject),
      status: "pending",
    });
    return Boolean(input?.task_id && input?.task_subject);
  }

  if (event === "TaskCompleted") {
    upsertTask(state, {
      id: stringValue(input?.task_id),
      name: stringValue(input?.task_subject),
      status: "completed",
    });
    return Boolean(input?.task_id && input?.task_subject);
  }

  if (event !== "PostToolUse") return false;
  const toolName = stringValue(input?.tool_name);
  const toolInput = input?.tool_input ?? {};

  if (toolName === "TodoWrite") {
    if (!Array.isArray(toolInput.todos)) return false;
    state.tasks = toolInput.todos
      .map((task, position) => ({
        id: `todo:${position}:${stringValue(task?.content)}`,
        name: stringValue(task?.content),
        status: normalizeStatus(task?.status),
      }))
      .filter((task) => task.name);
    return true;
  }

  if (toolName !== "TaskUpdate") return false;
  const id = stringValue(toolInput.taskId ?? toolInput.task_id);
  if (!id) return false;

  if (String(toolInput.status).toLowerCase() === "deleted") {
    const length = state.tasks.length;
    state.tasks = state.tasks.filter((task) => task.id !== id);
    return state.tasks.length !== length;
  }

  const existing = state.tasks.find((task) => task.id === id);
  const name =
    stringValue(toolInput.subject ?? toolInput.task_subject) ||
    stringValue(input?.tool_response?.subject ?? input?.tool_response?.task_subject) ||
    existing?.name ||
    "";
  if (!name) return false;

  upsertTask(state, {
    id,
    name,
    status: toolInput.status == null ? existing?.status || "pending" : normalizeStatus(toolInput.status),
  });
  return true;
}

function upsertTask(state, next) {
  if (!next.id || !next.name) return;
  const index = state.tasks.findIndex((task) => task.id === next.id);
  if (index === -1) state.tasks.push(next);
  else state.tasks[index] = { ...state.tasks[index], ...next };
}

function sessionPayload(state, env) {
  return {
    ...machinePayload(env),
    sessionId: state.sessionId,
    project: state.cwd,
  };
}

function machinePayload(env) {
  const host = hostname();
  return {
    machineId: env.AGENT_TASKS_MACHINE || host,
    hostname: host,
    os: platform(),
    label: env.AGENT_TASKS_LABEL || null,
  };
}

async function post(env, key, path, body, timeoutOverride) {
  const base = normalizeBaseUrl(env.AGENT_TASKS_URL);
  const configured = Number(env.AGENT_TASKS_HOOK_TIMEOUT_MS);
  const timeout =
    timeoutOverride ?? (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`agent-tasks returned HTTP ${response.status}`);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL)
    .replace(/\/api\/(?:ingest|session\/(?:start|end))\/?$/, "")
    .replace(/\/+$/, "");
}

function normalizeStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (["in_progress", "in-progress", "active", "doing"].includes(status)) return "in_progress";
  if (["completed", "complete", "done"].includes(status)) return "completed";
  if (["cancelled", "canceled", "skipped"].includes(status)) return "cancelled";
  return "pending";
}

async function readState(path, sessionId, cwd) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.sessionId === sessionId && Array.isArray(parsed.tasks)) return parsed;
  } catch {
    // A missing or partial cache is harmless; the next native task event rebuilds it.
  }
  return { sessionId, cwd: stringValue(cwd), tasks: [] };
}

async function writeState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), "utf8");
  await rename(temporary, path);
}

async function withLock(statePath, action) {
  const lockPath = `${statePath}.lock`;
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 10_000) await rm(lockPath, { force: true });
      } catch {
        // Another process released the lock between checks.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) return;
  try {
    await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function stringValue(value) {
  return typeof value === "string" ? value.slice(0, 2000) : "";
}

async function main() {
  try {
    const raw = await readFile(0, "utf8");
    await processHook(JSON.parse(raw));
  } catch {
    // Hooks are telemetry only. Stay completely silent: stdout or stderr can be
    // injected into Claude's context and would defeat the zero-token design.
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) await main();
