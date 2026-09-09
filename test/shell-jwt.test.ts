import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { looksLikeJwt, resolveShellAccountEmail, shellIssuer, verifyShellJwt } from "../src/shell-jwt.ts";

const ALLOWED = "romeo@copaciu.com";

type Harness = {
  env: { SHELL_URL: string; ALLOWED_EMAILS: string };
  sign: (
    claims: Record<string, unknown>,
    options?: { issuer?: string; alg?: string; expiresAt?: string | number },
  ) => Promise<string>;
};

let issuerCounter = 0;

async function harness(alg = "ES256", allowed = ALLOWED): Promise<Harness> {
  const issuer = `https://shell-${++issuerCounter}.test`;
  const pair = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "test-key";
  jwk.alg = alg;
  jwk.use = "sig";

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${issuer}/api/auth/jwks`) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input);
  }) as typeof fetch;

  return {
    env: { SHELL_URL: issuer, ALLOWED_EMAILS: allowed },
    sign: (claims, options = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: options.alg ?? alg, kid: "test-key" })
        .setIssuer(options.issuer ?? issuer)
        .setIssuedAt()
        .setExpirationTime(options.expiresAt ?? "5m")
        .sign(pair.privateKey),
  };
}

test("detects the three-segment JWT shape", () => {
  assert.equal(looksLikeJwt("aaa.bbb.ccc"), true);
  assert.equal(looksLikeJwt("at_2Fh-9_Kq"), false);
  assert.equal(looksLikeJwt(""), false);
  assert.equal(looksLikeJwt("aaa.bbb"), false);
  assert.equal(looksLikeJwt("aaa.bbb.ccc.ddd"), false);
  assert.equal(looksLikeJwt("aaa.bbb.cc c"), false);
});

test("reads the issuer from SHELL_URL and drops a trailing slash", () => {
  assert.equal(shellIssuer({ SHELL_URL: "https://sidus.copaciu.com/" }), "https://sidus.copaciu.com");
  assert.equal(shellIssuer({ SHELL_URL: " https://sidus.copaciu.com " }), "https://sidus.copaciu.com");
  assert.equal(shellIssuer({}), null);
  assert.equal(shellIssuer({ SHELL_URL: "" }), null);
});

test("verifies an ES256 token against the shell JWKS", async () => {
  const { env, sign } = await harness("ES256");
  const token = await sign({ sub: "user_1", email: ALLOWED });
  assert.deepEqual(await verifyShellJwt(env, token), { sub: "user_1", email: ALLOWED, grants: null });
});

test("verifies an EdDSA token against the shell JWKS", async () => {
  const { env, sign } = await harness("EdDSA");
  const token = await sign({ sub: "user_2", email: ALLOWED });
  assert.deepEqual(await verifyShellJwt(env, token), { sub: "user_2", email: ALLOWED, grants: null });
});

test("accepts a token without an audience claim", async () => {
  const { env, sign } = await harness();
  const token = await sign({ sub: "user_3", email: ALLOWED });
  const claims = await verifyShellJwt(env, token);
  assert.equal(claims?.sub, "user_3");
});

test("rejects a token signed by another key pair", async () => {
  const { env } = await harness();
  const stranger = await generateKeyPair("ES256", { extractable: true });
  const token = await new SignJWT({ sub: "user_4", email: ALLOWED })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(env.SHELL_URL)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(stranger.privateKey);
  assert.equal(await verifyShellJwt(env, token), null);
});

test("rejects a token from another issuer", async () => {
  const { env, sign } = await harness();
  const token = await sign({ sub: "user_5", email: ALLOWED }, { issuer: "https://evil.test" });
  assert.equal(await verifyShellJwt(env, token), null);
});

test("rejects an expired token", async () => {
  const { env, sign } = await harness();
  const token = await sign({ sub: "user_6", email: ALLOWED }, { expiresAt: "-1m" });
  assert.equal(await verifyShellJwt(env, token), null);
});

test("rejects a token without sub or email", async () => {
  const { env, sign } = await harness();
  assert.equal(await verifyShellJwt(env, await sign({ sub: "user_7" })), null);
  assert.equal(await verifyShellJwt(env, await sign({ email: ALLOWED })), null);
});

test("rejects verification when SHELL_URL is unset", async () => {
  const { sign } = await harness();
  const token = await sign({ sub: "user_8", email: ALLOWED });
  assert.equal(await verifyShellJwt({ ALLOWED_EMAILS: ALLOWED }, token), null);
});

test("maps a verified token to the lowercase account email", async () => {
  const { env, sign } = await harness();
  const token = await sign({ sub: "user_9", email: "  Romeo@Copaciu.com  " });
  assert.equal(await resolveShellAccountEmail(env, token), ALLOWED);
});

test("rejects an email that is not on the allowlist", async () => {
  const { env, sign } = await harness("ES256", ALLOWED);
  const token = await sign({ sub: "user_10", email: "stranger@example.com" });
  assert.equal(await resolveShellAccountEmail(env, token), null);
});

test("rejects every email when the allowlist is empty", async () => {
  const { env, sign } = await harness("ES256", "");
  const token = await sign({ sub: "user_11", email: ALLOWED });
  assert.equal(await resolveShellAccountEmail(env, token), null);
});
