/**
 * Dial it yourself: the consent gate in three steps (the platform calls the number with a code,
 * the code is checked, one demonstration call is placed through the gateway), each answer shown
 * as the host returned it. The number is sent once and never kept here.
 */
import { api, ApiError } from "../api/client.js";

export function initDial(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>("[data-consent-form]");
  const number = root.querySelector<HTMLInputElement>("[data-consent-number]");
  const code = root.querySelector<HTMLInputElement>("[data-consent-code]");
  const start = root.querySelector<HTMLButtonElement>("[data-consent-start]");
  const check = root.querySelector<HTMLButtonElement>("[data-consent-check]");
  const call = root.querySelector<HTMLButtonElement>("[data-consent-call]");
  const status = root.querySelector<HTMLElement>("[data-consent-status]");
  if (!form || !number || !code || !start || !check || !call || !status) return;
  let requestId: string | undefined;
  const say = (msg: string, error = false) => {
    status.textContent = msg;
    status.classList.toggle("is-error", error);
  };
  const fail = (err: unknown) => say(err instanceof ApiError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err), true);

  form.addEventListener("submit", (e) => e.preventDefault());
  start.addEventListener("click", async () => {
    start.disabled = true;
    say("asking the platform to call you with a code…");
    try {
      const r = await api.consentStart(number.value);
      requestId = r.request_id;
      say(`calling ${r.number} now; enter the four digits you hear`);
      code.disabled = false;
      check.disabled = false;
    } catch (err) {
      fail(err);
    } finally {
      start.disabled = false;
    }
  });
  check.addEventListener("click", async () => {
    if (!requestId) return say("start with your number", true);
    check.disabled = true;
    try {
      const r = await api.consentCheck(requestId, code.value.trim());
      say(`consent recorded until ${new Date(r.expires_at).toLocaleTimeString()}; one demonstration call may be placed`);
      call.disabled = false;
    } catch (err) {
      fail(err);
      check.disabled = false;
    }
  });
  call.addEventListener("click", async () => {
    if (!requestId) return say("start with your number", true);
    call.disabled = true;
    say("placing the call through the gateway…");
    try {
      const r = await api.demoCall(requestId);
      say(`the gateway answered ${JSON.stringify(r).slice(0, 160)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) say(`refused before the dial: ${err.message}; the consent is not spent`, true);
      else fail(err);
      call.disabled = false;
    }
  });
}
