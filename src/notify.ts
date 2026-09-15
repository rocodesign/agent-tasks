import type { Bindings } from "./live-state.ts";

export type EventNote = { project: string; delegation: string | null; recipients: string[] };

export function eventNote(event: {
  project?: string | null;
  delegation?: string | null;
  recipient?: string | null;
}): EventNote {
  const recipient = typeof event.recipient === "string" ? event.recipient.trim() : "";
  return {
    project: event.project || "unknown",
    delegation: typeof event.delegation === "string" && event.delegation ? event.delegation : null,
    recipients: recipient ? [recipient] : [],
  };
}

export function eventsFrame(note: EventNote): string {
  return JSON.stringify({ kind: "events", project: note.project, delegation: note.delegation, recipients: note.recipients });
}

export function helloFrame(version: number): string {
  return JSON.stringify({ kind: "hello", version });
}

export function treeFrame(version: number): string {
  return JSON.stringify({ kind: "tree", version });
}

export function nudgeFrame(recipient: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "fleet/events", params: { recipient } });
}

// A machine that holds no relay object, or one whose deputy is away, is not an error: the
// deputy's own poll is the safety net behind every nudge.
export function nudgeMachine(env: Bindings, email: string, recipient: string): Promise<void> {
  const object = env.RELAY.get(env.RELAY.idFromName(`${email}::${recipient}`));
  return object
    .fetch("https://machine-relay/internal/nudge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient }),
    })
    .then(() => undefined)
    .catch(() => undefined);
}

// Every event row is news for two audiences: the browsers watching the account, and the
// deputy the row is addressed to. Neither may fail the write that produced it.
export async function notifyEvent(env: Bindings, email: string, note: EventNote): Promise<void> {
  const object = env.LIVE_STATE.get(env.LIVE_STATE.idFromName("fleet"));
  const broadcast = object
    .fetch("https://live-state/internal/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, ...note }),
    })
    .then(() => undefined)
    .catch(() => undefined);
  await Promise.all([broadcast, ...note.recipients.map((recipient) => nudgeMachine(env, email, recipient))]);
}
