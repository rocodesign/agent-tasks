#!/usr/bin/env node
// Reads a task snapshot (JSON) from stdin or a file arg and POSTs it to agent-tasks.
// Machine identity (id/hostname/os) is filled in automatically.
//
//   AGENT_TASKS_URL  ingest endpoint (default https://fleet.copaciu.com/api/ingest)
//   AGENT_TASKS_KEY  shared API key (required)
//
// Input shape:
//   { "session": { "id": "...", "project": "...", "status": "active" },
//     "tasks":   [ { "name": "...", "status": "in_progress" }, ... ],
//     "machine": { "id": "...", "label": "..." }   // optional overrides
//   }

import { hostname, platform } from "node:os";
import { readFileSync } from "node:fs";

const URL = process.env.AGENT_TASKS_URL ?? "https://fleet.copaciu.com/api/ingest";
const KEY = process.env.AGENT_TASKS_KEY;

if (!KEY) {
  console.error("AGENT_TASKS_KEY env var is required");
  process.exit(1);
}

let raw;
try {
  raw = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");
} catch {
  console.error("Provide snapshot JSON via stdin or a file path argument");
  process.exit(1);
}

const input = JSON.parse(raw);
if (!input.session?.id) {
  console.error("session.id is required in the snapshot");
  process.exit(1);
}

const payload = {
  machine: {
    id: input.machine?.id ?? hostname(),
    hostname: hostname(),
    os: platform(),
    label: input.machine?.label ?? null,
  },
  session: input.session,
  tasks: Array.isArray(input.tasks) ? input.tasks : [],
};

const res = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (!res.ok) {
  console.error(`ingest failed: ${res.status} ${text}`);
  process.exit(1);
}

let dismissed = [];
try {
  dismissed = JSON.parse(text).dismissed ?? [];
} catch {
  /* ignore */
}
if (dismissed.length) {
  console.log(
    `⚠️ User deferred: ${dismissed.map((d) => `"${d}"`).join(", ")} — stop working on these, ` +
      `remove them from your list (or mark them cancelled), and do not re-add them.`,
  );
}
console.log(`reported: ${text}`);
