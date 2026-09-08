import assert from "node:assert/strict";
import test from "node:test";
import { projectSlug, renderSessionDocument, sessionKnowledgeKey, sessionKnowledgeMetadata } from "../src/knowledge.ts";

const DOC = {
  slug: "fleet",
  sessionId: "abc-123",
  machineId: "windows-box",
  date: "2026-09-09",
  title: "Move the archive tier to D1",
  summary: "Ported the schema and the store to Cloudflare D1.",
  category: "infra",
  kind: "interactive",
  provider: "claude",
  ref: "36",
  tags: ["cloudflare", "#d1", "agent tasks"],
  decisions: ["Keep the raw project column."],
  followUps: ["Apply the remote migrations."],
};

test("derives the slug from the project key, then the raw path", () => {
  assert.equal(projectSlug("github.com/rocodesign/Fleet", null), "fleet");
  assert.equal(projectSlug(null, "D:\\Work\\sidus\\fleet"), "fleet");
  assert.equal(projectSlug(null, "/home/romeo/agent-tools/"), "agent-tools");
  assert.equal(projectSlug(null, null), "unknown");
});

test("writes the object under sessions/<slug>/<sessionId>.md", () => {
  assert.equal(sessionKnowledgeKey("fleet", "abc-123"), "sessions/fleet/abc-123.md");
});

test("renders the frontmatter, the plain tags line and the body", () => {
  assert.equal(
    renderSessionDocument(DOC),
    `---
type: session
category: infra
project: fleet
date: 2026-09-09
machine: windows-box
kind: interactive
provider: claude
---
tags: #fleet #cloudflare #d1 #agent-tasks
project: fleet | type: session | date: 2026-09-09 | machine: windows-box

# Move the archive tier to D1

Ported the schema and the store to Cloudflare D1.

## Decisions
- Keep the raw project column.

## Follow-ups
- Apply the remote migrations.
`,
  );
});

test("falls back to uncategorized and drops the empty sections", () => {
  const rendered = renderSessionDocument({
    ...DOC,
    category: null,
    kind: null,
    provider: null,
    title: null,
    decisions: [],
    followUps: [],
  });
  assert.match(rendered, /^---\ntype: session\ncategory: uncategorized\n/);
  assert.doesNotMatch(rendered, /kind:|provider:|## Decisions|## Follow-ups/);
  assert.match(rendered, /# Session abc-123/);
});

test("sets the R2 custom metadata facets", () => {
  assert.deepEqual(sessionKnowledgeMetadata(DOC), {
    type: "session",
    category: "infra",
    machine: "windows-box",
    kind: "interactive",
    ref: "36",
  });
  assert.deepEqual(sessionKnowledgeMetadata({ ...DOC, category: null, kind: null, ref: null }), {
    type: "session",
    category: "uncategorized",
    machine: "windows-box",
  });
});
