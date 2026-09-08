/**
 * Held queue: every call the interlock could not decide under strict policy, the reason, the
 * Identity Insights lookup state, and two buttons that need a name. Every override is a ledger
 * entry, and the screen says so. The only handwriting on the dashboard is the empty state.
 */
import { api, ApiError, maskNumber, type Hold } from "../../api/client.js";
import type { ScreenContext } from "../cockpit.js";
import { el, fmtDate } from "../dom.js";

const NAME_KEY = "preflight:decider-name";

export function renderHeldQueue(ctx: ScreenContext): void {
  const { state, host, refresh } = ctx;
  const token = state.token ?? "";
  host.append(el("h1", {}, "Held queue"), el("p", { class: "sub" }, "A call the interlock could not decide waits here for a person. Approving a release does not place a call: the caller must resubmit the request. Every override is a ledger entry."));
  const name = el("input", { type: "text", placeholder: "your name, for the ledger", value: readName() });
  name.addEventListener("change", () => {
    try {
      localStorage.setItem(NAME_KEY, name.value.trim());
    } catch {
      // Nothing to keep; the name is asked again next time.
    }
  });
  host.append(el("div", { class: "byline" }, [el("label", { for: "decider" }, "Deciding as"), name]));
  name.id = "decider";
  const status = el("p", { class: "note", "aria-live": "polite" });
  const actionStatus = el("p", { class: "note", "aria-live": "polite", "data-hold-action-status": "" });
  const list = el("div", { class: "rows" });
  host.append(status, actionStatus, list);

  const load = async () => {
    try {
      const r = await api.held(token, "open");
      status.classList.remove("is-error");
      status.textContent = `lookups ${r.lookups}; showing ${r.holds.length} open holds (up to 50, not a total)`;
      list.replaceChildren();
      list.append(el("h2", {}, "Open holds"));
      if (r.holds.length === 0) list.append(el("div", { class: "empty" }, "No open holds returned by the latest query."));
      for (const h of r.holds) list.append(holdCard(h));
      const history = el("section", {}, [el("h2", {}, "Recent history"), el("p", { class: "note" }, "Closed holds among the 50 most recent holds, not a complete history.")]);
      list.append(history);
      try {
        const recent = await api.held(token, "all");
        const closed = recent.holds.filter((hold) => hold.status !== "open");
        if (closed.length === 0) history.append(el("p", {}, "No closed holds in this recent subset."));
        for (const hold of closed) history.append(holdCard(hold));
      } catch {
        history.append(el("p", { class: "is-error" }, "Recent history unavailable. Open holds are shown above."));
      }
    } catch (err) {
      list.replaceChildren();
      status.textContent = err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      status.classList.add("is-error");
    }
  };

  const holdCard = (h: Hold): HTMLElement => {
    const lookup = h.lookup ? `lookup ${h.lookup.state}${h.lookup.record ? `: ${JSON.stringify(h.lookup.record).slice(0, 120)}` : ""}` : "lookup off";
    const named = h.verdicts.find((v) => v.verdict === "inconclusive");
    const card = el("div", { class: `hold is-${h.status}` }, [
      el("div", {}, [
        el("div", { class: "reason" }, `${maskNumber(h.humanParty)} · ${h.reason}`),
        el("div", { class: "facts" }, `${named ? `${named.id} · ${named.citation} · ` : ""}${lookup} · held ${fmtDate(h.createdAt)} UTC${h.status !== "open" ? ` · ${h.status === "placed" ? "release approved (not confirmation of call placement)" : "cancelled"}${h.decidedBy ? ` by ${h.decidedBy}` : ""}` : ""}`),
      ]),
    ]);
    if (h.status === "open") {
      const place = el("button", { class: "button is-cobalt", type: "button" }, [el("span", { class: "label" }, "Approve release")]);
      const cancel = el("button", { class: "button is-danger", type: "button" }, [el("span", { class: "label" }, "Cancel")]);
      const act = async (action: "place" | "cancel") => {
        actionStatus.textContent = "";
        const by = name.value.trim();
        if (!by) {
          status.textContent = "a name is needed: the override is written to the ledger with it";
          name.focus();
          return;
        }
        place.disabled = cancel.disabled = true;
        try {
          const r = await api.decide(token, h.holdId, action, by);
          actionStatus.textContent = `${action === "place" ? "release approved; no call placed by this action. The caller must resubmit the request" : "cancelled"}: ledger entry ${r.ledger.seq}`;
          await refresh();
          await load();
        } catch (err) {
          status.textContent = err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
          place.disabled = cancel.disabled = false;
        }
      };
      place.addEventListener("click", () => void act("place"));
      cancel.addEventListener("click", () => void act("cancel"));
      card.append(el("div", { class: "actions" }, [place, cancel]));
    }
    return card;
  };

  void load();
  const timer = setInterval(() => void load(), 15000);
  state.listeners.add(() => {
    if (!document.body.contains(list)) clearInterval(timer);
  });
}

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}
