export type SessionProvider = "claude" | "codex";

export type SessionRelation = {
  isSubagent: boolean;
  parentSessionId: string | null;
  agentId: string | null;
};

export function normalizeProvider(value: unknown): SessionProvider | null {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  return provider === "claude" || provider === "codex" ? provider : null;
}

export function sessionRelation(sessionId: string): SessionRelation {
  const marker = ":agent:";
  const markerIndex = sessionId.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return { isSubagent: false, parentSessionId: null, agentId: null };
  }
  const parentSessionId = sessionId.slice(0, markerIndex);
  const agentId = sessionId.slice(markerIndex + marker.length);
  if (!agentId) return { isSubagent: false, parentSessionId: null, agentId: null };
  return { isSubagent: true, parentSessionId, agentId };
}

export type SessionMeta = {
  projectKey: string | null;
  ticketId: string | null;
  kind: string | null;
  delegation: string | null;
  harness: string | null;
  summaryVersion: number | null;
  summarizedThrough: string | null;
  decisions: string[] | null;
  tags: string[] | null;
  proposedTags: string[] | null;
  category: string | null;
};

export const EMPTY_SESSION_META: SessionMeta = {
  projectKey: null,
  ticketId: null,
  kind: null,
  delegation: null,
  harness: null,
  summaryVersion: null,
  summarizedThrough: null,
  decisions: null,
  tags: null,
  proposedTags: null,
  category: null,
};

const META_KEYS = Object.keys(EMPTY_SESSION_META) as (keyof SessionMeta)[];

const TEXT_LIMITS: Record<string, number> = {
  projectKey: 300,
  ticketId: 200,
  kind: 40,
  delegation: 200,
  harness: 80,
  category: 200,
  summarizedThrough: 200,
};

// Only fields the caller actually sent come back, so an update never erases a value
// an earlier call already established (same rule as `project` and `title`).
export function pickSessionMeta(...sources: unknown[]): Partial<SessionMeta> {
  const meta: Partial<SessionMeta> = {};
  for (const key of META_KEYS) {
    const raw = firstValue(sources, key);
    if (raw === undefined || raw === null) continue;
    if (key === "decisions" || key === "tags" || key === "proposedTags") {
      const list = stringList(raw);
      if (list) meta[key] = list;
      continue;
    }
    if (key === "summaryVersion") {
      const version = Number(raw);
      if (Number.isFinite(version)) meta.summaryVersion = Math.trunc(version);
      continue;
    }
    const text = String(raw).trim().slice(0, TEXT_LIMITS[key] ?? 200);
    if (text) meta[key] = text as any;
  }
  return meta;
}

export function mergeSessionMeta(previous: Partial<SessionMeta> | undefined, ...sources: unknown[]): SessionMeta {
  const carried: Partial<SessionMeta> = {};
  for (const key of META_KEYS) {
    const value = previous?.[key];
    if (value !== undefined && value !== null) carried[key] = value as any;
  }
  return { ...EMPTY_SESSION_META, ...carried, ...pickSessionMeta(...sources) };
}

function firstValue(sources: unknown[], key: string): unknown {
  for (const source of sources) {
    if (source && typeof source === "object" && (source as any)[key] !== undefined) return (source as any)[key];
  }
  return undefined;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.map((entry) => String(entry ?? "").trim().slice(0, 500)).filter(Boolean);
  return list.length ? list : null;
}
