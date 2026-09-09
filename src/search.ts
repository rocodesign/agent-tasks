import { eq } from "drizzle-orm";
import { createDb } from "./db/client.ts";
import { apiKeys } from "./db/schema.ts";

export type SearchEnv = { DB: D1Database; AI: Ai; AI_SEARCH?: string };

export type SearchRequest = {
  query: string;
  project?: string | null;
  type?: string | null;
  kind?: string | null;
  limit?: number;
  rewrite?: boolean;
  threshold?: number;
};

type Comparison = { type: "eq"; key: string; value: string };

// AI Search filters compare one metadata field at a time and AND implicitly.
export function buildFilters(request: SearchRequest): Comparison | { type: "and"; filters: Comparison[] } | undefined {
  const clauses: Comparison[] = [];
  if (request.project) clauses.push({ type: "eq", key: "folder", value: `sessions/${request.project}/` });
  if (request.type) clauses.push({ type: "eq", key: "type", value: request.type });
  if (request.kind) clauses.push({ type: "eq", key: "kind", value: request.kind });
  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : { type: "and", filters: clauses };
}

export async function resolveKey(env: { DB: D1Database }, token: string): Promise<{ email: string; role: string | null } | null> {
  if (!token) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const rows = await createDb(env.DB)
    .select({ email: apiKeys.email, role: apiKeys.role })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  return rows[0] ? { email: rows[0].email, role: rows[0].role ?? null } : null;
}

export async function resolveKeyEmail(env: { DB: D1Database }, token: string): Promise<string | null> {
  return (await resolveKey(env, token))?.email ?? null;
}

export async function runSearch(env: SearchEnv, request: SearchRequest) {
  const result: any = await env.AI.autorag(env.AI_SEARCH || "majordomo-search").search({
    query: request.query,
    max_num_results: Math.min(Math.max(request.limit ?? 20, 1), 50),
    rewrite_query: request.rewrite ?? false,
    // The instance default of 0.4 drops relevant summaries; the trimmer restores precision.
    ranking_options: { score_threshold: request.threshold ?? 0.2 },
    filters: buildFilters(request),
  });
  const documents = (result?.data ?? []).map((entry: any) => ({
    file: entry.filename ?? entry.file_id,
    score: entry.score,
    attributes: entry.attributes ?? {},
    text: (entry.content ?? []).map((part: any) => part.text).join("\n"),
  }));
  return { query: request.query, documents };
}
