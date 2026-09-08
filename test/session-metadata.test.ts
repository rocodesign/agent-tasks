import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_SESSION_META,
  mergeSessionMeta,
  normalizeProvider,
  pickSessionMeta,
  sessionRelation,
} from "../src/session-metadata.ts";

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

test("picks only the enrichment fields the caller sent", () => {
  assert.deepEqual(
    pickSessionMeta({
      projectKey: "github.com/rocodesign/majordomo",
      ticketId: "36",
      kind: "delegated",
      summaryVersion: "2",
      summarizedThrough: "msg-41",
      decisions: [" keep D1 ", ""],
      tags: ["cloudflare", "d1"],
      category: "infra",
      project: "D:/Work/sidus/fleet",
    }),
    {
      projectKey: "github.com/rocodesign/majordomo",
      ticketId: "36",
      kind: "delegated",
      summaryVersion: 2,
      summarizedThrough: "msg-41",
      decisions: ["keep D1"],
      tags: ["cloudflare", "d1"],
      category: "infra",
    },
  );
  assert.deepEqual(pickSessionMeta({ projectKey: null, tags: [], kind: "  " }), {});
});

test("reads enrichment fields from the first source that carries them", () => {
  assert.equal(pickSessionMeta({ kind: undefined }, { kind: "worker" }).kind, "worker");
  assert.equal(pickSessionMeta({ harness: "codex" }, { harness: "claude" }).harness, "codex");
});

test("merges enrichment fields over the previous live session", () => {
  const previous = { ...EMPTY_SESSION_META, projectKey: "repo", kind: "interactive" };
  assert.deepEqual(mergeSessionMeta(previous, { ticketId: "9" }), {
    ...EMPTY_SESSION_META,
    projectKey: "repo",
    kind: "interactive",
    ticketId: "9",
  });
  assert.equal(mergeSessionMeta(previous, { kind: "delegated" }).kind, "delegated");
  assert.equal(mergeSessionMeta(undefined, {}).projectKey, null);
});
