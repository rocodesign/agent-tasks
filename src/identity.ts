import { isAllowedEmail, sha256Hex } from "./auth.ts";
import { resolveKey } from "./search.ts";
import { looksLikeJwt, shellIssuer, verifyShellJwt, type ShellJwtEnv } from "./shell-jwt.ts";

export const FLEET_SCOPES = ["read", "publish", "orchestrate"] as const;

export type FleetScope = (typeof FLEET_SCOPES)[number];

export const SERVICE_PREFIX = "st_";

const NEGATIVE_TTL_MS = 60_000;
const MAX_TTL_MS = 60 * 60_000;
const INTROSPECT_TIMEOUT_MS = 4000;

export type IdentityEnv = ShellJwtEnv & { DB: D1Database; SHELL?: Fetcher };

export type Identity = {
  email: string;
  // The credential itself: a service token id, or the JWT subject for a person.
  subject: string;
  machine: string | null;
  scopes: FleetScope[];
  // null means every project. A list is the whole set this credential may ever reach.
  projects: string[] | null;
};

export function hasScope(identity: Identity, scope: FleetScope): boolean {
  return identity.scopes.includes(scope);
}

export function reachesProject(identity: Identity, project: string | null | undefined): boolean {
  if (identity.projects === null) return true;
  return typeof project === "string" && identity.projects.includes(project);
}

export function looksLikeServiceToken(token: string): boolean {
  return token.startsWith(SERVICE_PREFIX) && token.length > SERVICE_PREFIX.length;
}

// The shell states grants for every section; Fleet keeps only its own, and only as scopes.
export function fleetScopes(grants: unknown): FleetScope[] {
  const fleet = (grants as { fleet?: unknown } | null)?.fleet;
  if (fleet === true) return [...FLEET_SCOPES];
  const record = fleet as { mode?: unknown; scopes?: unknown } | null;
  if (!record || typeof record !== "object") return [];
  if (record.mode === "full") return [...FLEET_SCOPES];
  if (record.mode !== "scopes" || !Array.isArray(record.scopes)) return [];
  return FLEET_SCOPES.filter((scope) => (record.scopes as unknown[]).includes(scope));
}

// Keep in sync with fleetProjects in the shell's shared/grants.ts. An absent list means
// every project; the shell refuses to store an empty one, so a list is never empty here.
export function fleetProjects(grants: unknown): string[] | null {
  const fleet = (grants as { fleet?: unknown } | null)?.fleet as
    | { mode?: unknown; projects?: unknown }
    | null
    | undefined;
  if (!fleet || typeof fleet !== "object" || fleet.mode !== "scopes") return null;
  if (!Array.isArray(fleet.projects) || !fleet.projects.length) return null;
  return fleet.projects.filter((project): project is string => typeof project === "string");
}

type CacheEntry = { identity: Identity | null; expires: number };

// One cache per isolate. It is also the revocation window: a token stays usable here
// until the entry expires, which is what the shell's ttl states.
const introspections = new Map<string, CacheEntry>();

async function introspect(env: IdentityEnv, token: string): Promise<Identity | null> {
  const issuer = shellIssuer(env);
  if (!issuer) return null;
  const cacheKey = await sha256Hex(token);
  const cached = introspections.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.identity;

  let identity: Identity | null = null;
  let ttl = NEGATIVE_TTL_MS;
  try {
    const request = new Request(`${issuer}/api/service/introspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
    });
    // The binding dispatches worker to worker. Plain fetch is the fallback for a
    // deployment without it, and it fails whenever the caller arrived through the shell.
    const response = env.SHELL ? await env.SHELL.fetch(request) : await fetch(request);
    if (response.status === 401) {
      introspections.set(cacheKey, { identity: null, expires: Date.now() + NEGATIVE_TTL_MS });
      return null;
    }
    // Anything else is the shell being unwell, not an answer about this token. Caching it
    // would lock a good machine out for the whole window.
    if (!response.ok) return null;
    const body = (await response.json()) as {
      active?: boolean;
      id?: string;
      email?: string;
      machine?: string;
      grants?: unknown;
      ttl?: number;
    };
    if (body?.active !== true || typeof body.email !== "string") return null;
    const email = body.email.trim().toLowerCase();
    if (!email.includes("@") || !isAllowedEmail(env, email)) return null;
    identity = {
      email,
      subject: typeof body.id === "string" ? body.id : email,
      machine: typeof body.machine === "string" ? body.machine : null,
      scopes: fleetScopes(body.grants),
      projects: fleetProjects(body.grants),
    };
    ttl = Math.min(Math.max(Number(body.ttl ?? 0) * 1000, NEGATIVE_TTL_MS), MAX_TTL_MS);
  } catch {
    return null;
  }
  introspections.set(cacheKey, { identity, expires: Date.now() + ttl });
  return identity;
}

async function fromShellJwt(env: IdentityEnv, token: string): Promise<Identity | null> {
  const claims = await verifyShellJwt(env, token);
  if (!claims) return null;
  const email = claims.email.toLowerCase();
  if (!email.includes("@") || !isAllowedEmail(env, email)) return null;
  return {
    email,
    subject: claims.sub,
    machine: null,
    scopes: fleetScopes(claims.grants),
    projects: fleetProjects(claims.grants),
  };
}

// The `at_` keys predate the shell and stay readable until every agent carries a service
// token. An orchestrator key is the only one that could ever assign work.
async function fromApiKey(env: IdentityEnv, token: string): Promise<Identity | null> {
  const key = await resolveKey(env, token);
  if (!key) return null;
  return {
    email: key.email,
    subject: token.slice(0, 11),
    machine: null,
    scopes: key.role === "orchestrator" ? [...FLEET_SCOPES] : ["read", "publish"],
    projects: null,
  };
}

export async function resolveIdentity(env: IdentityEnv, token: string): Promise<Identity | null> {
  if (!token) return null;
  if (looksLikeJwt(token)) return fromShellJwt(env, token);
  if (looksLikeServiceToken(token)) return introspect(env, token);
  return fromApiKey(env, token);
}
