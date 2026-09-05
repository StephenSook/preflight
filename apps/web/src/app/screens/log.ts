/**
 * Evidence log: seq · time · kind · property · citation · hash, newest first, the verify command
 * on the page, and the host's own recomputation on demand. Public: the log carries no numbers.
 */
import { api, API_BASE, type LedgerEntry } from "../../api/client.js";
import type { ScreenContext } from "../cockpit.js";
import { el, fmtDate } from "../dom.js";

const PAGE = 50;

export function renderEvidenceLog(ctx: ScreenContext): void {
  const { host } = ctx;
  host.append(el("h1", {}, "Evidence log"), el("p", { class: "sub" }, "Every decision, hold, override, declaration, reconciliation and seal, hash-chained from genesis."));
  const command = `npx preflight-interlock verify-ledger ${API_BASE || location.origin}`;
  host.append(el("pre", {}, [el("code", {}, command)]));
  const verifyLine = el("p", { class: "note", "aria-live": "polite" }, "…");
  const verifyBtn = el("button", { class: "button", type: "button" }, [el("span", { class: "label" }, "Ask the host to recompute the chain")]);
  verifyBtn.addEventListener("click", async () => {
    verifyBtn.disabled = true;
    try {
      const v = await api.ledgerVerify();
      verifyLine.textContent = v.ok ? `ok: ${v.entries} entries, every hash and link recomputed from genesis, head ${v.head}` : `BROKEN at entry ${v.brokenAt}`;
    } catch (err) {
      verifyLine.textContent = String(err instanceof Error ? err.message : err);
    } finally {
      verifyBtn.disabled = false;
    }
  });
  host.append(el("div", { class: "byline" }, [verifyBtn, verifyLine]));
  const list = el("div", { class: "entries" });
  list.append(el("div", { class: "entry is-head" }, [el("span", {}, "seq"), el("span", {}, "time"), el("span", {}, "kind"), el("span", {}, "prop"), el("span", {}, "citation / detail"), el("span", {}, "entry hash")]));
  host.append(list);
  const more = el("button", { class: "button", type: "button" }, [el("span", { class: "label" }, "Older entries")]);
  host.append(el("div", { class: "byline" }, [more]));

  let oldest = Number.POSITIVE_INFINITY;
  const row = (e: LedgerEntry) => {
    const stateVar = e.decision === "block" ? "var(--verdict-blocked)" : e.decision === "hold" ? "var(--verdict-held)" : e.decision === "pass" ? "var(--verdict-passed)" : "var(--cockpit-interactive)";
    const detail = e.citation ?? (e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 48) : JSON.stringify(v)?.slice(0, 48)}`).join(" · ") : "");
    return el("div", { class: "entry", style: `--state: ${stateVar}` }, [el("span", {}, String(e.seq)), el("span", {}, fmtDate(e.ts)), el("span", { class: "kind" }, e.kind), el("span", {}, e.property ?? ""), el("span", {}, detail), el("span", { class: "hash" }, e.entry_hash)]);
  };
  const load = async () => {
    more.disabled = true;
    try {
      const head = await api.ledgerHead();
      const upto = Math.min(oldest - 1, head.seq);
      const after = Math.max(0, upto - PAGE);
      const entries = await api.ledgerEntries(after, PAGE);
      const page = entries.filter((e) => e.seq <= upto).sort((a, b) => b.seq - a.seq);
      for (const e of page) list.append(row(e));
      if (page.length > 0) oldest = page[page.length - 1]!.seq;
      more.hidden = oldest <= 1;
      if (verifyLine.textContent === "…") verifyLine.textContent = `head ${head.seq} · ${head.entry_hash}`;
    } catch (err) {
      verifyLine.textContent = String(err instanceof Error ? err.message : err);
    } finally {
      more.disabled = false;
    }
  };
  more.addEventListener("click", () => void load());
  void load();
}
