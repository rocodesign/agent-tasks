import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function startMcp(env = {}) {
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      AGENT_TASKS_CONNECT_TIMEOUT_MS: "250",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

async function capture(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("missing credentials advertise no MCP functionality", async () => {
  const child = startMcp({ AGENT_TASKS_KEY: "" });
  const result = await capture(child);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /AGENT_TASKS_KEY is not set/);
});

test("unreachable backend advertises no MCP functionality", async () => {
  const child = startMcp({
    AGENT_TASKS_KEY: "test-key",
    AGENT_TASKS_URL: "http://127.0.0.1:1",
  });
  const result = await capture(child);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot reach/);
});

test("connected backend allows MCP initialization and tool advertisement", async (t) => {
  const backend = createServer((request, response) => {
    assert.equal(request.url, "/api/version");
    assert.equal(request.headers.authorization, "Bearer test-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"version":1}');
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => backend.close());

  const address = backend.address();
  assert(address && typeof address === "object");
  const child = startMcp({
    AGENT_TASKS_KEY: "test-key",
    AGENT_TASKS_URL: `http://127.0.0.1:${address.port}`,
  });
  t.after(() => child.kill());

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP did not connect: ${stderr}`)), 2000);
    child.stderr.on("data", () => {
      if (stderr.includes("[agent-tasks-mcp] connected")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    })}\n`,
  );

  const [chunk] = await once(child.stdout, "data");
  const response = JSON.parse(chunk);
  assert.equal(response.id, 1);
  assert.deepEqual(response.result.capabilities.tools, { listChanged: true });
  assert.match(response.result.instructions, /report_tasks/);

  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
  );
  const [toolsChunk] = await once(child.stdout, "data");
  const toolsResponse = JSON.parse(toolsChunk);
  assert.equal(toolsResponse.id, 2);
  assert.deepEqual(
    toolsResponse.result.tools.map((tool) => tool.name),
    ["report_tasks", "update_task", "list_tasks", "end_session"],
  );
});
