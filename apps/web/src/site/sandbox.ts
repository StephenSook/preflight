/**
 * The browser sandbox: the same engine the host runs, on an object the visitor pastes, with no
 * account and no request. A corpus-style wrapper ({ ncco, declaration }) is unwrapped like the CLI
 * does; a bare array is the object. Calling hours are taken as inside the window, and the sandbox
 * says so, because a pasted object has no destination number.
 */
import { decide, evaluateNcco, parseNcco, PROPERTIES, type CallFacts, type FlowDeclaration } from "@preflight/engine";
import { brokenAnswer, fixedAnswer, menuReply } from "@preflight/reference";
import { renderVerdictList } from "./hero-graph.js";

const FACTS: CallFacts = { from: "12016131021", lineType: "wireless", withinHours: true };
const TITLES: Record<string, string> = Object.fromEntries(PROPERTIES.map((p) => [p.id, p.title]));
const BASE = "https://your-server.example";

export const SAMPLES: Record<string, { label: string; object: unknown; declaration?: FlowDeclaration }> = {
  broken: { label: "the broken timeout branch", object: [...brokenAnswer(BASE), ...menuReply(undefined, "scheduler")], declaration: { identification: { phrases: ["This is a message from Preflight Demo Clinic."] }, optOut: { eventUrlPatterns: ["/optout"] } } },
  fixed: { label: "the fixed flow", object: [...fixedAnswer(BASE), { action: "talk", text: "You will not receive these calls again. Goodbye." }], declaration: { identification: { phrases: ["This is a message from Preflight Demo Clinic."] }, optOut: { eventUrlPatterns: ["/optout"] } } },
  connect: { label: "connect a person, nothing spoken", object: [{ action: "connect", endpoint: [{ type: "phone", number: "14045550123" }] }] },
  garbage: { label: "not an object at all", object: { hello: "world" } },
};

function unwrap(parsed: unknown): { object: unknown; declaration?: FlowDeclaration } {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as { ncco?: unknown }).ncco)) {
    const c = parsed as { ncco: unknown; declaration?: FlowDeclaration };
    return c.declaration ? { object: c.ncco, declaration: c.declaration } : { object: c.ncco };
  }
  return { object: parsed };
}

export function initSandbox(root: HTMLElement): void {
  const input = root.querySelector<HTMLTextAreaElement>("[data-sandbox-input]");
  const out = root.querySelector<HTMLElement>("[data-sandbox-out]");
  const decisionEl = root.querySelector<HTMLElement>("[data-sandbox-decision]");
  const issuesEl = root.querySelector<HTMLElement>("[data-sandbox-issues]");
  const timing = root.querySelector<HTMLElement>("[data-sandbox-timing]");
  const declInput = root.querySelector<HTMLTextAreaElement>("[data-sandbox-declaration]");
  if (!input || !out || !decisionEl) return;

  const run = () => {
    const t0 = performance.now();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(input.value);
    } catch (err) {
      decisionEl.textContent = "not JSON";
      decisionEl.className = "decision is-held";
      out.replaceChildren();
      if (issuesEl) issuesEl.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    const { object, declaration } = unwrap(parsedJson);
    let decl = declaration;
    if (declInput && declInput.value.trim()) {
      try {
        decl = JSON.parse(declInput.value) as FlowDeclaration;
      } catch {
        // A malformed declaration is ignored; the issues line says so below.
      }
    }
    const parsed = parseNcco(object);
    const ev = evaluateNcco(parsed, { ...(decl ? { declaration: decl } : {}), facts: FACTS, terminal: true });
    const decision = decide(ev.verdicts, "strict");
    const ms = performance.now() - t0;
    decisionEl.textContent = decision === "pass" ? "cleared" : decision === "block" ? "no-go" : "hold short";
    decisionEl.className = `decision ${decision === "pass" ? "is-passed" : decision === "block" ? "is-blocked" : "is-held"}`;
    decisionEl.setAttribute("aria-label", `decision: ${decision}`);
    out.replaceChildren(renderVerdictList(ev.verdicts, TITLES));
    if (issuesEl) issuesEl.textContent = parsed.issues.length > 0 ? parsed.issues.map((i) => `${i.severity} ${i.path || "(object)"}: ${i.message}`).join("\n") : "";
    if (timing) timing.textContent = `${ms.toFixed(1)} ms in this browser, ${ev.verdicts.length} properties, calling hours taken as inside the window`;
  };

  for (const chip of root.querySelectorAll<HTMLButtonElement>("[data-sandbox-sample]")) {
    chip.addEventListener("click", () => {
      const s = SAMPLES[chip.dataset["sandboxSample"] ?? ""];
      if (!s) return;
      input.value = JSON.stringify(s.object, null, 2);
      if (declInput) declInput.value = s.declaration ? JSON.stringify(s.declaration, null, 2) : "";
      run();
    });
  }
  root.querySelector<HTMLButtonElement>("[data-sandbox-run]")?.addEventListener("click", run);
  input.addEventListener("input", () => {
    if (input.value.trim().length > 0) run();
  });
  const first = SAMPLES["broken"];
  if (first) {
    input.value = JSON.stringify(first.object, null, 2);
    if (declInput && first.declaration) declInput.value = JSON.stringify(first.declaration, null, 2);
    run();
  }
}
