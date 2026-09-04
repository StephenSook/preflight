// Application JWT for the Vonage APIs that take one (Voice, Verify v2, Identity Insights).
// Signed locally with secrets/private.key; nothing leaves the machine except the token.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "apps/api/package.json"));
const { tokenGenerate } = require("@vonage/jwt");

export function loadEnv() {
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch {
    // no .env: rely on the environment
  }
  const env = process.env;
  const applicationId = env.VONAGE_APPLICATION_ID;
  const keyPath = env.VONAGE_PRIVATE_KEY_PATH || "./secrets/private.key";
  if (!applicationId) throw new Error("VONAGE_APPLICATION_ID is not set");
  const privateKey = readFileSync(path.resolve(root, keyPath), "utf8");
  return { applicationId, privateKey, env, root };
}

/** A short-lived application JWT (10 minutes) with an optional ACL. */
export function appJwt(extra = {}) {
  const { applicationId, privateKey } = loadEnv();
  return tokenGenerate(applicationId, privateKey, { ttl: 600, ...extra });
}

export async function vonageFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${appJwt()}`, accept: "application/json", "content-type": "application/json", "user-agent": "preflight/0.1 (+https://github.com/StephenSook/preflight)", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body, headers: Object.fromEntries(res.headers.entries()) };
}

if (process.argv[1] && process.argv[1].endsWith("jwt.mjs")) {
  const t = appJwt();
  const [h, p] = t.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  console.log(JSON.stringify({ header: JSON.parse(Buffer.from(h, "base64url").toString()), application_id: claims.application_id, iat: claims.iat, exp: claims.exp, jti: claims.jti ? "present" : "absent" }));
}
