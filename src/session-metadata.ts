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
