/**
 * The phone page: two cards. Notifications: this phone subscribes to held-queue pushes (service
 * worker, VAPID key from the host, subscription stored with the dashboard token). Softphone: a
 * judge token from the host, a Client SDK session, one call to the reference flow so the interlock
 * is heard intervening. The SDK loads only when asked, so the page itself stays small.
 */
import { api, ApiError } from "../api/client.js";
import { el } from "../app/dom.js";

const TOKEN_KEY = "preflight:dashboard-token";
const PUBLIC_NUMBER = "19432445023";

export function mountPhone(host: HTMLElement): void {
  const page = el("main", { id: "main", class: "phone" });
  page.append(el("a", { href: "/", class: "back" }, "← preflight"), el("h1", { class: "display display-m" }, "On the phone"));
  page.append(notificationsCard(), softphoneCard());
  host.replaceChildren(page);
}

function statusLine(): HTMLElement {
  return el("p", { class: "status", "aria-live": "polite" });
}
function say(node: HTMLElement, msg: string, kind: "" | "is-error" | "is-ok" = ""): void {
  node.textContent = msg;
  node.className = `status ${kind}`;
}
const describe = (err: unknown): string => (err instanceof ApiError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err));

function notificationsCard(): HTMLElement {
  const token = el("input", { type: "password", placeholder: "dashboard token", autocomplete: "off" });
  try {
    token.value = sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    // No stored token; it is typed.
  }
  const subscribe = el("button", { class: "button is-cobalt", type: "button" }, [el("span", { class: "label" }, "Subscribe this phone")]);
  const test = el("button", { class: "button", type: "button" }, [el("span", { class: "label" }, "Send a test push")]);
  const remove = el("button", { class: "button", type: "button" }, [el("span", { class: "label" }, "Unsubscribe")]);
  const status = statusLine();
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const card = el("section", { class: "card", "aria-labelledby": "notif-title" }, [
    el("h2", { id: "notif-title" }, "Held-queue notifications"),
    el("p", {}, "A hold under strict policy is pushed here after the decision has gone out: the number masked, the property and its reason, a link to the row."),
    el("label", { for: "phone-token" }, "Dashboard token"),
    token,
    el("div", { class: "row" }, [subscribe, test, remove]),
    status,
  ]);
  token.id = "phone-token";
  if (!supported) say(status, "This browser does not support Web Push. On iOS, add the page to the Home Screen first.", "is-error");
  const keep = () => {
    try {
      sessionStorage.setItem(TOKEN_KEY, token.value.trim());
    } catch {
      // Nothing to keep.
    }
    return token.value.trim();
  };
  const b64ToBytes = (s: string): Uint8Array => {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  subscribe.addEventListener("click", async () => {
    const t = keep();
    if (!t) return say(status, "the dashboard token is needed: a subscription receives held numbers", "is-error");
    subscribe.disabled = true;
    try {
      const { publicKey } = await api.vapid();
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(`notification permission ${permission}`);
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) as BufferSource }));
      const r = await api.subscribePush(t, sub.toJSON(), navigator.userAgent.slice(0, 60));
      say(status, `subscribed: ${r.subscriptions} phone${r.subscriptions === 1 ? "" : "s"} on the host`, "is-ok");
    } catch (err) {
      say(status, describe(err), "is-error");
    } finally {
      subscribe.disabled = false;
    }
  });
  test.addEventListener("click", async () => {
    const t = keep();
    if (!t) return say(status, "the dashboard token is needed", "is-error");
    test.disabled = true;
    try {
      const r = await api.testPush(t);
      say(status, `test push: ${r.delivered} delivered, ${r.retired} retired, ${r.failed} failed of ${r.attempted}`, r.failed > 0 ? "is-error" : "is-ok");
    } catch (err) {
      say(status, describe(err), "is-error");
    } finally {
      test.disabled = false;
    }
  });
  remove.addEventListener("click", async () => {
    const t = keep();
    remove.disabled = true;
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return say(status, "this phone holds no subscription");
      if (t) await api.unsubscribePush(t, sub.endpoint);
      await sub.unsubscribe();
      say(status, "unsubscribed", "is-ok");
    } catch (err) {
      say(status, describe(err), "is-error");
    } finally {
      remove.disabled = false;
    }
  });
  return card;
}

function softphoneCard(): HTMLElement {
  const start = el("button", { class: "button is-cobalt", type: "button" }, [el("span", { class: "label" }, "Start a session")]);
  const call = el("button", { class: "button is-primary", type: "button" }, [el("span", { class: "label" }, "Call the reference flow")]);
  const hangup = el("button", { class: "button", type: "button" }, [el("span", { class: "label" }, "Hang up")]);
  call.disabled = hangup.disabled = true;
  const state = el("div", { class: "call-state" }, "idle");
  const status = statusLine();
  const card = el("section", { class: "card", "aria-labelledby": "soft-title" }, [
    el("h2", { id: "soft-title" }, "The browser softphone"),
    el("p", {}, `No phone at hand? This places the same call to +1 943 244 5023 from the page, as a Client SDK user the host creates for you. You hear the interlock intervene on the broken flow.`),
    el("div", { class: "row" }, [start, call, hangup]),
    state,
    status,
  ]);
  let client: { createSession: (t: string) => Promise<string>; serverCall: (ctx?: Record<string, unknown>) => Promise<string>; hangup: (id: string) => Promise<void>; deleteSession: () => Promise<void>; on: (ev: string, cb: (...a: unknown[]) => void) => unknown } | null = null;
  let callId: string | null = null;
  start.addEventListener("click", async () => {
    start.disabled = true;
    say(status, "asking the host for a judge token…");
    try {
      const t = await api.softphoneToken("judge");
      say(status, `token for ${t.user}, valid until ${new Date(t.expires_at).toLocaleTimeString()}; loading the Client SDK…`);
      const sdk = (await import("@vonage/client-sdk")) as unknown as { VonageClient: new (opts?: Record<string, unknown>) => NonNullable<typeof client> };
      client = new sdk.VonageClient({});
      client.on("legStatusUpdate", (...args: unknown[]) => {
        const st = args[2] ?? args[1] ?? args[0];
        state.textContent = String(typeof st === "object" && st !== null ? JSON.stringify(st).slice(0, 40) : st);
      });
      client.on("callHangup", () => {
        state.textContent = "hung up";
        state.style.setProperty("--state", "var(--verdict-blocked)");
        callId = null;
        call.disabled = false;
        hangup.disabled = true;
      });
      client.on("sessionError", (...args: unknown[]) => say(status, `session error: ${JSON.stringify(args[0]).slice(0, 160)}`, "is-error"));
      const sessionId = await client.createSession(t.token);
      say(status, `session ${sessionId.slice(0, 12)}… as ${t.user}`, "is-ok");
      call.disabled = false;
    } catch (err) {
      say(status, describe(err), "is-error");
      start.disabled = false;
    }
  });
  call.addEventListener("click", async () => {
    if (!client) return;
    call.disabled = true;
    state.textContent = "calling";
    state.style.setProperty("--state", "var(--verdict-held)");
    try {
      callId = await client.serverCall({ to: PUBLIC_NUMBER, from: "preflight-softphone" });
      say(status, `call ${callId.slice(0, 12)}… placed; the answer webhook is the interlock's`, "is-ok");
      hangup.disabled = false;
    } catch (err) {
      say(status, describe(err), "is-error");
      state.textContent = "failed";
      state.style.setProperty("--state", "var(--verdict-blocked)");
      call.disabled = false;
    }
  });
  hangup.addEventListener("click", async () => {
    if (!client || !callId) return;
    try {
      await client.hangup(callId);
    } catch (err) {
      say(status, describe(err), "is-error");
    }
  });
  return card;
}
