import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { brokenAnswer, fixedAnswer, IDENTIFICATION, menuReply, optoutReply, referenceApp, referenceDeclaration } from "./index.js";

async function build(mode: "broken" | "fixed" = "broken", adminToken?: string) {
  const app = Fastify();
  app.addContentTypeParser(["application/json", "text/plain"], { parseAs: "string" }, (_req, body, done) => done(null, body));
  await app.register(referenceApp, { selfBaseUrl: "http://127.0.0.1:3131/reference", mode, ...(adminToken ? { adminToken } : {}) });
  return app;
}

describe("the reference application", () => {
  it("serves the broken flow: identification, then a menu whose timeout branch speaks with no opt-out", async () => {
    const app = await build();
    const ncco = (await app.inject({ method: "POST", url: "/answer", payload: "{}", headers: { "content-type": "application/json" } })).json() as Array<{ action: string; text?: string; eventUrl?: string[] }>;
    expect(ncco.map((a) => a.action)).toEqual(["talk", "input"]);
    expect(ncco[0]?.text?.startsWith(IDENTIFICATION)).toBe(true);
    expect(ncco[1]?.eventUrl).toEqual(["http://127.0.0.1:3131/reference/menu"]);
    const timeout = (await app.inject({ method: "POST", url: "/menu", payload: JSON.stringify({ dtmf: { digits: "", timed_out: true } }), headers: { "content-type": "application/json" } })).json() as Array<{ action: string }>;
    expect(timeout).toEqual([{ action: "talk", text: "We could not reach you. We will try again tomorrow. Goodbye." }]);
    const one = (await app.inject({ method: "POST", url: "/menu", payload: JSON.stringify({ dtmf: { digits: "1" } }), headers: { "content-type": "application/json" } })).json() as Array<{ action: string; endpoint?: Array<{ type: string; user?: string }> }>;
    expect(one[0]).toMatchObject({ action: "connect", endpoint: [{ type: "app", user: "scheduler" }] });
    expect((await app.inject({ method: "GET", url: "/state" })).json()).toMatchObject({ mode: "broken", answers: 1, callbacks: 2 });
  });

  it("serves the fixed flow: the keypress routed to the declared opt-out handler, which the declaration names", async () => {
    const app = await build("fixed");
    const ncco = (await app.inject({ method: "GET", url: "/answer" })).json() as Array<{ eventUrl?: string[]; text?: string }>;
    expect(ncco[1]?.eventUrl).toEqual(["http://127.0.0.1:3131/reference/optout"]);
    expect(ncco[0]?.text).toContain("Press 9 to stop receiving these calls");
    expect(referenceDeclaration().optOut.eventUrlPatterns).toEqual(["/reference/optout"]);
    expect(referenceDeclaration().endpoints).toContain("/reference/menu");
    const nine = (await app.inject({ method: "POST", url: "/optout", payload: JSON.stringify({ dtmf: { digits: "9" } }), headers: { "content-type": "application/json" } })).json() as Array<{ text: string }>;
    expect(nine[0]?.text).toContain("will not receive these calls again");
  });

  it("switches mode only with the admin token", async () => {
    const app = await build("broken", "reference-admin-token-1234");
    expect((await app.inject({ method: "POST", url: "/mode", payload: JSON.stringify({ mode: "fixed" }), headers: { "content-type": "application/json", authorization: "Bearer nope" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/mode", payload: JSON.stringify({ mode: "fixed" }), headers: { "content-type": "application/json", authorization: "Bearer reference-admin-token-1234" } })).json()).toEqual({ mode: "fixed" });
    expect((await app.inject({ method: "GET", url: "/answer" })).json()).toEqual(fixedAnswer("http://127.0.0.1:3131/reference"));
    expect((await app.inject({ method: "POST", url: "/mode", payload: JSON.stringify({ mode: "sideways" }), headers: { "content-type": "application/json", authorization: "Bearer reference-admin-token-1234" } })).statusCode).toBe(400);
    const off = await build("broken");
    expect((await off.inject({ method: "POST", url: "/mode", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(404);
  });

  it("uses a phone endpoint when the agent is a number", () => {
    expect(menuReply("1", "+14045550123")[0]).toMatchObject({ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] });
    expect(optoutReply("1", "scheduler")[0]).toMatchObject({ endpoint: [{ type: "app", user: "scheduler" }] });
    expect(brokenAnswer("http://x/reference")[1]).toMatchObject({ eventUrl: ["http://x/reference/menu"] });
  });
});
