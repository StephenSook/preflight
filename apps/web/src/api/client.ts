/**
 * The host's public and token routes, typed as docs/api.md describes them. The base URL is the same
 * origin in development (Vite proxies /api) and the deployed host in production, so no surface
 * hard-codes a number: everything a visitor sees is read from here on load.
 */
export const API_BASE: string = (import.meta.env["VITE_API_URL"] as string | undefined)?.replace(/\/$/, "") ?? (import.meta.env.DEV ? "" : "https://preflight-api-rc34.onrender.com");

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers["authorization"] = `Bearer ${init.token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30000) });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export interface Summary {
  decisions: { pass: number; block: number; hold: number };
  ledger: { seq: number; entry_hash: string };
  coverage: { declared: string[]; observed: string[]; unobserved: string[]; states: number; edges: number; branchPoints: number; openBranches: string[] };
  latency: { sample: number; verifyP50Ms: number | null; verifyP95Ms: number | null; originP50Ms: number | null; originP95Ms: number | null };
  reconciliation: { ts: string; seq: number; window: { start: string; end: string }; carrier_records: number; matched: number; unmatched: number; leaks: number; refused_in_window: number; decided_not_in_records: number | null } | null;
  policy: "strict" | "advisory";
}

export interface RateProperty {
  id: "P6" | "P7" | "P8";
  title: string;
  citation: string;
  verdict: "true" | "false" | "inconclusive";
  figure: number | null;
  unit: "fraction" | "seconds";
  n: number;
  basis: string;
}

export interface Campaign {
  window: { start: string; end: string };
  events: number;
  calls: number;
  outbound: number;
  inProgress: number;
  answered: number;
  answeredByPerson: number;
  machineAnswered: number;
  abandoned: number;
  unanswered: number;
  medianAnsweredDurationSeconds: number | null;
  properties: RateProperty[];
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  kind: string;
  call_uuid: string | null;
  decision: "pass" | "block" | "hold" | null;
  property: string | null;
  citation: string | null;
  witness: string[];
  ncco_hash: string | null;
  line_type: { value: string; source: string; conf: string } | null;
  detail: Record<string, unknown> | null;
  prev_hash: string;
  entry_hash: string;
}

export interface FlowNode {
  id: string;
  endpoint: string;
  index: number;
  action: string;
  label: string;
  status: "declared" | "undeclared";
  speaksSynthetic: boolean;
  observations: number;
  firstSeen: string;
  lastSeen: string;
  text?: string;
}

export interface FlowDiffView {
  nodes: FlowNode[];
  edges: Array<{ from: string; to: string; kind: "sequential" | "input_branch" | "notify_branch" | string; observations: number }>;
  roots: string[];
  missing: Array<{ endpoint: string; index: number; action: string; label: string }>;
  openBranches: string[];
  declared: string[];
  counts: { states: number; declared: number; undeclared: number; undeclaredSpeaking: number; neverObserved: number; endpointsDeclared: number; endpointsObserved: number };
}

export interface Hold {
  holdId: string;
  callUuid: string | undefined;
  humanParty: string;
  reason: string;
  verdicts: Array<{ id: string; verdict: string; citation: string; reason?: string }>;
  status: "open" | "placed" | "cancelled";
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  lookup?: { state: "pending" | "ok" | "error" | "none" | "off"; record?: Record<string, unknown> };
}

export interface SetupView {
  urls: { answer: string; event: string; fallback: string };
  origin: string | null;
  policy: "strict" | "advisory";
  declaration: { value: Record<string, unknown>; source: "environment" | "stored"; hash: string; by: string | null; at: string | null };
}

export interface DecisionEvent {
  decision: "pass" | "block" | "hold";
  direction: string;
  humanParty: string;
  reason?: string;
  verdicts: Array<{ id: string; verdict: string; citation: string }>;
  decidedAt: string;
  callUuid?: string;
  verifyLatencyMs?: number;
  originLatencyMs?: number | null;
  facts?: { state?: string; rateCenter?: string; lineType?: string; lineTypeSource?: string; lineTypeConfidence?: string; withinHours?: boolean };
  terminal?: boolean;
  holdId?: string;
  seq?: number;
}

export const api = {
  summary: () => request<Summary>("/api/summary"),
  campaign: () => request<Campaign>("/api/campaign"),
  ledgerHead: () => request<{ seq: number; entry_hash: string }>("/api/ledger/head"),
  ledgerEntries: async (after: number, limit: number) => (await request<{ after: number; entries: LedgerEntry[] }>(`/api/ledger/entries?after=${after}&limit=${limit}`)).entries,
  ledgerVerify: () => request<{ ok: boolean; entries: number; head: string; brokenAt?: number }>("/api/ledger/verify"),
  flow: () => request<FlowDiffView>("/api/flow"),
  held: (token: string, status: "open" | "all" = "open") => request<{ status: string; lookups: "on" | "off"; holds: Hold[] }>(`/api/held?status=${status}&limit=50`, { token }),
  decide: (token: string, id: string, action: "place" | "cancel", by: string) => request<{ hold: Hold; ledger: LedgerEntry }>(`/api/held/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify({ action, by }), token }),
  setup: (token: string) => request<SetupView>("/api/setup", { token }),
  putDeclaration: (token: string, declaration: unknown, by: string) => request<SetupView & { ledger: LedgerEntry }>("/api/setup/declaration", { method: "PUT", body: JSON.stringify({ declaration, by }), token }),
  install: (token: string, body: { application_id: string; api_key: string; api_secret: string; by: string }) => request<Record<string, unknown>>("/api/setup/install", { method: "POST", body: JSON.stringify(body), token }),
  rollback: (token: string, body: { application_id: string; api_key: string; api_secret: string; by: string; previous: unknown }) => request<Record<string, unknown>>("/api/setup/rollback", { method: "POST", body: JSON.stringify(body), token }),
  vapid: () => request<{ publicKey: string }>("/api/push/vapid"),
  subscribePush: (token: string, subscription: unknown, label: string) => request<{ subscribed: boolean; endpoint: string; subscriptions: number }>("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription, label }), token }),
  unsubscribePush: (token: string, endpoint: string) => request<{ removed: boolean }>("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint }), token }),
  testPush: (token: string) => request<{ attempted: number; delivered: number; retired: number; failed: number }>("/api/push/test", { method: "POST", token }),
  softphoneToken: (role: "judge" | "scheduler", token?: string) => request<{ role: string; user: string; token: string; expires_at: string; application_id: string; created: boolean }>("/api/softphone/token", { method: "POST", body: JSON.stringify({ role }), ...(token ? { token } : {}) }),
  consentStart: (number: string) => request<{ request_id: string; channel: string; number: string; next: string }>("/api/consent/start", { method: "POST", body: JSON.stringify({ number }) }),
  consentCheck: (request_id: string, code: string) => request<{ granted: boolean; request_id: string; expires_at: string }>("/api/consent/check", { method: "POST", body: JSON.stringify({ request_id, code }) }),
  demoCall: (request_id: string) => request<Record<string, unknown>>("/api/demo/call", { method: "POST", body: JSON.stringify({ request_id }) }),
};

/** The decision stream, replaying the last `replay` decisions on connect. Returns a close function. */
export function openStream(token: string, replay: number, onDecision: (d: DecisionEvent) => void, onState: (s: "open" | "closed") => void): () => void {
  const source = new EventSource(`${API_BASE}/api/stream?replay=${replay}&token=${encodeURIComponent(token)}`);
  source.addEventListener("open", () => onState("open"));
  source.addEventListener("error", () => onState("closed"));
  const handle = (ev: MessageEvent<string>) => {
    try {
      onDecision(JSON.parse(ev.data) as DecisionEvent);
    } catch {
      // A malformed frame is dropped; the next one arrives on its own.
    }
  };
  source.addEventListener("decision", handle as EventListener);
  source.addEventListener("message", handle as EventListener);
  return () => source.close();
}

/** Masks a number the way the host does in its logs: country code, area code, the last four. */
export function maskNumber(n: string): string {
  const d = n.replace(/\D/g, "");
  if (d.length < 8) return n;
  return `+${d.slice(0, 1)} ${d.slice(1, 4)} *** ${d.slice(-4)}`;
}
