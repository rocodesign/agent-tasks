import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processHook } from "./agent-tasks-hook.mjs";

async function fixture(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(raw),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const stateDir = await mkdtemp(join(tmpdir(), "agent-tasks-hook-test-"));
  t.after(async () => {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    requests,
    env: {
      AGENT_TASKS_KEY: "test-key",
      AGENT_TASKS_URL: `http://127.0.0.1:${address.port}/api/ingest`,
      AGENT_TASKS_STATE_DIR: stateDir,
      AGENT_TASKS_MACHINE: "test-machine",
    },
  };
}

test("reports native task lifecycle as snapshots", async (t) => {
  const { requests, env } = await fixture(t);
  const common = { session_id: "session-1", cwd: "/work/project" };

  await processHook({ ...common, hook_event_name: "SessionStart", source: "startup" }, env);
  await processHook(
    { ...common, hook_event_name: "TaskCreated", task_id: "1", task_subject: "Build hook" },
    env,
  );
  await processHook(
    {
      ...common,
      hook_event_name: "PostToolUse",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "in_progress" },
    },
    env,
  );
  await processHook(
    { ...common, hook_event_name: "TaskCompleted", task_id: "1", task_subject: "Build hook" },
    env,
  );
  await processHook({ ...common, hook_event_name: "SessionEnd", reason: "other" }, env);

  assert.deepEqual(
    requests.map((request) => request.url),
    ["/api/session/start", "/api/ingest", "/api/ingest", "/api/ingest", "/api/session/end"],
  );
  assert(requests.every((request) => request.authorization === "Bearer test-key"));
  assert.equal(requests[0].body.machineId, "test-machine");
  assert.deepEqual(
    requests.slice(1, 4).map((request) => request.body.tasks[0].status),
    ["pending", "in_progress", "completed"],
  );
  assert.deepEqual(requests[4].body, { sessionId: "session-1", reason: "hook" });
});

test("TodoWrite replaces the full task snapshot", async (t) => {
  const { requests, env } = await fixture(t);
  await processHook(
    {
      session_id: "session-2",
      cwd: "C:\\work\\project",
      hook_event_name: "PostToolUse",
      tool_name: "TodoWrite",
      tool_input: {
        todos: [
          { content: "First", status: "completed" },
          { content: "Second", status: "in_progress" },
        ],
      },
    },
    env,
  );

  assert.deepEqual(requests[0].body.tasks, [
    { name: "First", status: "completed" },
    { name: "Second", status: "in_progress" },
  ]);
});

test("missing configuration is a silent no-op", async () => {
  await processHook(
    { session_id: "session-3", cwd: "/work", hook_event_name: "SessionStart", source: "startup" },
    {},
  );
});
