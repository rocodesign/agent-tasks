import { createRemoteJWKSet, jwtVerify } from "jose";
import { isAllowedEmail, type AuthEnv } from "./auth.ts";

export type ShellJwtEnv = AuthEnv & {
  SHELL_URL?: string;
};

export type ShellJwtClaims = {
  sub: string;
  email: string;
  grants: unknown;
};

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function looksLikeJwt(token: string): boolean {
  return JWT_SHAPE.test(token);
}

export function shellIssuer(env: ShellJwtEnv): string | null {
  const issuer = (env.SHELL_URL ?? "").trim().replace(/\/+$/, "");
  return issuer || null;
}

// Each JWKSet keeps its own fetch cache and cooldown; reusing it across requests in
// the isolate is what keeps verification from calling the shell on every poll.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let keySet = keySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/api/auth/jwks`));
    keySets.set(issuer, keySet);
  }
  return keySet;
}

export async function verifyShellJwt(env: ShellJwtEnv, token: string): Promise<ShellJwtClaims | null> {
  const issuer = shellIssuer(env);
  if (!issuer || !looksLikeJwt(token)) return null;
  try {
    const { payload } = await jwtVerify(token, keySetFor(issuer), {
      issuer,
      algorithms: ["EdDSA", "Ed25519", "ES256"],
    });
    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    if (!sub || !email) return null;
    return { sub, email, grants: payload.grants ?? null };
  } catch {
    return null;
  }
}

export async function resolveShellAccountEmail(env: ShellJwtEnv, token: string): Promise<string | null> {
  const claims = await verifyShellJwt(env, token);
  if (!claims) return null;
  const email = claims.email.toLowerCase();
  if (!email.includes("@")) return null;
  if (!isAllowedEmail(env, email)) return null;
  return email;
}
