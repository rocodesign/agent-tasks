import assert from "node:assert/strict";
import test from "node:test";
import { groupSessions } from "../ui/src/session-groups.ts";

function session(id: string, parentSessionId: string | null = null) {
  return { session: { id, parentSessionId } };
}

test("groups subagents under their visible orchestrator", () => {
  const parent = session("parent");
  const child = session("parent:agent:child", "parent");

  assert.deepEqual(groupSessions([child, parent]), [{ root: parent, subagents: [child] }]);
});

test("flattens nested subagents into the orchestrator stack", () => {
  const parent = session("parent");
  const child = session("parent:agent:child", "parent");
  const nested = session("parent:agent:child:agent:nested", "parent:agent:child");

  assert.deepEqual(groupSessions([nested, child, parent]), [{ root: parent, subagents: [nested, child] }]);
});

test("keeps an orphaned subagent visible", () => {
  const orphan = session("missing:agent:child", "missing");

  assert.deepEqual(groupSessions([orphan]), [{ root: orphan, subagents: [] }]);
});
