import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
const stackSource = appSource.slice(appSource.indexOf("function SessionStack("), appSource.indexOf("function SessionCard("));
const cardSource = appSource.slice(appSource.indexOf("function SessionCard("), appSource.indexOf("function TaskRow("));

test("session stacks keep their own height inside the card grid", () => {
  assert.match(stackSource, /self-start/);
});

test("session stack layers stay inside the card row gap", () => {
  assert.doesNotMatch(stackSource, /top-1 h-full/);
  assert.doesNotMatch(stackSource, /translate-y-3\.5/);
});

test("the subagent overlay uses one compact card surface", () => {
  assert.match(stackSource, /overflow-y-auto/);
  assert.match(stackSource, /grid grid-cols-1 gap-1\.5/);
  assert.match(stackSource, /compact/);
  assert.doesNotMatch(stackSource, /overflow-y-auto rounded-2xl border/);
});

test("compact subagent cards hide parent context and session status", () => {
  assert.match(cardSource, /if \(!compact && proj\)/);
  assert.match(cardSource, /if \(!compact && showMachine\)/);
  assert.match(cardSource, /title=\{compact \? headline/);
  assert.match(cardSource, /!compact && <SessionPill/);
  assert.match(cardSource, /!compact && session\.isSubagent/);
});
