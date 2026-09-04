import { createVerify } from "node:crypto";

/**
 * Verifies the JWT a developer's application presents to the create-call gateway. Vonage
 * application JWTs are RS256, signed with the application's private key; the operator holds the
 * matching public key (they generated the pair), so Preflight can check that the caller is the
 * application owner before it fetches anything on their behalf. Nothing is fetched for an
 * anonymous caller.
 */
export interface ApplicationJwtResult {
  ok: boolean;
  reason?: "missing" | "malformed" | "bad_signature" | "wrong_application" | "expired" | "not_yet_valid";
  claims?: { application_id?: string; iat?: number; exp?: number; jti?: string; sub?: string } | undefined;
}

export function verifyApplicationJwt(input: { authorization: string | undefined; publicKeyPem: string; applicationId: string; now?: () => number; maxAgeSeconds?: number }): ApplicationJwtResult {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(input.authorization ?? "");
  if (!input.authorization) return { ok: false, reason: "missing" };
  if (!m) return { ok: false, reason: "malformed" };
  const [, h, p, s] = m;
  let header: { alg?: unknown; typ?: unknown };
  let claims: ApplicationJwtResult["claims"];
  try {
    header = JSON.parse(Buffer.from(h as string, "base64url").toString("utf8")) as { alg?: unknown };
    claims = JSON.parse(Buffer.from(p as string, "base64url").toString("utf8")) as ApplicationJwtResult["claims"];
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "bad_signature" };
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  let valid = false;
  try {
    valid = verifier.verify(input.publicKeyPem, Buffer.from(s as string, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature", claims };
  if (claims?.application_id !== input.applicationId) return { ok: false, reason: "wrong_application", claims };
  const nowSec = Math.floor((input.now ?? Date.now)() / 1000);
  const skew = 60;
  if (typeof claims.exp === "number" && claims.exp + skew < nowSec) return { ok: false, reason: "expired", claims };
  if (typeof claims.iat === "number" && claims.iat - skew > nowSec) return { ok: false, reason: "not_yet_valid", claims };
  if (typeof claims.iat === "number" && nowSec - claims.iat > (input.maxAgeSeconds ?? 24 * 3600)) return { ok: false, reason: "expired", claims };
  return { ok: true, claims };
}
