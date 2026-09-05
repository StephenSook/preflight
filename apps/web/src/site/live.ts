/**
 * Every number on the site is read from the host on load: the decision counts, the evidence-log
 * head, the last reconciliation, the rate properties. Nothing is typed in, so a reload recomputes
 * it and the page cannot drift from the fact sheet.
 */
import { api, type Campaign, type Summary } from "../api/client.js";
import { initCounters } from "../motion/scroll.js";
import { span } from "./hero-graph.js";

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const text = (sel: string, value: string) => {
  const n = q<HTMLElement>(sel);
  if (n) n.textContent = value;
};

export async function hydrateLive(): Promise<void> {
  let summary: Summary | undefined;
  try {
    summary = await api.summary();
  } catch (err) {
    text("[data-live-status]", `The host did not answer: ${err instanceof Error ? err.message : String(err)}. The counts below are blank, not invented.`);
    return;
  }
  text("[data-live-blocked]", String(summary.decisions.block));
  text("[data-live-held]", String(summary.decisions.hold));
  text("[data-live-passed]", String(summary.decisions.pass));
  text("[data-live-head-seq]", String(summary.ledger.seq));
  text("[data-live-head-hash]", summary.ledger.entry_hash);
  text("[data-live-coverage]", `${summary.coverage.observed.length} of ${summary.coverage.declared.length} declared endpoints observed, ${summary.coverage.states} states, ${summary.coverage.openBranches.length} open branch${summary.coverage.openBranches.length === 1 ? "" : "es"}`);
  if (summary.latency.verifyP50Ms !== null && summary.latency.verifyP50Ms !== undefined) text("[data-live-latency]", `verify p50 ${summary.latency.verifyP50Ms.toFixed(0)} ms, p95 ${summary.latency.verifyP95Ms?.toFixed(0) ?? "n/a"} ms over the last ${summary.latency.sample} decisions`);
  const r = summary.reconciliation;
  text(
    "[data-live-reconciliation]",
    r
      ? `${r.carrier_records} carrier record${r.carrier_records === 1 ? "" : "s"} in the platform's own report, ${r.matched} matched, ${r.leaks} leaked past a refusal, ${r.refused_in_window} refusal${r.refused_in_window === 1 ? "" : "s"} in the window (${new Date(r.ts).toISOString().slice(0, 16).replace("T", " ")} UTC)`
      : "no reconciliation recorded yet",
  );
  text("[data-live-status]", `read from the host at ${new Date().toISOString().slice(11, 19)} UTC`);
  initCounters(document.querySelector("[data-live-counters]") ?? document);

  try {
    const entries = await api.ledgerEntries(Math.max(0, summary.ledger.seq - 40), 40);
    const seal = [...entries].reverse().find((e) => e.kind === "seal");
    const uuid = seal?.detail?.["rekor_uuid"];
    if (typeof uuid === "string") text("[data-live-rekor]", `rekor-cli verify --uuid ${uuid}`);
  } catch {
    // The seal line stays as the template renders it: a command with a placeholder, marked as such.
  }

  try {
    const c: Campaign = await api.campaign();
    const host = q<HTMLElement>("[data-live-rates]");
    if (host) {
      host.replaceChildren(
        ...c.properties.map((p) => {
          const li = document.createElement("li");
          li.className = p.verdict === "true" ? "is-passed" : p.verdict === "false" ? "is-blocked" : "is-held";
          const figure = p.figure === null ? "no figure" : p.unit === "seconds" ? `${p.figure.toFixed(1)} s` : `${(p.figure * 100).toFixed(1)}%`;
          li.append(span("dot", "", true), span("state", p.verdict === "true" ? "pass" : p.verdict === "false" ? "FAIL" : "hold"), span("", `${p.id} ${p.title}: ${figure} over ${p.n}`), span("muted", p.citation), span("reason", p.basis));
          return li;
        }),
      );
      text("[data-live-rates-window]", `window ${c.window.start.slice(0, 10)} to ${c.window.end.slice(0, 10)}, ${c.outbound} ended outbound dial${c.outbound === 1 ? "" : "s"}, ${c.events} event webhooks`);
    }
  } catch {
    text("[data-live-rates-window]", "the rate properties could not be read");
  }
}
