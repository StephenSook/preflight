import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const summary = {
  decisions: { block: 7, hold: 3, pass: 11 },
  ledger: { seq: 0, entry_hash: "test-only-head" },
  coverage: { declared: [], observed: [], unobserved: [], states: 0, edges: 0, branchPoints: 0, openBranches: [] },
  latency: { sample: 0, verifyP50Ms: null, verifyP95Ms: null, originP50Ms: null, originP95Ms: null },
  reconciliation: null,
  policy: "strict",
};
const decision = (overrides = {}) => ({
  decision: "pass", direction: "outbound", humanParty: "12025550101",
  callUuid: "test-call", decidedAt: "2026-09-08T12:00:00.000Z", nccoHash: "test-hash-a",
  verdicts: [{ id: "P1", verdict: "true", citation: "test citation" }],
  facts: { withinHours: true }, reason: "test all-true decision", ...overrides,
});
const decisions = [
  decision(),
  decision({ nccoHash: "test-hash-b", facts: { withinHours: null }, reason: "test human override reason", verdicts: [{ id: "P1", verdict: "inconclusive", citation: "test citation" }] }),
  decision({ decidedAt: "2026-09-08T12:00:01.000Z", decision: "block", facts: { withinHours: false }, reason: "test blocked decision", verdicts: [{ id: "P1", verdict: "false", citation: "test citation" }] }),
  decision({ callUuid: undefined, decidedAt: "2026-09-08T12:00:02.000Z", verdicts: [], facts: {}, reason: "test absent verdicts" }),
  ...["12025550103", "12025550104"].map((humanParty) => decision({ callUuid: undefined, humanParty, decision: "block", reason: `test refusal ${humanParty}`, verdicts: [{ id: "P1", verdict: "false", citation: "test citation" }] })),
];
const hold = (holdId, status = "open") => ({
  holdId, status, humanParty: "12025550102", reason: `test hold ${holdId}`,
  createdAt: "2026-09-01T12:00:00.000Z", verdicts: [],
});
let openHolds = [hold("older-open")];
let historyFails = false;
let openFails = false;
let summaryFails = false;
let approvedHold;
const heldQueries = [];
const unexpected = [];
const mutations = [];
const fixture = createHttpServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const json = (body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/summary") return json(summaryFails ? { error: "test unavailable" } : summary, summaryFails ? 503 : 200);
  if (url.pathname === "/api/ledger/entries") return json({ after: 0, entries: [] });
  if (url.pathname === "/api/campaign") return json({ window: { start: "2026-09-08", end: "2026-09-09" }, properties: [], outbound: 0, events: 0 });
  if (url.pathname === "/api/stream") {
    assert.equal(url.searchParams.get("token"), "test-only-token");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const record of decisions) response.write(`event: decision\ndata: ${JSON.stringify(record)}\n\n`);
    return;
  }
  if (url.pathname === "/api/held") {
    assert.equal(request.headers.authorization, "Bearer test-only-token");
    assert.equal(url.searchParams.get("limit"), "50");
    const status = url.searchParams.get("status");
    heldQueries.push(status);
    if ((status === "open" && openFails) || (status === "all" && historyFails)) return json({ error: "test unavailable" }, 503);
    return json({ status, lookups: "off", holds: status === "open" ? openHolds : [ ...(approvedHold ? [approvedHold] : []), ...Array.from({ length: 50 }, (_, index) => hold(`recent-${index}`, "cancelled")) ].slice(0, 50) });
  }
  if (url.pathname === "/api/held/older-open/decide" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const mutation = JSON.parse(body);
    mutations.push(mutation);
    openHolds = [];
    approvedHold = mutation.action === "place" ? { ...hold("older-open", "placed"), decidedBy: mutation.by } : undefined;
    return json({ hold: approvedHold ?? hold("older-open", "cancelled"), ledger: { seq: 1 } });
  }
  unexpected.push(url.pathname);
  return json({ error: "unexpected test request" }, 500);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
process.env.VITE_API_URL = "";
const vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixtureOrigin }, "/health": { target: fixtureOrigin } } } });
let browser;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  for (const [name, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
    browser = await browserType.launch();
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const errors = [];
    const external = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await context.addInitScript((localOrigin) => {
      if (location.origin === localOrigin) sessionStorage.setItem("preflight:dashboard-token", "test-only-token");
    }, origin);
    const page = await context.newPage();
    summaryFails = false;
    await page.goto(origin);
    const verdict = page.locator("[data-sandbox-decision]");
    const declaration = page.locator("[data-sandbox-declaration]");
    const input = page.locator("[data-sandbox-input]");
    const clear = async () => {
      await page.locator('[data-sandbox-sample="fixed"]').click();
      await expect(verdict).toHaveText("cleared");
    };
    const invalid = async () => {
      await expect(verdict).toHaveText("invalid input");
      await expect(verdict).not.toHaveClass(/is-passed/);
      assert.equal(await verdict.getAttribute("aria-label"), null);
      await expect(page.locator("[data-sandbox-out]")).toBeEmpty();
      await expect(page.locator("[data-sandbox-timing]")).toBeEmpty();
      await expect(page.locator("[data-sandbox-issues]")).not.toBeEmpty();
    };
    for (const malformed of ["{", "null", "[]", '{"identification":null}', '{"identification":{"phrases":3}}', '{"identification":{"phrases":[3]}}', '{"identification":{"streamUrls":"url"}}', '{"optOut":{"eventUrlPatterns":true}}', '{"endpoints":{}}', '{"flow":{"answer":[3]}}', '{"unknown":true}']) {
      await clear();
      await declaration.fill(malformed);
      await invalid();
      await page.locator("[data-sandbox-run]").click();
      await invalid();
    }
    for (const malformed of ["", "{", '{"ncco":[],"declaration":{"identification":{"phrases":3}}}', '{"ncco":[],"declaration":null}']) {
      await clear();
      await input.fill(malformed);
      await invalid();
    }
    await clear();
    const fixedObject = JSON.parse(await input.inputValue());
    const fixedDeclaration = JSON.parse(await declaration.inputValue());
    await declaration.fill("");
    await input.fill(JSON.stringify({ ncco: fixedObject, declaration: fixedDeclaration }));
    await expect(verdict).toHaveText("cleared");
    await page.locator('[data-sandbox-sample="broken"]').click();
    await expect(verdict).toHaveText("no-go");
    await expect(page.locator("[data-live-blocked]")).toHaveText("7");
    await expect(page.locator("[data-live-held]")).toHaveText("3");
    await expect(page.locator("[data-live-passed]")).toHaveText("11");
    await expect(page.locator("[data-live-counters] .what")).toHaveText(["block decisions", "hold decisions", "pass decisions"]);
    await expect(page.locator("[data-live-counters]")).not.toContainText(/placed|phone stayed silent|before the dial/);
    console.log(`PASS ${name}: sandbox validation, edit invalidation, recovery, public decision counts (test fixtures only)`);

    await page.goto(`${origin}/app/#live`);
    const rows = page.locator('a.row');
    await expect(rows).toHaveCount(decisions.length);
    const links = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("href")));
    assert.equal(new Set(links).size, decisions.length);
    for (const record of decisions) {
      await page.getByRole("link", { name: "Live monitor", exact: true }).click();
      const row = page.locator("a.row").filter({ hasText: record.reason });
      if (record.reason === "test human override reason") {
        await expect(row).toContainText("includes inconclusive monitors");
        await expect(row).not.toContainText("every monitor true");
      }
      await expect(row.locator(".state")).toHaveText(record.decision === "pass" ? "PASSED" : "BLOCKED");
      await row.click();
      await expect(page.locator("#screen .reason")).toHaveText(record.reason);
      await expect(page.locator("dt").filter({ hasText: /^destination$/ }).locator("+ dd")).toContainText(record.humanParty.slice(-4));
      const hours = page.locator("dt").filter({ hasText: /^calling hours$/ }).locator("+ dd");
      await expect(hours).toHaveText(record.facts.withinHours === true ? "inside the window" : record.facts.withinHours === false ? "outside the window" : "unknown");
      await expect(page.locator(".headline")).toContainText(record.reason === "test human override reason" ? "includes inconclusive monitors" : record.reason === "test absent verdicts" ? "monitor verdicts unavailable" : record.decision === "pass" ? "every monitor true" : record.reason);
    }
    for (const key of ["missing", "test-call", "%E0%A4%A"]) {
      await page.evaluate((hash) => { location.hash = hash; }, `#block/${key}`);
      await expect(page.locator("#screen")).toContainText("Requested decision unavailable");
      await expect(page.locator(".headline")).toHaveCount(0);
    }
    console.log(`PASS ${name}: real SSE to rows to exact detail, override reasons, unknown hours, unavailable routes`);

    openHolds = [hold("older-open")];
    approvedHold = undefined;
    historyFails = openFails = false;
    await page.getByRole("link", { name: "Held queue", exact: true }).click();
    await expect(page.locator(".hold.is-open")).toContainText("older-open");
    await expect(page.locator(".hold.is-cancelled")).toHaveCount(50);
    await expect(page.locator("#screen")).toContainText("not a total");
    assert.ok(heldQueries.includes("open") && heldQueries.includes("all"));
    await page.locator("#decider").fill("Test operator");
    const mutationsBeforeApproval = mutations.length;
    await page.getByRole("button", { name: "Approve release", exact: true }).click();
    await expect(page.locator(".hold.is-open")).toHaveCount(0);
    await expect(page.locator("[data-hold-action-status]")).toContainText("release approved; no call placed by this action. The caller must resubmit the request");
    await expect(page.locator(".hold.is-placed .facts")).toContainText("release approved (not confirmation of call placement) by Test operator");
    await expect(page.locator("#screen")).not.toContainText(/Place anyway|placed by Test operator/);
    assert.equal(mutations.length, mutationsBeforeApproval + 1);
    assert.deepEqual(mutations.at(-1), { action: "place", by: "Test operator" });
    openHolds = [hold("older-open")];
    approvedHold = undefined;
    await page.reload();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".hold.is-open")).toHaveCount(0);
    await expect(page.locator("#screen")).toContainText("No open holds returned by the latest query.");
    assert.deepEqual(mutations.at(-1), { action: "cancel", by: "Test operator" });
    openHolds = Array.from({ length: 50 }, (_, index) => hold(`open-${index}`));
    historyFails = true;
    await page.reload();
    await expect(page.locator(".hold.is-open")).toHaveCount(50);
    await expect(page.locator("#screen")).toContainText("showing 50 open holds (up to 50, not a total)");
    await expect(page.locator("#screen")).toContainText("Recent history unavailable");
    openFails = true;
    await page.reload();
    await expect(page.locator("#screen .is-error")).toContainText("503");
    await expect(page.locator(".hold")).toHaveCount(0);
    await expect(page.locator("#screen")).not.toContainText(/nothing hidden|No call is waiting|No open holds returned/);
    summaryFails = true;
    await page.goto(origin);
    await expect(page.locator("[data-live-status]")).toContainText("host did not answer");
    await expect(page.locator("[data-live-blocked]")).toHaveText("...");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(unexpected, []);
    console.log(`PASS ${name}: separate open/history queries, older holds, capped subsets, cancellation refresh, request failures; no production requests`);
    await context.close();
    await browser.close();
    browser = undefined;
  }
} finally {
  await browser?.close();
  await vite.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
