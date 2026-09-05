/**
 * The hero's visual is the product's own artefact: the reference application's real call flow,
 * drawn as a graph, with the engine run in the browser over each path. The timeout branch (a
 * synthesized voice with no opt-out, then the object ends) lights in the verdict red with its
 * citation; the keypress branch that connects a person stays clean. Nothing here is illustrated
 * by hand: the objects come from apps/reference and the verdicts from packages/engine.
 */
import { brokenAnswer, menuReply } from "@preflight/reference";
import { evaluatePath, parseNcco, type CallFacts, type NccoAction, type PropertyVerdict } from "@preflight/engine";
import { gsap, prefersReducedMotion } from "../motion/core.js";

const FACTS: CallFacts = { from: "12016131021", lineType: "wireless", withinHours: true };
const BASE = "https://preflight-api-rc34.onrender.com/reference";
const DECLARATION = { identification: { phrases: ["This is a message from Preflight Demo Clinic."] }, optOut: { eventUrlPatterns: ["/reference/optout"] } };

export interface HeroPath {
  name: "keypress" | "timeout";
  actions: NccoAction[];
  labels: string[];
  verdicts: PropertyVerdict[];
  failed: PropertyVerdict | undefined;
}

/** The two paths the answer object can take, each evaluated as the interlock evaluates a terminal path. */
export function heroPaths(): HeroPath[] {
  const answer = brokenAnswer(BASE);
  const paths: Array<[HeroPath["name"], unknown[]]> = [
    ["keypress", [...answer, ...menuReply("1", "scheduler")]],
    ["timeout", [...answer, ...menuReply(undefined, "scheduler")]],
  ];
  return paths.map(([name, object]) => {
    const parsed = parseNcco(object);
    const actions = parsed.actions.map((a, i) => ({ ...a, index: i }));
    const ev = evaluatePath(actions, { declaration: DECLARATION, facts: FACTS, terminal: true });
    return { name, actions, labels: actions.map((a) => `${a.action}#${a.index}`), verdicts: ev.verdicts, failed: ev.verdicts.find((v) => v.verdict === "false") };
  });
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  state: "" | "is-blocked" | "is-passed";
}

const NS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
};

const describe = (a: NccoAction): string => {
  switch (a.action) {
    case "talk":
      return `"${(a as { text?: string }).text?.slice(0, 21) ?? ""}…"`;
    case "input":
      return "waits for a key, 5 s";
    case "connect":
      return "connects the scheduler";
    default:
      return a.action;
  }
};

/** Draws the graph into `host` and animates the red branch. Returns the failed verdict of the timeout path for the copy beside it. */
export function renderHeroGraph(host: HTMLElement): HeroPath[] {
  const paths = heroPaths();
  const timeout = paths.find((p) => p.name === "timeout");
  const keypress = paths.find((p) => p.name === "keypress");
  if (!timeout || !keypress) return paths;
  const W = 760;
  const H = 300;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "flow", role: "img", "aria-labelledby": "hero-graph-title hero-graph-desc" });
  svg.appendChild(el("title", { id: "hero-graph-title" }, "The reference application's call flow, evaluated by the engine"));
  const failedText = timeout.failed ? `${timeout.failed.id}, ${timeout.failed.citation}, false on the timeout branch: ${timeout.labels.join(" then ")}` : "every property holds";
  svg.appendChild(el("desc", { id: "hero-graph-desc" }, `Two paths from the same answer object. Keypress 1 connects a scheduler and passes. Silence reaches a synthesized voice with no opt-out: ${failedText}.`));

  const shared = timeout.actions.slice(0, 2);
  const boxes: Box[] = [
    { id: "n0", x: 10, y: 118, w: 210, h: 64, title: `${shared[0]?.action}#0`, sub: shared[0] ? describe(shared[0]) : "", state: "" },
    { id: "n1", x: 250, y: 118, w: 190, h: 64, title: `${shared[1]?.action}#1`, sub: shared[1] ? describe(shared[1]) : "", state: "" },
    { id: "k2", x: 500, y: 20, w: 230, h: 64, title: `${keypress.actions[2]?.action}#2`, sub: keypress.actions[2] ? describe(keypress.actions[2]) : "", state: "is-passed" },
    { id: "t2", x: 500, y: 216, w: 230, h: 64, title: `${timeout.actions[2]?.action}#2`, sub: timeout.actions[2] ? describe(timeout.actions[2]) : "", state: "is-blocked" },
  ];
  const edgeGroup = el("g");
  const edge = (from: Box, to: Box, label: string, cls: string): SVGPathElement => {
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const mx = (x1 + x2) / 2;
    const p = el("path", { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, class: `edge ${cls}` });
    edgeGroup.appendChild(p);
    edgeGroup.appendChild(el("text", { x: mx, y: (y1 + y2) / 2 - 8, class: "edge-label", "text-anchor": "middle" }, label));
    return p;
  };
  const b = (id: string) => boxes.find((x) => x.id === id) as Box;
  edge(b("n0"), b("n1"), "then", "");
  const okEdge = edge(b("n1"), b("k2"), "presses 1", "is-passed");
  const redEdge = edge(b("n1"), b("t2"), "stays silent", "is-blocked");
  svg.appendChild(edgeGroup);

  const nodeEls = new Map<string, SVGGElement>();
  for (const box of boxes) {
    const g = el("g", { class: `node ${box.state}`, transform: `translate(${box.x},${box.y})` });
    g.appendChild(el("rect", { width: box.w, height: box.h }));
    g.appendChild(el("text", { x: 14, y: 26, class: "label" }, box.title));
    g.appendChild(el("text", { x: 14, y: 46 }, box.sub));
    svg.appendChild(g);
    nodeEls.set(box.id, g);
  }
  // The end of the object after the red branch, and the citation the engine printed.
  svg.appendChild(el("circle", { cx: 748, cy: 248, r: 6, class: "end" }));
  const cite = el("text", { x: 500, y: 296, class: "citation" }, timeout.failed ? `${timeout.failed.id} false: ${timeout.failed.citation}` : "");
  svg.appendChild(cite);
  const note = el("text", { x: 250, y: 60, class: "hand-note", transform: "rotate(-4 250 60)" }, "the branch nobody traced");
  svg.appendChild(note);

  host.replaceChildren(svg);

  if (!prefersReducedMotion()) {
    const t2 = nodeEls.get("t2");
    gsap.set([redEdge, okEdge], { drawSVG: "0%" });
    gsap.set([cite, note], { opacity: 0 });
    if (t2) gsap.set(t2, { opacity: 0.35 });
    gsap
      .timeline({ delay: 0.4 })
      .to(okEdge, { drawSVG: "100%", duration: 0.6, ease: "power2.out" })
      .to(redEdge, { drawSVG: "100%", duration: 0.7, ease: "power2.out" }, "<0.1")
      .to(t2 ?? {}, { opacity: 1, duration: 0.3 }, "-=0.2")
      .fromTo(cite, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.4 })
      .to(note, { opacity: 1, duration: 0.4 }, "<");
  }
  return paths;
}

/** A span with a class and text content; nothing is ever parsed as HTML. */
export function span(className: string, text: string, decorative = false): HTMLSpanElement {
  const s = document.createElement("span");
  if (className) s.className = className;
  s.textContent = text;
  if (decorative) s.setAttribute("aria-hidden", "true");
  return s;
}

/** The verdict list for one path, as a `ul.verdicts` the sandbox also uses. */
export function renderVerdictList(verdicts: readonly PropertyVerdict[], titles: Record<string, string>): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "verdicts";
  for (const v of verdicts) {
    const li = document.createElement("li");
    const state = v.verdict === "true" ? "passed" : v.verdict === "false" ? "blocked" : "held";
    li.className = `is-${state}`;
    const word = v.verdict === "true" ? "pass" : v.verdict === "false" ? "FAIL" : "hold";
    li.append(span("dot", "", true), span("state", word), span("", `${v.id} ${titles[v.id] ?? ""}`), span("muted", v.citation));
    if (v.witness && v.witness.length > 0) {
      const w = document.createElement("span");
      w.className = "witness";
      w.textContent = `witness: ${v.witness.map((s) => s.label).join(" > ")}${v.atEnd ? " > end of flow" : ""}`;
      li.appendChild(w);
    }
    if (v.reason) {
      const r = document.createElement("span");
      r.className = "reason";
      r.textContent = v.reason;
      li.appendChild(r);
    }
    ul.appendChild(li);
  }
  return ul;
}
