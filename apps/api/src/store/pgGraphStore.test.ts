import { FlowGraph, parseNcco } from "@preflight/engine";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { callContextFor, callPathFor, PgGraphStore, rememberCallPath } from "./graphStore.js";

const url = process.env["DATABASE_URL"];
if (process.env["CI"] && !url) throw new Error("DATABASE_URL is required under CI; refusing to skip the database integration test");

describe.skipIf(!url)("PgGraphStore (integration)", () => {
  const sql = postgres(url ?? "", { max: 2, idle_timeout: 5, connect_timeout: 15 });
  const appId = `test-app-${Date.now()}`;
  const store = new PgGraphStore(sql, appId);
  beforeAll(async () => {
    await runMigrations(sql);
  }, 60000);
  afterAll(async () => {
    await sql`delete from flow_edges where from_node in (select id from flow_nodes where application_id = ${appId})`;
    await sql`delete from flow_nodes where application_id = ${appId}`;
    await sql`delete from call_paths where call_uuid like ${"graph-int-%"}`;
    await sql`delete from call_path_legs where call_uuid like ${"graph-int-%"}`;
    await sql`delete from call_webhook_claims where call_uuid like ${"graph-int-%"}`;
    await sql.end({ timeout: 5 });
  });

  it("persists nodes, edges and observation counts, and reloads an equal graph scoped to the application", async () => {
    const g = new FlowGraph();
    const answer = parseNcco([{ action: "talk", text: "hi" }, { action: "input", type: ["dtmf"], eventUrl: ["https://o.example/q"] }]).actions;
    const { nodeIds } = g.observeObject("answer", answer, "2026-09-04T10:00:00.000Z");
    g.observeObject("/q", parseNcco([{ action: "talk", text: "bye" }]).actions, "2026-09-04T10:01:00.000Z", { nodeId: nodeIds[1] as string, kind: "input_branch" });
    g.observeObject("answer", answer, "2026-09-04T10:02:00.000Z");
    await store.save([...g.nodes.values()], [...g.edges.values()]);
    const back = await store.load();
    expect(back.nodes.size).toBe(3);
    expect(back.edges.size).toBe(2);
    expect(back.nodes.get(nodeIds[0] as string)).toMatchObject({ observations: 2, lastSeen: "2026-09-04T10:02:00.000Z", endpoint: "answer" });
    expect(back.paths(nodeIds[0] as string)).toEqual(g.paths(nodeIds[0] as string));
    expect((await new PgGraphStore(sql, "some-other-app").load()).nodes.size).toBe(0);
  }, 30000);

  it("stores and updates the executed path per call", async () => {
    await store.setCallPath("graph-int-1", ["a", "b"]);
    expect(await store.callPath("graph-int-1")).toEqual(["a", "b"]);
    await store.setCallPath("graph-int-1", ["a", "b", "c"]);
    expect(await store.callPath("graph-int-1")).toEqual(["a", "b", "c"]);
    expect(await store.callPath("graph-int-none")).toBeUndefined();
    await store.setCallPath("graph-int-1", ["a"], { direction: "outbound", from: "12016131021", to: "19432445023" });
    expect(await store.callContext("graph-int-1")).toEqual({ direction: "outbound", from: "12016131021", to: "19432445023" });
    await store.setCallPath("graph-int-1", ["a", "b"]);
    expect(await store.callContext("graph-int-1")).toEqual({ direction: "outbound", from: "12016131021", to: "19432445023" });
    expect(await store.callContext("graph-int-none")).toBeUndefined();
  }, 30000);

  it("resolves only unique conversation legs and never falls back for an explicit UUID", async () => {
    const ids = { callUuid: "graph-int-A", conversationUuid: "graph-int-conversation" };
    await rememberCallPath(store, ids, ["branch"], { from_user: "A" });
    const restarted = new PgGraphStore(sql, appId);
    expect(await callPathFor(restarted, { conversationUuid: ids.conversationUuid })).toEqual(["branch"]);
    expect(await callContextFor(restarted, { conversationUuid: ids.conversationUuid })).toEqual({ from_user: "A" });
    expect(await restarted.claimBranch(ids.callUuid, "branch", "unknown-conversation")).toBe(false);
    expect(await restarted.claimBranch(ids.callUuid, "branch", ids.conversationUuid)).toBe(true);
    expect(await callPathFor(restarted, { ...ids, callUuid: "graph-int-unknown" })).toBeUndefined();
    expect(await callContextFor(restarted, { ...ids, callUuid: "graph-int-unknown" })).toBeUndefined();
    await store.setCallPath("graph-int-no-context", ["branch"]);
    expect(await callContextFor(restarted, { ...ids, callUuid: "graph-int-no-context" })).toBeUndefined();
    await Promise.all(["B", "C"].map((leg) => rememberCallPath(store, { ...ids, callUuid: `graph-int-${leg}` }, ["branch"], { from_user: leg })));
    await rememberCallPath(store, ids, ["new-branch"]);
    expect(await callPathFor(restarted, { conversationUuid: ids.conversationUuid })).toBeUndefined();
    expect(await callContextFor(restarted, { conversationUuid: ids.conversationUuid })).toBeUndefined();
    expect(await callPathFor(restarted, ids)).toEqual(["new-branch"]);
    expect(await restarted.claimBranch(ids.callUuid, "new-branch", ids.conversationUuid)).toBe(false);
    expect(await restarted.claimBranch(ids.callUuid, "new-branch")).toBe(true);
  });

  it("atomically consumes only the pending last branch across store instances", async () => {
    await store.setCallPath("graph-int-claim", ["old", "pending"]);
    const restarted = new PgGraphStore(sql, appId);
    expect(await restarted.claimBranch("graph-int-claim", "old")).toBe(false);
    const claims = await Promise.all(Array.from({ length: 8 }, () => restarted.claimBranch("graph-int-claim", "pending")));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.callPath("graph-int-claim")).toEqual(["old", "pending"]);
    await store.setCallPath("graph-int-claim", ["old", "pending", "next"], undefined, null);
    expect(await restarted.claimBranch("graph-int-claim", "next")).toBe(false);
  });

  it("refuses pre-migration paths and unproven conversation aliases", async () => {
    await sql`insert into call_paths (call_uuid, node_ids, context) values ('graph-int-legacy', array['branch'], '{"from_user":"legacy"}'::jsonb)`;
    expect(await store.claimBranch("graph-int-legacy", "branch")).toBe(false);
    expect(await callPathFor(store, { conversationUuid: "graph-int-legacy" })).toBeUndefined();
    expect(await callContextFor(store, { conversationUuid: "graph-int-legacy" })).toBeUndefined();
  });

  it("persists one answer claim per call across concurrency, path writes and store restart", async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimAnswer("graph-int-answer")));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.setCallPath("graph-int-answer", ["branch"]);
    const restarted = new PgGraphStore(sql, appId);
    expect(await restarted.claimAnswer("graph-int-answer")).toBe(false);
    expect(await restarted.claimAnswer("graph-int-answer-other")).toBe(true);
  });

  it("persists event fingerprints across same-node rearming without consuming the next distinct event", async () => {
    const callUuid = "graph-int-event";
    await store.setCallPath(callUuid, ["branch"]);
    expect(await store.claimBranch(callUuid, "wrong", undefined, "event")).toBe(false);
    expect(await store.claimBranch(callUuid, "branch", undefined, "event")).toBe(true);
    await store.setCallPath(callUuid, ["branch", "branch"]);
    const restarted = new PgGraphStore(sql, appId);
    expect(await restarted.claimBranch(callUuid, "branch", undefined, "event")).toBe(false);
    const claims = await Promise.all(Array.from({ length: 8 }, () => restarted.claimBranch(callUuid, "branch", undefined, "next-event")));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.setCallPath("graph-int-event-other", ["branch"]);
    expect(await restarted.claimBranch("graph-int-event-other", "branch", undefined, "event")).toBe(true);
  });
});
