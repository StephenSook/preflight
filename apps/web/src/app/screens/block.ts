/**
 * Block detail: the property that decided, its citation (the underline draws in: the one signature
 * motion), the witness path, every verdict, and the destination line: number · line type · via ·
 * confidence. Picks the decision the route names, or the latest refusal on the stream.
 */
import { maskNumber, type DecisionEvent } from "../../api/client.js";
import { gsap, prefersReducedMotion } from "../../motion/core.js";
import type { ScreenContext } from "../cockpit.js";
import { el, fmtDate, stateClass, stateWord } from "../dom.js";

const NS = "http://www.w3.org/2000/svg";

export function renderBlockDetail(ctx: ScreenContext): void {
  const { state, host, arg } = ctx;
  host.append(el("h1", {}, "Block detail"), el("p", { class: "sub" }, "Why the call did not happen, in the words of the rule and the actions that reached it."));
  const pick = (): DecisionEvent | undefined => {
    const wanted = decodeURIComponent(arg);
    return state.decisions.find((d) => d.callUuid === wanted || d.decidedAt === wanted) ?? state.decisions.find((d) => d.decision !== "pass") ?? state.decisions[0];
  };
  const body = el("div");
  host.append(body);
  let shown: string | undefined;
  const render = () => {
    const d = pick();
    if (!d) {
      body.replaceChildren(el("div", { class: "empty" }, [el("p", {}, "No decision on this stream yet. The detail fills in when one arrives.")]));
      return;
    }
    const key = `${d.callUuid ?? ""}|${d.decidedAt}`;
    if (key === shown) return;
    shown = key;
    const failed = d.verdicts.find((v) => v.verdict === "false") as (DecisionEvent["verdicts"][number] & { witness?: Array<{ label: string }>; atEnd?: boolean; reason?: string }) | undefined;
    const undecided = d.verdicts.find((v) => v.verdict === "inconclusive") as (DecisionEvent["verdicts"][number] & { reason?: string }) | undefined;
    const named = d.decision === "block" ? failed : d.decision === "hold" ? undecided : undefined;
    const headline = el("div", { class: `headline ${stateClass(d.decision)}` }, named ? `${named.id} · ${named.reason ?? d.reason ?? stateWord(d.decision)}` : `${stateWord(d.decision)} · every monitor true`);
    const citation = el("div", { class: "citation" }, [document.createTextNode(named?.citation ?? "")]);
    const underline = document.createElementNS(NS, "svg");
    underline.setAttribute("viewBox", "0 0 100 4");
    underline.setAttribute("preserveAspectRatio", "none");
    underline.setAttribute("aria-hidden", "true");
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("y1", "2");
    line.setAttribute("x2", "100");
    line.setAttribute("y2", "2");
    line.setAttribute("stroke", d.decision === "block" ? "#E5484D" : d.decision === "hold" ? "#F5A524" : "#30A46C");
    line.setAttribute("stroke-width", "3");
    underline.append(line);
    citation.append(underline);

    const witnessSteps = failed?.witness ?? [];
    const witness = el("div", { class: "witness" }, [
      el("div", { class: "kicker" }, "Witness path"),
      witnessSteps.length > 0
        ? el("ol", {}, witnessSteps.map((w, i) => el("li", { class: i === witnessSteps.length - 1 ? "is-last" : "" }, w.label)).concat(failed?.atEnd ? [el("li", { class: "is-last" }, "end of flow")] : []))
        : el("p", { class: "note" }, d.decision === "pass" ? "No witness: nothing was refused." : "The monitor could not decide, so there is no witness; the reason above says what was missing."),
    ]);
    const verdicts = el("ul", { class: "verdict-grid" }, d.verdicts.map((v) => el("li", { class: v.verdict === "true" ? "is-passed" : v.verdict === "false" ? "is-blocked" : "is-held" }, [el("span", { class: "dot", "aria-hidden": "true" }), el("span", { class: "state" }, v.verdict === "true" ? "pass" : v.verdict === "false" ? "FAIL" : "hold"), el("span", {}, `${v.id} · ${v.citation}`)])));
    const facts = d.facts ?? {};
    const dl = el("dl", {}, [
      el("dt", {}, "destination"), el("dd", {}, maskNumber(d.humanParty)),
      el("dt", {}, "line type"), el("dd", {}, facts.lineType ?? "unknown"),
      el("dt", {}, "via"), el("dd", {}, facts.lineTypeSource ?? "none"),
      el("dt", {}, "confidence"), el("dd", {}, facts.lineTypeConfidence ?? "none"),
      el("dt", {}, "place"), el("dd", {}, [facts.rateCenter, facts.state].filter(Boolean).join(", ") || "unresolved"),
      el("dt", {}, "calling hours"), el("dd", {}, facts.withinHours === undefined ? "unknown" : facts.withinHours ? "inside the window" : "outside the window"),
      el("dt", {}, "decided"), el("dd", {}, `${fmtDate(d.decidedAt)} UTC`),
      el("dt", {}, "verify"), el("dd", {}, d.verifyLatencyMs !== undefined ? `${d.verifyLatencyMs.toFixed(1)} ms` : "n/a"),
      el("dt", {}, "call uuid"), el("dd", {}, d.callUuid ?? "none: refused before the dial"),
    ]);
    body.replaceChildren(el("div", { class: "detail" }, [el("div", { class: "card" }, [headline, citation, witness, verdicts]), el("div", { class: "card" }, [el("div", { class: "kicker note" }, "The destination"), dl])]));
    if (!prefersReducedMotion()) {
      gsap.fromTo(line, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.9, ease: "power2.out", delay: 0.2 });
      gsap.from(headline, { y: 6, opacity: 0, duration: 0.4 });
    }
  };
  render();
  state.listeners.add(render);
}
