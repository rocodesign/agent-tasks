import type { Bindings } from "./live-state.ts";
import type { FleetScope } from "./identity.ts";
import {
  errorFrame,
  MAX_FRAME,
  newTag,
  packId,
  readClientFrame,
  relayRole,
  RELAY_PROTOCOL,
  sourceNote,
  unpackId,
} from "./relay.ts";

type Attachment = { machine: string; scopes: FleetScope[] };

// One object per machine. The deputy holds the source socket, every open console holds a
// client socket, and frames pass between them. Nothing is written: a thread and its
// transcript exist only on the machine, and thread/items/list reads them when asked.
export class MachineRelay {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Bindings,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(JSON.stringify({ error: "this route takes a websocket" }), {
        status: 426,
        headers: { "content-type": "application/json" },
      });
    }

    const machine = request.headers.get("x-relay-machine") ?? "";
    const role = relayRole(request.headers.get("x-relay-role"));
    const scopes = (request.headers.get("x-relay-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean) as FleetScope[];

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const attachment: Attachment = { machine, scopes };

    if (role === "source") {
      // A second deputy for one machine is a restart that raced its own closing socket.
      // The newest one is the live process, so it wins and the old one is closed.
      for (const existing of this.ctx.getWebSockets("source")) {
        existing.close(1012, "replaced by a newer deputy");
      }
      this.ctx.acceptWebSocket(server, ["source"]);
      server.serializeAttachment(attachment);
      this.broadcast(sourceNote(machine, true));
    } else {
      this.ctx.acceptWebSocket(server, [newTag(), "client"]);
      server.serializeAttachment(attachment);
      server.send(sourceNote(machine, this.ctx.getWebSockets("source").length > 0));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): void {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const tags = this.ctx.getTags(socket);
    if (tags.includes("source")) return this.fromSource(text);
    this.fromClient(socket, tags, text);
  }

  webSocketClose(socket: WebSocket): void {
    if (!this.ctx.getTags(socket).includes("source")) return;
    const attachment = (socket.deserializeAttachment() ?? {}) as Partial<Attachment>;
    this.broadcast(sourceNote(attachment.machine ?? "", false));
  }

  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }

  private fromClient(socket: WebSocket, tags: string[], text: string): void {
    const attachment = (socket.deserializeAttachment() ?? { scopes: [] }) as Attachment;
    const frame = readClientFrame(text, attachment.scopes ?? []);
    if (frame.kind === "refused") {
      socket.send(errorFrame(frame.id, frame.code, frame.message));
      return;
    }
    const source = this.ctx.getWebSockets("source")[0];
    if (!source) {
      socket.send(errorFrame(frame.id, -32001, "the machine is not attached"));
      return;
    }
    const tag = tags.find((entry) => entry !== "client") ?? "";
    source.send(
      JSON.stringify({ jsonrpc: "2.0", id: packId(tag, frame.id), method: frame.method, params: frame.params }),
    );
  }

  private fromSource(text: string): void {
    if (text.length > MAX_FRAME) return;
    let message: { id?: unknown; method?: unknown };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    // Anything naming a method is news for every console. Only an answer carries a packed
    // id, and only that goes back to the one client that asked.
    if (typeof message?.method === "string") {
      this.broadcast(text);
      return;
    }
    const routed = unpackId(message?.id);
    if (!routed) return;
    const target = this.ctx.getWebSockets(routed.tag)[0];
    if (!target) return;
    target.send(JSON.stringify({ ...message, id: routed.id }));
  }

  private broadcast(text: string): void {
    for (const client of this.ctx.getWebSockets("client")) client.send(text);
  }
}

export { RELAY_PROTOCOL };
