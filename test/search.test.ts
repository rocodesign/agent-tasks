import assert from "node:assert/strict";
import test from "node:test";
import { buildFilters } from "../src/search.ts";

test("no filter when nothing is scoped", () => {
  assert.equal(buildFilters({ query: "x" }), undefined);
});

test("a single scope is a bare comparison", () => {
  assert.deepEqual(buildFilters({ query: "x", project: "majordomo" }), {
    type: "eq",
    key: "folder",
    value: "sessions/majordomo/",
  });
});

test("several scopes are combined with and", () => {
  assert.deepEqual(buildFilters({ query: "x", project: "bella", kind: "delegated" }), {
    type: "and",
    filters: [
      { type: "eq", key: "folder", value: "sessions/bella/" },
      { type: "eq", key: "kind", value: "delegated" },
    ],
  });
});
