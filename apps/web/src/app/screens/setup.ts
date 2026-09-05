/**
 * Setup: the three URLs to copy, the origin, the policy, the declaration in force (editable, a
 * ledger entry on save), and one-click install and rollback through the Application API. The
 * account credentials travel once to the host and are kept nowhere, here or there.
 */
import { api, ApiError, type SetupView } from "../../api/client.js";
import type { ScreenContext } from "../cockpit.js";
import { el, fmtDate } from "../dom.js";

export function renderSetup(ctx: ScreenContext): void {
  const { state, host, refresh } = ctx;
  const token = state.token ?? "";
  host.append(el("h1", {}, "Setup"), el("p", { class: "sub" }, "Point an application at this host, declare what your server serves, and roll back the same way."));
  const grid = el("div", { class: "setup" });
  host.append(grid);
  const urls = el("div", { class: "card" }, [el("h2", {}, "Where the platform should call"), el("p", { class: "note" }, "reading the host…")]);
  const decl = el("div", { class: "card" }, [el("h2", {}, "Declaration in force")]);
  const install = el("div", { class: "card" }, [el("h2", {}, "Install and roll back")]);
  grid.append(urls, decl, install);

  const byInput = el("input", { type: "text", placeholder: "your name, for the ledger" });
  const declArea = el("textarea", { spellcheck: "false", "aria-label": "Declaration JSON" });
  const declResult = el("div", { class: "result" });
  const saveBtn = el("button", { class: "button is-cobalt", type: "button" }, [el("span", { class: "label" }, "Save the declaration")]);
  decl.append(el("label", { for: "decl-by" }, "Deciding as"), byInput, el("label", { for: "decl-json" }, "identification, optOut, endpoints, flow"), declArea, saveBtn, declResult);
  byInput.id = "decl-by";
  declArea.id = "decl-json";

  const show = (view: SetupView) => {
    urls.replaceChildren(
      el("h2", {}, "Where the platform should call"),
      ...(["answer", "event", "fallback"] as const).map((k) => {
        const code = el("code", {}, view.urls[k]);
        const copy = el("button", { class: "button", type: "button" }, [el("span", { class: "label" }, "Copy")]);
        copy.addEventListener("click", () => void navigator.clipboard?.writeText(view.urls[k]).then(() => (copy.querySelector(".label")!.textContent = "Copied")));
        return el("div", { class: "url" }, [el("div", {}, [el("label", {}, `${k} URL (${k === "event" ? "POST" : "GET"})`), code]), copy]);
      }),
      el("p", { class: "note" }, `origin: ${view.origin ?? "not configured"} · policy: ${view.policy}`),
      el("p", { class: "note" }, `declaration from ${view.declaration.source}${view.declaration.by ? `, by ${view.declaration.by}` : ""}${view.declaration.at ? ` at ${fmtDate(view.declaration.at)} UTC` : ""} · ${view.declaration.hash}`),
    );
    declArea.value = JSON.stringify(view.declaration.value, null, 2);
  };
  const fail = (target: HTMLElement, err: unknown) => {
    target.textContent = err instanceof ApiError ? `${err.status}: ${err.message}${err.body && typeof err.body === "object" && "issues" in err.body ? `\n${JSON.stringify((err.body as { issues: unknown }).issues, null, 1)}` : ""}` : String(err instanceof Error ? err.message : err);
    target.className = "result is-error";
  };
  void api.setup(token).then(show).catch((err: unknown) => fail(urls, err));

  saveBtn.addEventListener("click", async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(declArea.value);
    } catch (err) {
      return fail(declResult, err);
    }
    if (!byInput.value.trim()) return fail(declResult, new Error("a name is needed: the declaration is a ledger entry with an author"));
    saveBtn.disabled = true;
    try {
      const r = await api.putDeclaration(token, parsed, byInput.value.trim());
      declResult.className = "result is-ok";
      declResult.textContent = `saved: ledger entry ${r.ledger.seq}, hash ${r.declaration.hash}`;
      show(r);
      await refresh();
    } catch (err) {
      fail(declResult, err);
    } finally {
      saveBtn.disabled = false;
    }
  });

  const appId = el("input", { type: "text", placeholder: "application id", autocomplete: "off" });
  const apiKey = el("input", { type: "text", placeholder: "API key", autocomplete: "off" });
  const apiSecret = el("input", { type: "password", placeholder: "API secret (sent once, kept nowhere)", autocomplete: "off" });
  const installBtn = el("button", { class: "button is-cobalt", type: "button" }, [el("span", { class: "label" }, "Install: point the application here")]);
  const rollbackBtn = el("button", { class: "button is-danger", type: "button" }, [el("span", { class: "label" }, "Roll back to the previous hooks")]);
  rollbackBtn.disabled = true;
  const installResult = el("div", { class: "result" });
  install.append(el("label", { for: "app-id" }, "Application"), appId, apiKey, apiSecret, el("p", { class: "note" }, "The host reads the application, records its current hooks, writes the three URLs above with signed callbacks on, and reads it back; it reports success only when the read-back matches."), el("div", { class: "byline" }, [installBtn, rollbackBtn]), installResult);
  appId.id = "app-id";
  let previous: unknown;
  const creds = () => ({ application_id: appId.value.trim(), api_key: apiKey.value.trim(), api_secret: apiSecret.value, by: byInput.value.trim() });
  const guard = (): boolean => {
    const c = creds();
    if (!c.application_id || !c.api_key || !c.api_secret || !c.by) {
      fail(installResult, new Error("application id, API key, API secret and a name are all needed"));
      return false;
    }
    return true;
  };
  installBtn.addEventListener("click", async () => {
    if (!guard()) return;
    installBtn.disabled = true;
    try {
      const r = await api.install(token, creds());
      previous = r["previous"];
      rollbackBtn.disabled = false;
      installResult.className = "result is-ok";
      installResult.textContent = `installed: ${JSON.stringify({ application: r["application"], signed_callbacks: r["signed_callbacks"], ledger: (r["ledger"] as { seq?: number } | undefined)?.seq }, null, 1)}`;
      apiSecret.value = "";
    } catch (err) {
      fail(installResult, err);
    } finally {
      installBtn.disabled = false;
    }
  });
  rollbackBtn.addEventListener("click", async () => {
    if (!guard() || !previous) return;
    rollbackBtn.disabled = true;
    try {
      const r = await api.rollback(token, { ...creds(), previous });
      installResult.className = "result is-ok";
      installResult.textContent = `rolled back: ${JSON.stringify({ current: r["current"], ledger: (r["ledger"] as { seq?: number } | undefined)?.seq }, null, 1)}`;
      apiSecret.value = "";
    } catch (err) {
      fail(installResult, err);
      rollbackBtn.disabled = false;
    }
  });
}
