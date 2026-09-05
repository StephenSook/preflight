/**
 * The cockpit shell: header (name, live dot, coverage, latency), the six-screen navigation on hash
 * routes, the token prompt, and the screen mount. Screens live beside this file and receive the
 * shared state (token, summary, stream) through one small store.
 */
import { api, openStream, type DecisionEvent, type Summary } from "../api/client.js";
import { el, text } from "./dom.js";
import { renderBlockDetail } from "./screens/block.js";
import { renderFlowGraph } from "./screens/graph.js";
import { renderHeldQueue } from "./screens/held.js";
import { renderLiveMonitor } from "./screens/live.js";
import { renderEvidenceLog } from "./screens/log.js";
import { renderSetup } from "./screens/setup.js";

export type ScreenId = "live" | "block" | "graph" | "held" | "log" | "setup";
const SCREENS: Array<{ id: ScreenId; label: string; needsToken: boolean }> = [
  { id: "live", label: "Live monitor", needsToken: true },
  { id: "block", label: "Block detail", needsToken: true },
  { id: "graph", label: "Flow graph", needsToken: false },
  { id: "held", label: "Held queue", needsToken: true },
  { id: "log", label: "Evidence log", needsToken: false },
  { id: "setup", label: "Setup", needsToken: true },
];

export interface CockpitState {
  token: string | null;
  summary: Summary | null;
  decisions: DecisionEvent[];
  streamState: "open" | "closed" | "off";
  listeners: Set<() => void>;
}

const TOKEN_KEY = "preflight:dashboard-token";

export function mountCockpit(host: HTMLElement): void {
  const state: CockpitState = { token: readToken(), summary: null, decisions: [], streamState: "off", listeners: new Set() };
  const notify = () => state.listeners.forEach((l) => l());

  const header = el("header", { class: "cockpit-header" });
  const brand = el("div", { class: "brand" }, [el("span", { class: "name" }, "PREFLIGHT"), el("span", { class: "live", "data-live-dot": "" }, [el("span", { class: "dot", "aria-hidden": "true" }), el("span", { "data-stream-word": "" }, "OFF")])]);
  const meta = el("div", { class: "meta", "data-meta": "" });
  const nav = el("nav", { class: "screens", "aria-label": "Screens" });
  for (const s of SCREENS) nav.appendChild(el("a", { href: `#${s.id}`, "data-screen-link": s.id }, s.label));
  const tokenForm = el("form", { class: "token", "data-token-form": "" }, [
    el("label", { for: "dash-token", class: "visually-hidden" }, "Dashboard token"),
    el("input", { id: "dash-token", type: "password", placeholder: "dashboard token", autocomplete: "off", value: state.token ?? "" }),
    el("button", { type: "submit", class: "button is-cobalt" }, [el("span", { class: "label" }, state.token ? "Update" : "Unlock")]),
  ]);
  header.append(brand, nav, meta, tokenForm);
  const main = el("main", { id: "screen", class: "screen", tabindex: "-1" });
  host.replaceChildren(header, main);

  tokenForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = tokenForm.querySelector<HTMLInputElement>("input");
    const value = input?.value.trim() ?? "";
    state.token = value.length > 0 ? value : null;
    try {
      if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Session storage may be unavailable; the token then lives for this page only.
    }
    connect();
    route();
  });

  let closeStream: (() => void) | null = null;
  const connect = () => {
    closeStream?.();
    closeStream = null;
    state.decisions = [];
    state.streamState = "off";
    if (!state.token) return notify();
    closeStream = openStream(
      state.token,
      50,
      (d) => {
        state.decisions = [d, ...state.decisions].slice(0, 200);
        notify();
      },
      (s) => {
        state.streamState = s;
        notify();
      },
    );
  };

  const refreshSummary = async () => {
    try {
      state.summary = await api.summary();
    } catch {
      state.summary = null;
    }
    notify();
  };

  const renderHeader = () => {
    const s = state.summary;
    const word = header.querySelector("[data-stream-word]");
    const liveEl = header.querySelector("[data-live-dot]");
    if (word) word.textContent = state.token ? (state.streamState === "open" ? "LIVE" : state.streamState === "closed" ? "RECONNECTING" : "CONNECTING") : "LOCKED";
    liveEl?.classList.toggle("is-open", state.streamState === "open");
    text(meta, s ? `coverage ${s.coverage.observed.length} of ${s.coverage.declared.length} endpoints · ${s.coverage.states} states · ${s.coverage.openBranches.length} open · verify p50 ${s.latency.verifyP50Ms?.toFixed(0) ?? "n/a"} ms · origin p50 ${s.latency.originP50Ms?.toFixed(0) ?? "n/a"} ms · policy ${s.policy}` : "reading the host…");
  };

  const route = () => {
    const id = (location.hash.replace(/^#/, "").split("/")[0] || "live") as ScreenId;
    const arg = location.hash.split("/")[1] ?? "";
    const screen = SCREENS.find((s) => s.id === id) ?? SCREENS[0]!;
    for (const a of nav.querySelectorAll<HTMLAnchorElement>("[data-screen-link]")) a.setAttribute("aria-current", a.dataset["screenLink"] === screen.id ? "page" : "false");
    main.replaceChildren();
    if (screen.needsToken && !state.token) {
      main.append(el("div", { class: "locked" }, [el("h1", { class: "display display-s" }, screen.label), el("p", {}, "This screen carries phone numbers and decisions, so it needs the dashboard token. Enter it above; it stays in this tab's session only.")]));
      return;
    }
    const ctx = { state, host: main, arg, refresh: refreshSummary };
    switch (screen.id) {
      case "live":
        renderLiveMonitor(ctx);
        break;
      case "block":
        renderBlockDetail(ctx);
        break;
      case "graph":
        renderFlowGraph(ctx);
        break;
      case "held":
        renderHeldQueue(ctx);
        break;
      case "log":
        renderEvidenceLog(ctx);
        break;
      case "setup":
        renderSetup(ctx);
        break;
    }
  };

  state.listeners.add(renderHeader);
  window.addEventListener("hashchange", route);
  connect();
  void refreshSummary();
  setInterval(() => void refreshSummary(), 30000);
  route();
  renderHeader();
}

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export interface ScreenContext {
  state: CockpitState;
  host: HTMLElement;
  arg: string;
  refresh: () => Promise<void>;
}
