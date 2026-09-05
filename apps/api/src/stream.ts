import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { DecisionRecord, DecisionStore } from "./store/decisionStore.js";

/**
 * Decisions as they happen, for the dashboard. Server-sent events: one direction, plain HTTP,
 * reconnects natively, survives intermediaries that drop websocket upgrades. One process serves
 * the whole deployment, so an in-process bus is the whole fan-out.
 */
export class DecisionBus extends EventEmitter {
  private readonly recent: DecisionRecord[] = [];
  publish(record: DecisionRecord): void {
    this.recent.push(record);
    if (this.recent.length > 100) this.recent.shift();
    this.emit("decision", record);
  }
  last(n: number): DecisionRecord[] {
    return this.recent.slice(-n);
  }
}

/** Wraps a store so every append is also published. */
export function publishing(store: DecisionStore, bus: DecisionBus): DecisionStore {
  return {
    name: store.name,
    append: async (r) => {
      await store.append(r);
      bus.publish(r);
    },
    recent: (n) => store.recent(n),
    between: (start, end, n) => store.between(start, end, n),
    counts: () => store.counts(),
  };
}

/**
 * The stream carries phone numbers, so it is for the dashboard only: the dashboard token must be
 * presented as a bearer header or, because EventSource cannot set headers, as ?token=. Without a
 * configured token the route does not exist.
 */
export function registerStream(app: FastifyInstance, bus: DecisionBus, authorize: (presented: string | undefined) => "ok" | "forbidden" | "disabled", heartbeatMs = 15000): void {
  app.get<{ Querystring: { replay?: string; token?: string } }>("/api/stream", (req, reply) => {
    const presented = typeof req.query.token === "string" ? req.query.token : (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || undefined;
    const auth = authorize(presented);
    if (auth !== "ok") return reply.code(auth === "disabled" ? 404 : 403).send({ error: auth === "disabled" ? "the dashboard is not enabled on this deployment" : "dashboard token rejected" });
    const replay = Math.min(100, Math.max(0, Number(req.query.replay ?? 20) || 0));
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const r of bus.last(replay)) send("decision", r);
    const onDecision = (r: DecisionRecord) => send("decision", r);
    bus.on("decision", onDecision);
    const beat = setInterval(() => reply.raw.write(": keepalive\n\n"), heartbeatMs);
    const close = () => {
      clearInterval(beat);
      bus.off("decision", onDecision);
    };
    req.raw.on("close", close);
    req.raw.on("error", close);
  });
}
