import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { queryAsJson, sha256Hex, verifyVonageWebhook } from "./verifyWebhook.js";

const SECRET = "test-signature-secret";
const API_KEY = "a1b2c3d";

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

/** Signs exactly the way Vonage does: HS256 over base64url(header).base64url(payload). */
function signHS256(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function claimsFor(raw: string, iat = Math.floor(Date.now() / 1000)) {
  return {
    iat,
    jti: "c5ba8f24-1a14-4c10-bfdf-3fbe8ce511b5",
    iss: "Vonage",
    payload_hash: sha256Hex(raw),
    api_key: API_KEY,
    application_id: "aaaaaaaa-bbbb-cccc-dddd-0123456789ab",
  };
}

const secretFor = (k: string) => (k === API_KEY ? SECRET : undefined);

describe("verifyVonageWebhook", () => {
  const raw = JSON.stringify({ uuid: "abc", status: "answered" });

  it("accepts a correctly signed token whose payload_hash matches the body", () => {
    const token = signHS256(claimsFor(raw), SECRET);
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: raw, secretFor });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.api_key).toBe(API_KEY);
  });

  const query = "to=19432445023&endpoint_type=phone&from=12016131021&conversation_uuid=CON-59d439b9-3e75-4f7d-a5c9-8030aee26ac4&uuid=aade2718c73eada70cfd2096847a1d52&region_url=https%3A%2F%2Fapi-us-3.vonage.com";

  it("accepts a GET answer webhook whose payload_hash is the compact JSON of the query parameters, in URL order", () => {
    expect(queryAsJson(query)).toBe('{"to":"19432445023","endpoint_type":"phone","from":"12016131021","conversation_uuid":"CON-59d439b9-3e75-4f7d-a5c9-8030aee26ac4","uuid":"aade2718c73eada70cfd2096847a1d52","region_url":"https://api-us-3.vonage.com"}');
    const token = signHS256(claimsFor(queryAsJson(query)), SECRET);
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: query, method: "GET", secretFor });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payloadForm).toBe("query_json");
  });

  it("still accepts a GET whose payload_hash covers the raw query string", () => {
    const token = signHS256(claimsFor(query), SECRET);
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: query, method: "GET", secretFor });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payloadForm).toBe("query_raw");
  });

  it("rejects a GET whose query parameters were altered after signing", () => {
    const token = signHS256(claimsFor(queryAsJson(query)), SECRET);
    const altered = query.replace("from=12016131021", "from=12016131099");
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: altered, method: "GET", secretFor });
    expect(r).toEqual({ ok: false, reason: "payload_hash_mismatch" });
  });

  it("reports the body form for a POST and no form when the token carries no payload_hash", () => {
    const withBody = verifyVonageWebhook({ authorization: `Bearer ${signHS256(claimsFor(raw), SECRET)}`, rawPayload: raw, secretFor });
    expect(withBody.ok && withBody.payloadForm).toBe("body");
    const { payload_hash, ...rest } = claimsFor(raw);
    void payload_hash;
    const bare = verifyVonageWebhook({ authorization: `Bearer ${signHS256(rest, SECRET)}`, rawPayload: raw, secretFor });
    expect(bare.ok && bare.payloadForm).toBe("unhashed");
  });

  it("rejects a missing Authorization header", () => {
    const r = verifyVonageWebhook({ authorization: undefined, rawPayload: raw, secretFor });
    expect(r).toEqual({ ok: false, reason: "missing_authorization" });
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signHS256(claimsFor(raw), "not-the-secret");
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: raw, secretFor });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token for an api_key we do not know", () => {
    const token = signHS256({ ...claimsFor(raw), api_key: "zzzzzzz" }, SECRET);
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: raw, secretFor });
    expect(r).toEqual({ ok: false, reason: "unknown_api_key" });
  });

  it("rejects a valid signature when the body was tampered with after signing", () => {
    const token = signHS256(claimsFor(raw), SECRET);
    const tampered = JSON.stringify({ uuid: "abc", status: "completed" });
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: tampered, secretFor });
    expect(r).toEqual({ ok: false, reason: "payload_hash_mismatch" });
  });

  it("rejects a token that is older than the allowed window", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const token = signHS256(claimsFor(raw, old), SECRET);
    const r = verifyVonageWebhook({ authorization: `Bearer ${token}`, rawPayload: raw, secretFor, maxAgeSeconds: 300 });
    expect(r).toEqual({ ok: false, reason: "stale_token" });
  });

  it("rejects garbage that is not a JWT", () => {
    const r = verifyVonageWebhook({ authorization: "Bearer not.a.jwt.at.all", rawPayload: raw, secretFor });
    expect(r).toEqual({ ok: false, reason: "malformed_token" });
  });

  it("does not accept the none algorithm", () => {
    const head = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = b64url(JSON.stringify(claimsFor(raw)));
    const r = verifyVonageWebhook({ authorization: `Bearer ${head}.${body}.`, rawPayload: raw, secretFor });
    expect(r.ok).toBe(false);
  });
});
