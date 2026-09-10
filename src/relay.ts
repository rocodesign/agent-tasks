import type { FleetScope } from "./identity.ts";

export const RELAY_PROTOCOL = "majordomo.v1";
export const MAX_FRAME = 512 * 1024;

// The relay is the only thing between a browser and every method the machine's app server
// exposes. fs/writeFile, command/exec and config/value/write are each one call away, so
// what may pass is named here and everything else is refused by omission. initialize is
// absent because the deputy owns the app-server connection and performs it once.
const READ_METHODS = [
  "thread/list",
  "thread/read",
  "thread/items/list",
  "thread/turns/list",
  "thread/goal/get",
  "model/list",
  "account/rateLimits/read",
] as const;

const WRITE_METHODS = [
  "thread/start",
  "thread/resume",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/compact/start",
  "thread/goal/set",
  "thread/goal/clear",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export const RELAY_METHODS = [...READ_METHODS, ...WRITE_METHODS];

export function methodScope(method: string): FleetScope | null {
  if ((READ_METHODS as readonly string[]).includes(method)) return "read";
  if ((WRITE_METHODS as readonly string[]).includes(method)) return "orchestrate";
  return null;
}

export type RelayRole = "source" | "client";

export function relayRole(value: string | null | undefined): RelayRole {
  return value === "source" ? "source" : "client";
}

// The client's own id is carried inside the relayed one, so a response routes back with no
// table to keep. That is what lets the object hibernate between turns: it holds no memory
// of a request in flight, and a socket that wakes still knows whose answer it is reading.
export function packId(tag: string, id: unknown): string {
  return `${tag}:${JSON.stringify(id ?? null)}`;
}

export function unpackId(value: unknown): { tag: string; id: unknown } | null {
  if (typeof value !== "string") return null;
  const cut = value.indexOf(":");
  if (cut <= 0) return null;
  try {
    return { tag: value.slice(0, cut), id: JSON.parse(value.slice(cut + 1)) };
  } catch {
    return null;
  }
}

export function newTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `c-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type ClientFrame =
  | { kind: "request"; id: unknown; method: string; params: unknown }
  | { kind: "refused"; id: unknown; code: number; message: string };

export function readClientFrame(raw: string, scopes: FleetScope[]): ClientFrame {
  if (raw.length > MAX_FRAME) return { kind: "refused", id: null, code: -32600, message: "frame too large" };
  let message: { id?: unknown; method?: unknown; params?: unknown };
  try {
    message = JSON.parse(raw);
  } catch {
    return { kind: "refused", id: null, code: -32700, message: "frame is not JSON" };
  }
  const method = typeof message?.method === "string" ? message.method : "";
  const id = message?.id ?? null;
  if (!method) return { kind: "refused", id, code: -32600, message: "a frame needs a method" };
  // A notification cannot be answered, so a refusal would go nowhere. Every console call is
  // a request, and dropping the rest keeps a silent failure out of the machine.
  if (id === null) return { kind: "refused", id, code: -32600, message: "a frame needs an id" };
  const needed = methodScope(method);
  if (!needed) return { kind: "refused", id, code: -32601, message: `${method} cannot be called through the relay` };
  if (!scopes.includes(needed)) {
    return { kind: "refused", id, code: -32003, message: `${method} needs the fleet ${needed} scope` };
  }
  return { kind: "request", id, method, params: message?.params ?? {} };
}

export function errorFrame(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function sourceNote(machine: string, attached: boolean): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "relay/source", params: { machine, attached } });
}
