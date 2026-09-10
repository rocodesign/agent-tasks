import assert from "node:assert/strict";
import test from "node:test";
import { errorFrame, methodScope, packId, readClientFrame, relayRole, sourceNote, unpackId } from "../src/relay.ts";

test("reading a thread needs read, and touching one needs orchestrate", () => {
  assert.equal(methodScope("thread/items/list"), "read");
  assert.equal(methodScope("turn/start"), "orchestrate");
  assert.equal(methodScope("turn/steer"), "orchestrate");
});

test("a method the console has no business calling never reaches the machine", () => {
  for (const method of ["fs/writeFile", "command/exec", "config/value/write", "thread/delete", "initialize"]) {
    assert.equal(methodScope(method), null, method);
  }
});

test("only the word source names the deputy", () => {
  assert.equal(relayRole("source"), "source");
  assert.equal(relayRole("client"), "client");
  assert.equal(relayRole(null), "client");
  assert.equal(relayRole("SOURCE"), "client");
});

test("an answer finds its way back with the id the caller sent", () => {
  for (const id of [7, "abc", "has:colons"]) {
    const packed = packId("c-1234", id);
    assert.deepEqual(unpackId(packed), { tag: "c-1234", id });
  }
});

test("an id the relay did not mint is dropped rather than guessed at", () => {
  assert.equal(unpackId(9), null);
  assert.equal(unpackId("no-colon"), null);
  assert.equal(unpackId(":7"), null);
  assert.equal(unpackId("c-1:not json"), null);
});

test("a frame is refused with the id it carried, so the caller stops waiting", () => {
  const refused = readClientFrame(JSON.stringify({ id: 4, method: "command/exec" }), ["read", "orchestrate"]);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.kind === "refused" && refused.id, 4);
  assert.match(refused.kind === "refused" ? refused.message : "", /cannot be called/);
});

test("a scope the credential does not hold refuses the call rather than the connection", () => {
  const refused = readClientFrame(JSON.stringify({ id: 1, method: "turn/start" }), ["read"]);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.kind === "refused" && refused.code, -32003);

  const allowed = readClientFrame(JSON.stringify({ id: 1, method: "turn/start" }), ["read", "orchestrate"]);
  assert.equal(allowed.kind, "request");
});

test("a frame with no id is refused, because a refusal would have nowhere to go", () => {
  const refused = readClientFrame(JSON.stringify({ method: "thread/list" }), ["read"]);
  assert.equal(refused.kind, "refused");
  assert.match(refused.kind === "refused" ? refused.message : "", /needs an id/);
});

test("a frame that is not JSON is refused rather than forwarded", () => {
  const refused = readClientFrame("{", ["read"]);
  assert.equal(refused.kind, "refused");
  assert.equal(refused.kind === "refused" && refused.code, -32700);
});

test("a request keeps its params", () => {
  const frame = readClientFrame(JSON.stringify({ id: 2, method: "thread/list", params: { limit: 5 } }), ["read"]);
  assert.deepEqual(frame.kind === "request" ? frame.params : null, { limit: 5 });
});

test("the frames the relay writes itself are valid JSON-RPC", () => {
  assert.deepEqual(JSON.parse(errorFrame(3, -32001, "gone")), {
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32001, message: "gone" },
  });
  assert.deepEqual(JSON.parse(sourceNote("bella-staging", true)), {
    jsonrpc: "2.0",
    method: "relay/source",
    params: { machine: "bella-staging", attached: true },
  });
});
