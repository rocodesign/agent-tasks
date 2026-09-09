import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesMachineFilter,
  matchesProject,
  matchesSessionFilters,
  readSessionFilters,
} from "../src/session-filters.ts";

const NO_FILTERS = { project: null, kind: null, delegation: null, machine: null };

test("reads the tree and history filters from the query string", () => {
  const url = new URL("https://fleet.test/api/tree?project=repo&kind=worker&delegation=d-1&machine=box&limit=5");
  assert.deepEqual(readSessionFilters(url), {
    project: "repo",
    kind: "worker",
    delegation: "d-1",
    machine: "box",
  });
  assert.deepEqual(readSessionFilters(new URL("https://fleet.test/api/tree?project=%20")), NO_FILTERS);
});

test("matches project_key first and the raw project as fallback", () => {
  assert.equal(matchesProject({ projectKey: "repo", project: "D:/Work/repo" }, "repo"), true);
  assert.equal(matchesProject({ projectKey: "repo", project: "D:/Work/repo" }, "D:/Work/repo"), false);
  assert.equal(matchesProject({ projectKey: null, project: "D:/Work/repo" }, "D:/Work/repo"), true);
});

test("filters live sessions by kind and delegation", () => {
  const session = { projectKey: "repo", project: null, kind: "worker", delegation: "d-1" };
  assert.equal(matchesSessionFilters(session, { ...NO_FILTERS, kind: "worker" }), true);
  assert.equal(matchesSessionFilters(session, { ...NO_FILTERS, kind: "interactive" }), false);
  assert.equal(matchesSessionFilters(session, { ...NO_FILTERS, delegation: "d-1" }), true);
  assert.equal(matchesSessionFilters(session, { ...NO_FILTERS, delegation: "d-2" }), false);
  assert.equal(matchesSessionFilters(session, NO_FILTERS), true);
});

test("matches a machine by hostname, raw id or namespaced id", () => {
  const machine = { id: "romeo@example.com::box", hostname: "BOX-1" };
  assert.equal(matchesMachineFilter(machine, "romeo@example.com", null), true);
  assert.equal(matchesMachineFilter(machine, "romeo@example.com", "box"), true);
  assert.equal(matchesMachineFilter(machine, "romeo@example.com", "BOX-1"), true);
  assert.equal(matchesMachineFilter(machine, "romeo@example.com", "other"), false);
});

test("a comma separated kind matches any listed kind", () => {
  const filters = { ...NO_FILTERS, kind: "interactive,delegated" };
  assert.equal(matchesSessionFilters({ kind: "delegated" }, filters), true);
  assert.equal(matchesSessionFilters({ kind: "interactive" }, filters), true);
  assert.equal(matchesSessionFilters({ kind: "worker" }, filters), false);
  assert.equal(matchesSessionFilters({ kind: null }, filters), false);
});
