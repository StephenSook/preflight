/**
 * One-click install and rollback through the Vonage Application API (plan addition A5). The Setup
 * screen asks for the application id and the account's API key and secret; Preflight reads the
 * application, records its current voice webhooks, points them at itself with signed callbacks on,
 * reads the application back and refuses to report success unless what came back is what was
 * written. Rollback writes the recorded webhooks back the same way. The credentials are used for
 * the two or three requests and kept nowhere: not in the store, not in the log, not in the ledger.
 */

export interface Hook {
  address: string;
  http_method: "GET" | "POST";
}

export interface VoiceWebhooks {
  answer: Hook;
  event: Hook;
  fallback: Hook;
}

export interface Credentials {
  applicationId: string;
  apiKey: string;
  apiSecret: string;
}

export interface ApplicationView {
  id: string;
  name: string;
  webhooks: VoiceWebhooks | undefined;
  signedCallbacks: boolean | undefined;
}

export type ApplicationResult = { ok: true; raw: Record<string, unknown>; view: ApplicationView } | { ok: false; status: number; error: string };

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined);

/** A hook the platform reports is only a hook when both its address and its method are exactly what was written; a missing or foreign method fails the read-back. */
function hookOf(v: unknown): Hook | undefined {
  const r = asRecord(v);
  const address = r?.["address"];
  const method = r?.["http_method"];
  if (typeof address !== "string" || address.length === 0) return undefined;
  if (method !== "GET" && method !== "POST") return undefined;
  return { address, http_method: method };
}

export function viewOf(raw: Record<string, unknown>): ApplicationView {
  const voice = asRecord(asRecord(raw["capabilities"])?.["voice"]);
  const w = asRecord(voice?.["webhooks"]);
  const answer = hookOf(w?.["answer_url"]);
  const event = hookOf(w?.["event_url"]);
  const fallback = hookOf(w?.["fallback_answer_url"]);
  const signed = voice?.["signed_callbacks"];
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : "",
    name: typeof raw["name"] === "string" ? raw["name"] : "",
    webhooks: answer && event && fallback ? { answer, event, fallback } : undefined,
    signedCallbacks: typeof signed === "boolean" ? signed : undefined,
  };
}

/** The three hooks that point an application at this host. GET for answer and fallback, as the reference deployment runs. */
export function preflightWebhooks(publicBaseUrl: string): VoiceWebhooks {
  const base = publicBaseUrl.replace(/\/$/, "");
  return {
    answer: { address: `${base}/v/answer`, http_method: "GET" },
    event: { address: `${base}/v/event`, http_method: "POST" },
    fallback: { address: `${base}/v/fallback`, http_method: "GET" },
  };
}

export const sameHooks = (a: VoiceWebhooks | undefined, b: VoiceWebhooks): boolean =>
  a !== undefined && (["answer", "event", "fallback"] as const).every((k) => a[k].address === b[k].address && a[k].http_method === b[k].http_method);

export interface ApplicationApiOptions {
  fetchImpl: typeof fetch;
  host?: string;
  timeoutMs?: number;
}

function errorText(status: number, body: unknown): string {
  const b = asRecord(body);
  const title = typeof b?.["title"] === "string" ? (b["title"] as string) : undefined;
  const detail = typeof b?.["detail"] === "string" ? (b["detail"] as string) : undefined;
  return [title, detail].filter(Boolean).join(": ") || `HTTP ${status}`;
}

async function call(method: "GET" | "PUT", creds: Credentials, opts: ApplicationApiOptions, body?: unknown): Promise<{ status: number; body: unknown }> {
  const host = (opts.host ?? "https://api.nexmo.com").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await opts.fetchImpl(`${host}/v2/applications/${encodeURIComponent(creds.applicationId)}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString("base64")}`, accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: { title: "request failed", detail: err instanceof Error ? err.message : String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

export async function readApplication(creds: Credentials, opts: ApplicationApiOptions): Promise<ApplicationResult> {
  const r = await call("GET", creds, opts);
  const raw = asRecord(r.body);
  if (r.status !== 200 || !raw) return { ok: false, status: r.status, error: errorText(r.status, r.body) };
  return { ok: true, raw, view: viewOf(raw) };
}

/**
 * Writes the voice webhooks (and turns signed callbacks on), then reads the application back.
 * Success means the read-back matches what was written; anything else is reported, never assumed.
 */
export async function writeWebhooks(creds: Credentials, raw: Record<string, unknown>, webhooks: VoiceWebhooks, opts: ApplicationApiOptions): Promise<ApplicationResult> {
  const capabilities = { ...(asRecord(raw["capabilities"]) ?? {}) };
  const voice = { ...(asRecord(capabilities["voice"]) ?? {}) };
  voice["webhooks"] = {
    ...(asRecord(voice["webhooks"]) ?? {}),
    answer_url: { address: webhooks.answer.address, http_method: webhooks.answer.http_method },
    event_url: { address: webhooks.event.address, http_method: webhooks.event.http_method },
    fallback_answer_url: { address: webhooks.fallback.address, http_method: webhooks.fallback.http_method },
  };
  voice["signed_callbacks"] = true;
  capabilities["voice"] = voice;
  const put = await call("PUT", creds, opts, { name: raw["name"], capabilities });
  if (put.status !== 200) return { ok: false, status: put.status, error: errorText(put.status, put.body) };
  const back = await readApplication(creds, opts);
  if (!back.ok) return back;
  if (!sameHooks(back.view.webhooks, webhooks)) return { ok: false, status: 502, error: "the application read back does not carry the webhooks that were written" };
  if (back.view.signedCallbacks !== true) return { ok: false, status: 502, error: "the application read back does not have signed callbacks on" };
  return back;
}
