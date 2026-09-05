import type { FastifyInstance, FastifyPluginAsync } from "fastify";

/**
 * The reference application: a deliberately small notification flow of the kind a clinic or a
 * county office ships, with the defect the product exists to catch. It is what the public number
 * runs, so anyone can dial it and hear the interlock intervene, and what the film's fix is made to.
 *
 * broken: identification, then a menu whose callback has a branch nobody traced. Press 1 and a
 *         scheduler picks up; say nothing and a synthesized voice speaks with no opt-out. That
 *         branch is what Preflight blocks.
 * fixed:  the same call, with the keypress routed to the declared opt-out handler and the prompt
 *         saying so. One change; the same number rings.
 *
 * It is mounted inside the Preflight service under /reference so the demonstration needs one host.
 * Preflight forwards to it over loopback and treats it exactly like any developer's server.
 */
export type ReferenceMode = "broken" | "fixed";

export interface ReferenceOptions {
  /** Absolute base the application uses for its own callback URLs, e.g. http://127.0.0.1:3131/reference. A function is resolved per request. */
  selfBaseUrl: string | (() => string);
  mode?: ReferenceMode;
  /** The app user a live leg connects to (the browser softphone), or a phone number when it starts with a digit. */
  agent?: string;
  /** Bearer token that may switch the mode at runtime; absent means the mode is fixed at boot. */
  adminToken?: string | undefined;
}

export const IDENTIFICATION = "This is a message from Preflight Demo Clinic.";

export interface ReferenceState {
  mode: ReferenceMode;
  answers: number;
  callbacks: number;
}

const endpoint = (agent: string) => (/^\+?\d{7,15}$/.test(agent) ? { type: "phone", number: agent.replace(/^\+/, "") } : { type: "app", user: agent });

export function brokenAnswer(base: string): unknown[] {
  return [
    { action: "talk", text: `${IDENTIFICATION} Your appointment is tomorrow at nine. Press 1 to speak with a scheduler.`, bargeIn: true },
    { action: "input", type: ["dtmf"], dtmf: { maxDigits: 1, timeOut: 5 }, eventUrl: [`${base}/menu`], eventMethod: "POST" },
  ];
}

export function fixedAnswer(base: string): unknown[] {
  return [
    { action: "talk", text: `${IDENTIFICATION} Your appointment is tomorrow at nine. Press 1 to speak with a scheduler. Press 9 to stop receiving these calls.`, bargeIn: true },
    { action: "input", type: ["dtmf"], dtmf: { maxDigits: 1, timeOut: 5 }, eventUrl: [`${base}/optout`], eventMethod: "POST" },
  ];
}

/** What the callback returns for a keypress: the digit, or nothing on timeout. */
export function menuReply(digits: string | undefined, agent: string): unknown[] {
  if (digits === "1") return [{ action: "connect", endpoint: [endpoint(agent)], timeout: 20 }];
  // The branch nobody traced: a synthesized voice, no opt-out, then the object ends.
  return [{ action: "talk", text: "We could not reach you. We will try again tomorrow. Goodbye." }];
}

export function optoutReply(digits: string | undefined, agent: string): unknown[] {
  if (digits === "1") return [{ action: "connect", endpoint: [endpoint(agent)], timeout: 20 }];
  if (digits === "9") return [{ action: "talk", text: "You will not receive these calls again. Goodbye." }];
  return [{ action: "talk", text: "Goodbye." }];
}

/** The declaration a developer of this application would enter in Setup. */
export function referenceDeclaration(): { identification: { phrases: string[] }; optOut: { eventUrlPatterns: string[] }; endpoints: string[]; flow: Record<string, string[][]> } {
  return {
    identification: { phrases: [IDENTIFICATION] },
    optOut: { eventUrlPatterns: ["/reference/optout"] },
    endpoints: ["/reference/menu", "/reference/optout"],
    // What this application's developer believes it serves. The menu's timeout branch (a synthesized
    // voice with no opt-out) is deliberately absent: it is the branch nobody traced, and the diff shows it.
    flow: { answer: [["talk", "input"]], "/reference/menu": [["connect"]], "/reference/optout": [["connect"], ["talk"]] },
  };
}

export const referenceApp: FastifyPluginAsync<ReferenceOptions> = async (app: FastifyInstance, opts) => {
  const state: ReferenceState = { mode: opts.mode ?? "broken", answers: 0, callbacks: 0 };
  const agent = opts.agent ?? "scheduler";
  const base = (): string => (typeof opts.selfBaseUrl === "function" ? opts.selfBaseUrl() : opts.selfBaseUrl);
  const digitsOf = (body: unknown): string | undefined => {
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return undefined;
      }
    }
    const b = body as { dtmf?: { digits?: unknown } } | undefined;
    return typeof b?.dtmf?.digits === "string" && b.dtmf.digits.length > 0 ? b.dtmf.digits : undefined;
  };

  app.route({ method: ["GET", "POST"], url: "/answer", handler: async (_req, reply) => {
    state.answers += 1;
    return reply.type("application/json").send(JSON.stringify(state.mode === "broken" ? brokenAnswer(base()) : fixedAnswer(base())));
  } });
  app.post("/menu", async (req, reply) => {
    state.callbacks += 1;
    return reply.type("application/json").send(JSON.stringify(menuReply(digitsOf(req.body), agent)));
  });
  app.post("/optout", async (req, reply) => {
    state.callbacks += 1;
    return reply.type("application/json").send(JSON.stringify(optoutReply(digitsOf(req.body), agent)));
  });
  app.route({ method: ["GET", "POST"], url: "/event", handler: async (_req, reply) => reply.code(204).send() });
  app.get("/state", async () => ({ ...state, agent, selfBaseUrl: base() }));
  app.post<{ Body: string }>("/mode", async (req, reply) => {
    if (!opts.adminToken) return reply.code(404).send({ error: "mode switching is not enabled" });
    const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (presented !== opts.adminToken) return reply.code(403).send({ error: "admin token rejected" });
    let mode: unknown;
    try {
      mode = (JSON.parse(typeof req.body === "string" ? req.body : "{}") as { mode?: unknown }).mode;
    } catch {
      return reply.code(400).send({ error: "body must be JSON" });
    }
    if (mode !== "broken" && mode !== "fixed") return reply.code(400).send({ error: 'mode must be "broken" or "fixed"' });
    state.mode = mode;
    return { mode: state.mode };
  });
};
