import { FlowGraph, parseNcco } from "@preflight/engine";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { PgGraphStore } from "./graphStore.js";

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
  }, 30000);
});
