/**
 * Origin forwarder. Preflight sits in series with the developer's real server, so the time spent
 * waiting on that server is measured separately from the time Preflight spends verifying, and only
 * the second number is Preflight's responsibility.
 *
 * The origin's response bytes are returned untouched. Preflight parses a copy; it never re-serialises
 * what it passes through.
 */

export interface ForwardRequest {
  method: "GET" | "POST";
  /** Absolute origin URL, already carrying the query string for GET webhooks. */
  url: string;
  /** Raw body bytes for POST webhooks; undefined for GET. */
  body?: string;
  contentType?: string;
  timeoutMs: number;
  /** Extra headers Preflight adds so the origin can tell a dry-run pre-fetch from a live webhook. */
  headers?: Record<string, string>;
}

export interface ForwardResult {
  ok: boolean;
  status: number;
  /** Exact bytes the origin returned. */
  bodyText: string;
  contentType: string | null;
  /** Wall-clock milliseconds from request sent to headers received. */
  originLatencyMs: number;
  error?: "timeout" | "network" | "http" | "redirect";
}

export async function forwardToOrigin(req: ForwardRequest, fetchImpl: typeof fetch = fetch): Promise<ForwardResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const sentAt = performance.now();
  try {
    const init: RequestInit = {
      method: req.method,
      headers: {
        ...(req.contentType ? { "content-type": req.contentType } : {}),
        "user-agent": "preflight/0.1 (+https://github.com/StephenSook/preflight)",
        ...(req.headers ?? {}),
      },
      signal: controller.signal,
      // A redirect from the origin is not followed: the fetch target is the one the operator
      // configured or the one their own object named, never wherever a 3xx points.
      redirect: "manual",
    };
    if (req.method === "POST" && req.body !== undefined) init.body = req.body;
    const res = await fetchImpl(req.url, init);
    // fetch resolves on headers. Anchor the latency here; reading the body afterwards would
    // silently subtract that time from the reported number.
    const originLatencyMs = performance.now() - sentAt;
    const bodyText = await res.text();
    const result: ForwardResult = {
      ok: res.ok,
      status: res.status,
      bodyText,
      contentType: res.headers.get("content-type"),
      originLatencyMs,
    };
    if (res.status >= 300 && res.status < 400) {
      result.ok = false;
      result.error = "redirect";
    } else if (!res.ok) result.error = "http";
    return result;
  } catch (e) {
    const originLatencyMs = performance.now() - sentAt;
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      bodyText: "",
      contentType: null,
      originLatencyMs,
      error: aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}
