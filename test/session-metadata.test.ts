import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProvider, sessionRelation } from "../src/session-metadata.ts";

test("normalizes supported providers", () => {
  assert.equal(normalizeProvider("Claude"), "claude");
  assert.equal(normalizeProvider("codex"), "codex");
  assert.equal(normalizeProvider("other"), null);
});

test("extracts a subagent relation from a session ID", () => {
  assert.deepEqual(sessionRelation("account::parent:agent:child-7"), {
    isSubagent: true,
    parentSessionId: "account::parent",
    agentId: "child-7",
  });
});

test("uses the nearest parent for nested subagents", () => {
  assert.deepEqual(sessionRelation("account::parent:agent:child-7:agent:child-8"), {
    isSubagent: true,
    parentSessionId: "account::parent:agent:child-7",
    agentId: "child-8",
  });
});

test("rejects malformed subagent session IDs", () => {
  assert.deepEqual(sessionRelation("account::session"), {
    isSubagent: false,
    parentSessionId: null,
    agentId: null,
  });
  assert.deepEqual(sessionRelation("account::session:agent:"), {
    isSubagent: false,
    parentSessionId: null,
    agentId: null,
  });
});
