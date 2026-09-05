import { createSign, randomUUID } from "node:crypto";

/**
 * An application JWT the way the platform expects it: RS256 over the application's private key with
 * application_id, iat, exp and jti. Mirrors what verifyApplicationJwt checks, and takes the clock as
 * an argument so a pinned test clock and the gateway's freshness window agree.
 */
export function mintApplicationJwt(applicationId: string, privateKeyPem: string, nowMs: number, ttlSeconds = 600, extraClaims: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(nowMs / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  // A Client SDK user token is the application token plus a subject and an ACL (extraClaims carries both).
  const body = b64({ application_id: applicationId, iat, exp: iat + ttlSeconds, jti: randomUUID(), ...extraClaims });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKeyPem).toString("base64url")}`;
}
