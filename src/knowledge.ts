import { and, eq } from "drizzle-orm";
import type { DB } from "./db/client.ts";
import { sessions, tasks } from "./db/schema.ts";
import { namespaced } from "./store.ts";

export type SessionDocument = {
  slug: string;
  sessionId: string;
  machineId: string;
  date: string;
  title: string | null;
  summary: string | null;
  category: string | null;
  kind: string | null;
  provider: string | null;
  ref: string | null;
  tags: string[];
  decisions: string[];
  followUps: string[];
};

// The wiki and AI Search address a project by its repo name, not by the full identity.
export function projectSlug(projectKey: string | null, project: string | null): string {
  const source = projectKey || project || "";
  const segment = source.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const slug = segment.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export function sessionKnowledgeKey(slug: string, sessionId: string): string {
  return `sessions/${slug}/${sessionId}.md`;
}

export function renderSessionDocument(doc: SessionDocument): string {
  const tags = [doc.slug, ...doc.tags].map(tag);
  const lines = [
    "---",
    "type: session",
    `category: ${doc.category || "uncategorized"}`,
    `project: ${doc.slug}`,
    `date: ${doc.date}`,
    `machine: ${doc.machineId}`,
  ];
  if (doc.kind) lines.push(`kind: ${doc.kind}`);
  if (doc.provider) lines.push(`provider: ${doc.provider}`);
  lines.push("---");
  // Repeated as plain text: AI Search scores the body with BM25, not the frontmatter.
  lines.push(`tags: ${tags.map((value) => `#${value}`).join(" ")}`);
  lines.push(`project: ${doc.slug} | type: session | date: ${doc.date} | machine: ${doc.machineId}`);
  lines.push("", `# ${doc.title || `Session ${doc.sessionId}`}`, "", doc.summary ?? "");
  if (doc.decisions.length) lines.push("", "## Decisions", ...doc.decisions.map((entry) => `- ${entry}`));
  if (doc.followUps.length) lines.push("", "## Follow-ups", ...doc.followUps.map((entry) => `- ${entry}`));
  return `${lines.join("\n")}\n`;
}

export function sessionKnowledgeMetadata(doc: SessionDocument): Record<string, string> {
  const metadata: Record<string, string> = {
    type: "session",
    category: doc.category || "uncategorized",
    machine: doc.machineId,
  };
  if (doc.kind) metadata.kind = doc.kind;
  if (doc.ref) metadata.ref = doc.ref;
  return metadata;
}

export async function writeSessionKnowledge(
  db: DB,
  bucket: R2Bucket,
  email: string,
  sessionId: string,
  body: any,
): Promise<string | null> {
  const doc = await buildSessionDocument(db, email, sessionId, body);
  if (!doc) return null;
  const key = sessionKnowledgeKey(doc.slug, doc.sessionId);
  await bucket.put(key, renderSessionDocument(doc), {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: sessionKnowledgeMetadata(doc),
  });
  return key;
}

// Called before the row is deleted: the slug lives on the session.
export async function deleteSessionKnowledge(
  db: DB,
  bucket: R2Bucket,
  email: string,
  sessionId: string,
): Promise<string | null> {
  const id = namespaced(email, sessionId);
  const [row] = await db
    .select({ project: sessions.project, projectKey: sessions.projectKey })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.accountEmail, email)))
    .limit(1);
  if (!row) return null;
  const key = sessionKnowledgeKey(projectSlug(row.projectKey, row.project), stripAccount(email, id));
  await bucket.delete(key);
  return key;
}

async function buildSessionDocument(db: DB, email: string, sessionId: string, body: any): Promise<SessionDocument | null> {
  const id = namespaced(email, sessionId);
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.accountEmail, email)))
    .limit(1);
  if (!row) return null;
  const generated = await db
    .select({ name: tasks.name })
    .from(tasks)
    .where(and(eq(tasks.sessionId, id), eq(tasks.source, "generated")));
  return {
    slug: projectSlug(row.projectKey, row.project),
    sessionId: stripAccount(email, id),
    machineId: stripAccount(email, row.machineId),
    date: day(body?.endedAt) ?? day(row.lastActivityAt) ?? day(new Date())!,
    title: row.title,
    summary: row.summary,
    category: row.category,
    kind: row.kind,
    provider: row.provider,
    ref: row.delegation ?? row.ticketId,
    tags: row.tags ?? [],
    decisions: row.decisions ?? [],
    followUps: generated.map((task) => task.name),
  };
}

function tag(value: string): string {
  return value.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

function day(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function stripAccount(email: string, id: string): string {
  const prefix = `${email}::`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
