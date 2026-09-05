/**
 * Flow graph: the declared-versus-actual diff from the host. Green: observed and declared. Red:
 * observed, not declared, "NOT DECLARED". Amber hollow: declared, never observed, never verified.
 * Laid out by endpoint (a column per endpoint, the answer first) and index (a row per action).
 */
import { api, type FlowDiffView } from "../../api/client.js";
import type { ScreenContext } from "../cockpit.js";
import { el } from "../dom.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
};

export function renderFlowGraph(ctx: ScreenContext): void {
  const { host } = ctx;
  host.append(el("h1", {}, "Flow graph"), el("p", { class: "sub" }, "What the host has seen your server serve, against what its developer declared. Public: no phone numbers here."));
  const legend = el("div", { class: "legend" }, [
    el("span", {}, [el("span", { class: "dot is-passed", style: "--state: var(--verdict-passed)", "aria-hidden": "true" }), document.createTextNode("observed and declared")]),
    el("span", {}, [el("span", { class: "dot", style: "--state: var(--verdict-blocked)", "aria-hidden": "true" }), document.createTextNode("observed, not declared")]),
    el("span", {}, [el("span", { class: "dot", style: "--state: var(--verdict-held)", "aria-hidden": "true" }), document.createTextNode("declared, never observed, never verified")]),
  ]);
  const wrap = el("div", { class: "graph-wrap", tabindex: "0", role: "region", "aria-label": "The flow graph, scrollable" }, [el("p", { class: "note" }, "reading the host…")]);
  const counts = el("p", { class: "note" });
  host.append(legend, wrap, counts);
  void api
    .flow()
    .then((flow) => {
      wrap.replaceChildren(draw(flow));
      counts.textContent = `${flow.counts.states} states, ${flow.edges.length} edges, ${flow.counts.declared} declared, ${flow.counts.undeclared} undeclared (${flow.counts.undeclaredSpeaking} speaking), ${flow.counts.neverObserved} declared and never observed, ${flow.counts.endpointsObserved} of ${flow.counts.endpointsDeclared} endpoints observed, ${flow.openBranches.length} open branch${flow.openBranches.length === 1 ? "" : "es"}`;
    })
    .catch((err: unknown) => {
      wrap.replaceChildren(el("p", { class: "note" }, `The host did not answer: ${err instanceof Error ? err.message : String(err)}`));
    });
}

function draw(flow: FlowDiffView): SVGElement {
  const endpoints = [...new Set([...flow.nodes.map((n) => n.endpoint), ...flow.missing.map((m) => m.endpoint)])].sort((a, b) => (a === "answer" ? -1 : b === "answer" ? 1 : a.localeCompare(b)));
  const colW = 260;
  const rowH = 76;
  const pad = 24;
  const positions = new Map<string, { x: number; y: number }>();
  let maxRows = 1;
  const placed: Array<{ id: string; x: number; y: number; title: string; sub: string; cls: string; tag: string }> = [];
  endpoints.forEach((ep, c) => {
    const nodes = flow.nodes.filter((n) => n.endpoint === ep).sort((a, b) => a.index - b.index);
    const missing = flow.missing.filter((m) => m.endpoint === ep);
    const all = [
      ...nodes.map((n) => ({ id: n.id, index: n.index, title: n.label, sub: n.text ? `"${n.text.slice(0, 26)}…"` : `${n.observations} observation${n.observations === 1 ? "" : "s"}`, cls: n.status === "declared" ? "" : "is-undeclared", tag: n.status === "declared" ? "" : "NOT DECLARED" })),
      ...missing.map((m) => ({ id: `missing:${m.endpoint}:${m.index}`, index: m.index, title: m.label, sub: "declared, never observed", cls: "is-missing", tag: "never verified" })),
    ].sort((a, b) => a.index - b.index);
    all.forEach((n, r) => {
      const x = pad + c * colW;
      const y = pad + 28 + r * rowH;
      positions.set(n.id, { x, y });
      placed.push({ ...n, x, y });
    });
    maxRows = Math.max(maxRows, all.length);
  });
  const W = pad * 2 + endpoints.length * colW;
  const H = pad * 2 + 28 + maxRows * rowH;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "graph", role: "img", "aria-label": "The flow graph: endpoints as columns, actions as rows; red nodes were served but never declared, amber ones declared but never served." });
  endpoints.forEach((ep, c) => svg.append(svgEl("text", { x: pad + c * colW, y: pad + 12, class: "col" }, ep.toUpperCase())));
  for (const e of flow.edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + 200;
    const y1 = a.y + 28;
    const x2 = b.x;
    const y2 = b.y + 28;
    const sameColumn = Math.abs(x1 - 200 - x2) < 1;
    const d = sameColumn ? `M${a.x + 100},${a.y + 56} L${b.x + 100},${b.y}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
    svg.append(svgEl("path", { d, class: `e ${e.kind === "sequential" ? "" : "is-branch"}` }));
  }
  for (const n of placed) {
    const g = svgEl("g", { class: `n ${n.cls}`, transform: `translate(${n.x},${n.y})` });
    g.append(svgEl("rect", { width: 200, height: 56 }));
    g.append(svgEl("text", { x: 12, y: 22, "font-weight": 700 }, n.title));
    g.append(svgEl("text", { x: 12, y: 40, class: "sub" }, n.sub));
    if (n.tag) g.append(svgEl("text", { x: 196, y: 14, class: "tag", "text-anchor": "end" }, n.tag));
    svg.append(g);
  }
  return svg;
}
