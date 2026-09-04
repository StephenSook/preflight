import { createHash, timingSafeEqual } from "node:crypto";
import { verifySignature } from "@vonage/jwt";

/**
 * Signed-webhook verification for the Vonage Voice API.
 *
 * Vonage sends a JWT in the Authorization header of every answer, event and fallback webhook:
 *   header  { alg: "HS256", typ: "JWT" }
 *   payload { iat, jti, iss: "Vonage", payload_hash, api_key, application_id }
 * The signature is HS256 over the signature secret that belongs to the api_key claim. payload_hash
 * is the SHA-256 of the request body for a POST. For a GET it is the SHA-256 of the query parameters
 * serialised as a compact JSON object in URL order (Vonage support article 19033783342876, "How do I
 * verify that the Voice API Webhook request and its payload has not been tampered during transit");
 * the raw query string is accepted as well, since both are faithful serialisations of what arrived
 * and the HS256 signature over the token is what authenticates the sender. Measured 2026-09-04: the
 * raw-string reading alone refused every real GET answer webhook (payload_hash_mismatch).
 * Source: developer.vonage.com/getting-started/concepts/webhooks, "Decoding signed webhooks".
 *
 * This is a correctness control, not only a security one: the call-flow graph is learned from
 * observed traffic, so an unauthenticated POST could inject phantom states. Anything that fails
 * here is dropped before it touches state.
 */

export type VerifyResult =
  | { ok: true; claims: VonageWebhookClaims; payloadForm: PayloadForm }
  | { ok: false; reason: VerifyFailure };

/** Which serialisation of the received payload the payload_hash claim matched. */
export type PayloadForm = "body" | "query_json" | "query_raw" | "unhashed";

export type VerifyFailure =
  | "missing_authorization"
  | "malformed_token"
  | "unknown_api_key"
  | "bad_signature"
  | "payload_hash_mismatch"
  | "stale_token";

export interface VonageWebhookClaims {
  iat: number;
  jti: string;
  iss: string;
  api_key: string;
  application_id?: string;
  payload_hash?: string;
}

export interface VerifyInput {
  /** The raw Authorization header value, e.g. "Bearer eyJ..." */
  authorization: string | undefined;
  /** Exact bytes of the request body (POST) or the raw query string without "?" (GET). */
  rawPayload: string;
  /** GET selects the query-parameter hash forms; anything else hashes the body. Defaults to POST. */
  method?: "GET" | "POST";
  /** Selects the signature secret for the api_key claim. Returns undefined for an unknown key. */
  secretFor: (apiKey: string) => string | undefined;
  /** Reject tokens older than this many seconds. Vonage does not publish the exp window for Voice. */
  maxAgeSeconds?: number;
  now?: () => number;
}

function decodeClaims(token: string): VonageWebhookClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1] as string, "base64url").toString("utf8");
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (typeof obj["api_key"] !== "string" || typeof obj["iat"] !== "number") return undefined;
    return obj as unknown as VonageWebhookClaims;
  } catch {
    return undefined;
  }
}

export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** The query parameters as Vonage hashes them for a GET: a compact JSON object, keys in URL order. */
export function queryAsJson(rawQuery: string): string {
  return JSON.stringify(Object.fromEntries(new URLSearchParams(rawQuery).entries()));
}

function candidateHashes(input: VerifyInput): Array<{ form: PayloadForm; hash: string }> {
  if (input.method === "GET") {
    return [
      { form: "query_json", hash: sha256Hex(queryAsJson(input.rawPayload)) },
      { form: "query_raw", hash: sha256Hex(input.rawPayload) },
    ];
  }
  return [{ form: "body", hash: sha256Hex(input.rawPayload) }];
}

export function verifyVonageWebhook(input: VerifyInput): VerifyResult {
  const auth = input.authorization?.trim();
  if (!auth || !/^Bearer\s+/i.test(auth)) return { ok: false, reason: "missing_authorization" };
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  const claims = decodeClaims(token);
  if (!claims) return { ok: false, reason: "malformed_token" };

  const secret = input.secretFor(claims.api_key);
  if (!secret) return { ok: false, reason: "unknown_api_key" };

  // HS256 against the per-api_key signature secret, using the sponsor's own library.
  let signatureOk = false;
  try {
    signatureOk = verifySignature(token, secret);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  const maxAge = input.maxAgeSeconds ?? 5 * 60;
  const now = (input.now ?? (() => Date.now()))() / 1000;
  if (Math.abs(now - claims.iat) > maxAge) return { ok: false, reason: "stale_token" };

  if (typeof claims.payload_hash === "string" && claims.payload_hash.length > 0) {
    const presented = claims.payload_hash.toLowerCase();
    const match = candidateHashes(input).find((c) => constantTimeEqualHex(c.hash, presented));
    if (!match) return { ok: false, reason: "payload_hash_mismatch" };
    return { ok: true, claims, payloadForm: match.form };
  }

  return { ok: true, claims, payloadForm: "unhashed" };
}
