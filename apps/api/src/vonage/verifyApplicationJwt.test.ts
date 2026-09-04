import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyApplicationJwt } from "./verifyApplicationJwt.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP = "0634d503-32c0-4160-be3e-8c31f50e5bd6";
const NOW = Date.parse("2026-09-04T16:00:00Z");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(claims: Record<string, unknown>, key = privateKey, alg = "RS256"): string {
  const head = b64({ alg, typ: "JWT" });
  const body = b64(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `Bearer ${head}.${body}.${signer.sign(key).toString("base64url")}`;
}
const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
const base = { application_id: APP, iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 900, jti: "j" };

describe("application JWT verification for the gateway", () => {
  it("accepts a token signed by the application's private key for this application", () => {
    expect(verifyApplicationJwt({ authorization: token(base), publicKeyPem: pem, applicationId: APP, now: () => NOW })).toMatchObject({ ok: true, claims: { application_id: APP } });
  });
  it("refuses missing, malformed, foreign-key, wrong-application, expired and non-RS256 tokens", () => {
    const v = (authorization: string | undefined) => verifyApplicationJwt({ authorization, publicKeyPem: pem, applicationId: APP, now: () => NOW }).reason;
    expect(v(undefined)).toBe("missing");
    expect(v("Bearer not-a-jwt")).toBe("malformed");
    expect(v(token(base, other.privateKey))).toBe("bad_signature");
    expect(v(token({ ...base, application_id: "someone-else" }))).toBe("wrong_application");
    expect(v(token({ ...base, iat: base.iat - 7200, exp: base.iat - 3600 }))).toBe("expired");
    expect(v(token({ ...base, iat: base.iat - 2 * 86400, exp: base.iat + 900 }))).toBe("expired");
    expect(v(token(base, privateKey, "HS256"))).toBe("bad_signature");
  });
});
