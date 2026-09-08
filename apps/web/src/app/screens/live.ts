/**
 * Live monitor: the decision stream as rows, newest first. Destination (masked), the rule or the
 * path that decided, the state. A new row springs in; the block signature lives on the detail
 * screen. Rows link to the detail by call uuid or decided-at time.
 */
import { maskNumber } from "../../api/client.js";
import { gsap, prefersReducedMotion } from "../../motion/core.js";
import type { ScreenContext } from "../cockpit.js";
import { decisionKey, el, fmtTime, stateClass, stateWord, verdictSummary } from "../dom.js";

export function renderLiveMonitor(ctx: ScreenContext): void {
  const { state, host } = ctx;
  host.append(el("h1", {}, "Live monitor"), el("p", { class: "sub" }, "Every decision the host takes, as it takes it. The last fifty replay on connect."));
  const list = el("div", { class: "rows", role: "list" });
  list.append(el("div", { class: "row is-head", role: "presentation" }, [el("span"), el("span", {}, "destination"), el("span", {}, "rule / path"), el("span", {}, "state"), el("span", {}, "time")]));
  host.append(list);
  const empty = el("div", { class: "empty" }, [el("p", {}, "No decision has arrived on this stream yet."), el("p", { class: "note" }, "Dial the public number, or place a request through the gateway, and the row appears here.")]);
  host.append(empty);
  const seen = new Set<string>();

  const render = () => {
    empty.hidden = state.decisions.length > 0;
    const head = list.firstElementChild;
    const fresh: HTMLElement[] = [];
    // Newest first: insert anything unseen right after the header, in stream order.
    for (const d of [...state.decisions].reverse()) {
      const key = decisionKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      // One record the renderer cannot draw must not stop the ones after it (a replay is fifty at once).
      let row: HTMLElement;
      try {
        const verdicts = Array.isArray(d.verdicts) ? d.verdicts : [];
        const failed = verdicts.find((v) => v.verdict === "false");
        const undecided = verdicts.find((v) => v.verdict === "inconclusive");
        const named = d.decision === "block" ? failed : d.decision === "hold" ? undecided : undefined;
        const ruleText = named ? `${named.id} · ${named.citation}` : verdictSummary(d);
        row = el("a", { class: `row ${stateClass(d.decision)}`, role: "listitem", href: `#block/${encodeURIComponent(key)}` }, [
          el("span", { class: "dot", "aria-hidden": "true" }),
          el("span", { class: "dest" }, `${maskNumber(d.humanParty)}${d.facts?.state ? ` · ${d.facts.state}` : ""}${d.facts?.lineType ? ` · ${d.facts.lineType}` : ""}`),
          el("span", { class: "rule" }, [document.createTextNode(ruleText), d.reason ? el("small", {}, d.reason) : null]),
          el("span", { class: "state" }, stateWord(d.decision)),
          el("span", { class: "time" }, fmtTime(d.decidedAt)),
        ]);
      } catch (err) {
        row = el("a", { class: `row ${stateClass(d.decision)}`, role: "listitem", href: `#block/${encodeURIComponent(key)}` }, [el("span", { class: "dot", "aria-hidden": "true" }), el("span", { class: "dest" }, "record not drawn"), el("span", { class: "rule" }, String(err instanceof Error ? err.message : err)), el("span", { class: "state" }, stateWord(d.decision)), el("span", { class: "time" }, String(d.decidedAt ?? ""))]);
      }
      if (head) head.after(row);
      else list.append(row);
      fresh.push(row);
    }
    if (fresh.length > 0 && !prefersReducedMotion()) gsap.from(fresh, { xPercent: -3, scaleY: 0.6, opacity: 0, duration: 0.7, ease: "elastic.out(1, 0.72)", stagger: 0.05, clearProps: "transform,opacity" });
  };
  render();
  state.listeners.add(render);
}
