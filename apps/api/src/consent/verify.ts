/**
 * Vonage Verify v2 over the voice channel: the platform calls the number and speaks a code. The
 * request is authenticated with an application JWT minted by this process; the token function is
 * injected so tests never need a key.
 */
export type VerifyStart = { ok: true; requestId: string } | { ok: false; status: number; error: string };
export type VerifyCheck = { ok: true } | { ok: false; status: number; error: string };

export interface VerifyClient {
  start(number: string): Promise<VerifyStart>;
  check(requestId: string, code: string): Promise<VerifyCheck>;
}

export interface VerifyClientOptions {
  apiHost: string;
  fetchImpl: typeof fetch;
  token: () => string;
  brand?: string;
  /** Seconds the platform waits for the code before the request expires. */
  channelTimeoutSeconds?: number;
}

const USER_AGENT = "preflight/0.1 (+https://github.com/StephenSook/preflight)";

function errorText(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const b = body as { title?: unknown; detail?: unknown };
    const title = typeof b.title === "string" ? b.title : undefined;
    const detail = typeof b.detail === "string" ? b.detail : undefined;
    if (title || detail) return [title, detail].filter(Boolean).join(": ");
  }
  return `HTTP ${status}`;
}

export function vonageVerify(opts: VerifyClientOptions): VerifyClient {
  const base = opts.apiHost.replace(/\/$/, "");
  const brand = opts.brand ?? "Preflight";
  const timeout = opts.channelTimeoutSeconds ?? 120;

  async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await opts.fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token()}`, "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = undefined;
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

  return {
    async start(number) {
      const r = await post(`${base}/v2/verify`, { brand, workflow: [{ channel: "voice", to: number }], code_length: 4, channel_timeout: timeout });
      const id = typeof r.body === "object" && r.body !== null ? (r.body as { request_id?: unknown }).request_id : undefined;
      if ((r.status === 202 || r.status === 200) && typeof id === "string" && id.length > 0) return { ok: true, requestId: id };
      return { ok: false, status: r.status, error: errorText(r.status, r.body) };
    },
    async check(requestId, code) {
      const r = await post(`${base}/v2/verify/${encodeURIComponent(requestId)}`, { code });
      if (r.status === 200) return { ok: true };
      return { ok: false, status: r.status, error: errorText(r.status, r.body) };
    },
  };
}
