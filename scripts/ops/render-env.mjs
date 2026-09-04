// Copies named keys from the local .env to the Render service, then deploys and waits for health.
//
//   node scripts/ops/render-env.mjs VONAGE_SIGNATURE_SECRET [MORE_KEYS...]
//   node scripts/ops/render-env.mjs --dry-run VONAGE_SIGNATURE_SECRET
//
// Values never print. A Render env-var update through the API does not redeploy by itself, so the
// script triggers a deploy and waits on that deploy id before it reads /health.
//
// Credentials: RENDER_API_KEY in the environment, or (on the operator's machine) the bearer the Render
// MCP server is configured with in ~/.claude.json. RENDER_SERVICE_ID defaults to the preflight-api service.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keys = args.filter((a) => !a.startsWith("--"));
if (keys.length === 0) {
  console.error("usage: node scripts/ops/render-env.mjs [--dry-run] KEY [KEY...]");
  process.exit(1);
}

const envText = readFileSync(path.join(root, ".env"), "utf8");
const env = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
    }),
);
// A *_PEM key that .env does not carry inline is read from the file the matching *_PATH names,
// so a key kept on disk locally becomes an inline variable on the host without ever being printed.
for (const k of keys) {
  if (!env[k] && k.endsWith("_PEM")) {
    const pathKey = `${k.slice(0, -4)}_PATH`;
    if (env[pathKey]) env[k] = readFileSync(path.resolve(root, env[pathKey]), "utf8");
  }
}
const missing = keys.filter((k) => !env[k]);
if (missing.length > 0) {
  console.error(`empty or absent in .env (and no *_PATH file for a *_PEM key): ${missing.join(", ")}`);
  process.exit(1);
}

function apiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync(path.join(process.env.HOME ?? "", ".claude.json"), "utf8"));
    const auth = cfg.mcpServers?.render?.headers?.Authorization ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7);
  } catch {
    // fall through
  }
  throw new Error("no Render credential: set RENDER_API_KEY");
}

const serviceId = process.env.RENDER_SERVICE_ID || "srv-dad5t10n74is73ddjmu0";
const base = `https://api.render.com/v1/services/${serviceId}`;
const headers = { Authorization: `Bearer ${apiKey()}`, Accept: "application/json", "Content-Type": "application/json" };

console.log(`${dryRun ? "would sync" : "syncing"} ${keys.join(", ")} to ${serviceId}`);
if (dryRun) process.exit(0);

for (const key of keys) {
  const r = await fetch(`${base}/env-vars/${key}`, { method: "PUT", headers, body: JSON.stringify({ value: env[key] }) });
  if (!r.ok) {
    console.error(`${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`${key}: set`);
}

const trigger = await fetch(`${base}/deploys`, { method: "POST", headers, body: JSON.stringify({ clearCache: "do_not_clear" }) });
if (!trigger.ok) {
  console.error(`deploy trigger failed: ${trigger.status} ${(await trigger.text()).slice(0, 200)}`);
  process.exit(1);
}
const deploy = await trigger.json();
console.log(`deploy ${deploy.id} ${deploy.status}`);
let last = "";
for (let i = 0; i < 40; i++) {
  await new Promise((res) => setTimeout(res, 15000));
  const d = await (await fetch(`${base}/deploys/${deploy.id}`, { headers })).json();
  if (d.status !== last) {
    console.log(`${new Date().toISOString()} ${d.status}`);
    last = d.status;
  }
  if (d.status === "live") break;
  if (/failed|canceled|deactivated/.test(d.status)) {
    console.error(`deploy ended ${d.status}`);
    process.exit(2);
  }
}
const service = await (await fetch(base, { headers })).json();
const url = service.serviceDetails?.url;
const health = await fetch(`${url}/health`);
console.log(`GET ${url}/health -> ${health.status} ${(await health.text()).slice(0, 240)}`);
process.exit(health.ok ? 0 : 3);
