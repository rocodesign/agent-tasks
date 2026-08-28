import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
const stackSource = appSource.slice(appSource.indexOf("function SessionStack("), appSource.indexOf("function SessionCard("));

test("session stacks keep their own height inside the card grid", () => {
  assert.match(stackSource, /self-start/);
});

test("session stack layers stay inside the card row gap", () => {
  assert.doesNotMatch(stackSource, /top-1 h-full/);
  assert.doesNotMatch(stackSource, /translate-y-3\.5/);
});

test("the subagent overlay hides cards beneath it", () => {
  assert.match(stackSource, /border-edge-2 bg-surface p-3 shadow-2xl/);
});
