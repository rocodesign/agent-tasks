import assert from "node:assert/strict";
import test from "node:test";
import { fleetScopes, hasScope, looksLikeServiceToken, resolveIdentity } from "../src/identity.ts";

const ALLOWED = "romeo@copaciu.com";

let issuerCounter = 0;

type Answer = { status: number; body: unknown };

function harness(answers: Answer[], allowed = ALLOWED) {
  const issuer = `https://shell-introspect-${++issuerCounter}.test`;
  const calls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${issuer}/api/service/introspect`) {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      const answer = answers.shift() ?? { status: 401, body: { active: false } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { env: { SHELL_URL: issuer, ALLOWED_EMAILS: allowed, DB: null as never }, calls };
}

// Every token in one test must differ: the introspection cache lives in the module.
let tokenCounter = 0;
const nextToken = () => `st_token-${++tokenCounter}`;

test("names a service token by its prefix", () => {
  assert.equal(looksLikeServiceToken("st_abc"), true);
  assert.equal(looksLikeServiceToken("st_"), false);
  assert.equal(looksLikeServiceToken("at_abc"), false);
  assert.equal(looksLikeServiceToken(""), false);
});

test("reads the fleet section of a grants object as scopes", () => {
  assert.deepEqual(fleetScopes({ fleet: true }), ["read", "publish", "orchestrate"]);
  assert.deepEqual(fleetScopes({ fleet: { mode: "full" } }), ["read", "publish", "orchestrate"]);
  assert.deepEqual(fleetScopes({ fleet: { mode: "scopes", scopes: ["publish", "read", "typo"] } }), [
    "read",
    "publish",
  ]);
  assert.deepEqual(fleetScopes({ fleet: false }), []);
  assert.deepEqual(fleetScopes({}), []);
  assert.deepEqual(fleetScopes(null), []);
});

test("resolves a service token through the shell and answers each scope", async () => {
  const token = nextToken();
  const { env } = harness([
    {
      status: 200,
      body: {
        active: true,
        id: "token-1",
        email: ALLOWED,
        machine: "vpsp",
        grants: { fleet: { mode: "scopes", scopes: ["read", "publish"] } },
        ttl: 1800,
      },
    },
  ]);

  const identity = await resolveIdentity(env, token);
  assert.deepEqual(identity, {
    email: ALLOWED,
    subject: "token-1",
    machine: "vpsp",
    scopes: ["read", "publish"],
  });
  assert.equal(hasScope(identity!, "publish"), true);
  assert.equal(hasScope(identity!, "orchestrate"), false);
});

test("asks the shell once for the same token", async () => {
  const token = nextToken();
  const { env, calls } = harness([
    { status: 200, body: { active: true, id: "token-2", email: ALLOWED, machine: "vpsp", grants: { fleet: true }, ttl: 1800 } },
  ]);

  await resolveIdentity(env, token);
  await resolveIdentity(env, token);
  assert.equal(calls.length, 1);
});

test("refuses a token the shell does not know, and stops asking about it", async () => {
  const token = nextToken();
  const { env, calls } = harness([{ status: 401, body: { active: false } }]);

  assert.equal(await resolveIdentity(env, token), null);
  assert.equal(await resolveIdentity(env, token), null);
  assert.equal(calls.length, 1);
});

test("keeps asking while the shell is unwell", async () => {
  const token = nextToken();
  const { env, calls } = harness([
    { status: 503, body: { error: "down" } },
    { status: 503, body: { error: "down" } },
  ]);

  assert.equal(await resolveIdentity(env, token), null);
  assert.equal(await resolveIdentity(env, token), null);
  assert.equal(calls.length, 2);
});

test("refuses a token for an address outside the allowlist", async () => {
  const token = nextToken();
  const { env } = harness([
    {
      status: 200,
      body: { active: true, id: "token-3", email: "stranger@example.com", machine: "vpsp", grants: { fleet: true }, ttl: 1800 },
    },
  ]);

  assert.equal(await resolveIdentity(env, token), null);
});

test("refuses a service token when no shell is configured", async () => {
  assert.equal(await resolveIdentity({ ALLOWED_EMAILS: ALLOWED, DB: null as never }, nextToken()), null);
});
