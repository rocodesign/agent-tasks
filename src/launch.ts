import type { DB } from "./db/client.ts";
import { ASSIGNMENT_PRODUCER, ASSIGNMENT_TYPE, findAssignment, insertAssignment, MAX_BODY } from "./events.ts";

export const MAX_PROMPT = 256 * 1024;
export const MAX_CWD = 512;
export const LAUNCH_ID_PATTERN = /^l-\d{8}-[0-9a-f]{8}$/;
export const DELEGATION_ID_PATTERN = /^d-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_DELEGATION = 48;

// A delegation id is an address other agents subscribe to, so a typo does not fail: it
// creates a second delegation nobody is listening on. Rows written before the shape was
// agreed keep whatever they carry; only a new launch is held to it.
export function delegationProblem(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return "a delegation id is a string";
  if (value.length > MAX_DELEGATION) return `a delegation id is at most ${MAX_DELEGATION} characters`;
  if (!DELEGATION_ID_PATTERN.test(value)) return "a delegation id looks like d-20260910-fix-brief";
  return null;
}

export class LaunchConflict extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export function mintLaunchId(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `l-${day}-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function launchPromptKey(launchId: string): string {
  return `launches/${launchId}.md`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The prompt is written before the event that names it, so an assignment can never point
// at a key with nothing behind it. The write is conditional on the object not existing:
// a head check followed by a put lets two concurrent requests both pass the check, and
// the loser would rewrite instructions a machine may already be acting on.
export async function storeLaunchPrompt(
  bucket: R2Bucket,
  launchId: string,
  prompt: string,
): Promise<{ key: string; sha256: string }> {
  const key = launchPromptKey(launchId);
  const sha256 = await sha256Hex(prompt);
  const created = await bucket.put(key, prompt, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { sha256, launch: launchId },
  });
  if (created) return { key, sha256 };
  const existing = await bucket.head(key);
  if (existing?.customMetadata?.sha256 === sha256) return { key, sha256 };
  throw new LaunchConflict(`launch ${launchId} already has a different prompt`);
}

export async function readLaunchPrompt(bucket: R2Bucket, launchId: string): Promise<string | null> {
  if (!LAUNCH_ID_PATTERN.test(launchId)) return null;
  const object = await bucket.get(launchPromptKey(launchId));
  return object ? object.text() : null;
}

export type AssignInput = {
  launchId: string;
  project: string;
  machine: string;
  prompt: string;
  delegation?: string | null;
  cwd?: string | null;
};

function sameAssignment(stored: string, next: string): boolean {
  return stored === next;
}

export async function assignLaunch(db: DB, bucket: R2Bucket, email: string, input: AssignInput) {
  const launchId = input.launchId?.trim() ?? "";
  // The caller mints the id, so a lost response can be retried without creating a second
  // launch. A server-minted id would make every retry a new assignment.
  if (!LAUNCH_ID_PATTERN.test(launchId)) throw new LaunchConflict("launch id must look like l-20260909-0a1b2c3d", 400);
  if (delegationProblem(input.delegation)) throw new LaunchConflict("invalid delegation id", 400);
  if (input.prompt.length > MAX_PROMPT) throw new LaunchConflict("prompt too large", 413);
  const cwd = input.cwd ?? null;
  if (cwd !== null && (typeof cwd !== "string" || cwd.length > MAX_CWD)) {
    throw new LaunchConflict("cwd must be a string no longer than 512 characters", 400);
  }

  const stored = await storeLaunchPrompt(bucket, launchId, input.prompt);
  const body = JSON.stringify({ launchId, cwd, promptKey: stored.key, sha256: stored.sha256 });
  // Truncating a structured body would leave an unreadable assignment in an append-only
  // stream, and every retry would return that same row.
  if (new TextEncoder().encode(body).length > MAX_BODY) throw new LaunchConflict("assignment does not fit the event body", 413);

  const published = await insertAssignment(db, {
    accountEmail: email,
    project: input.project,
    type: ASSIGNMENT_TYPE,
    producer: ASSIGNMENT_PRODUCER,
    eventKey: launchId,
    delegation: input.delegation ?? null,
    machineId: input.machine,
    recipient: input.machine,
    launch: launchId,
    body,
  });

  if (published.duplicate) {
    const existing = await findAssignment(db, email, launchId);
    // A repeat with different parameters is a different assignment wearing the same id.
    if (!existing || !sameAssignment(existing.body, body) || existing.recipient !== input.machine) {
      throw new LaunchConflict(`launch ${launchId} was already assigned with other parameters`);
    }
  }

  return { launchId, promptKey: stored.key, sha256: stored.sha256, eventId: published.id, duplicate: published.duplicate };
}
