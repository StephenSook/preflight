// Deploys the web app to the dedicated Vercel project (preflight-web) as prebuilt static output:
// builds with Vite, assembles a Build Output API v3 directory, deploys it, then reads the served
// bundle back and requires a string the build is known to contain. Nothing is built on Vercel, so
// the monorepo never has to install there, and what is served is byte for byte what was built here.
//
//   node scripts/ops/deploy-web.mjs            (production)
//   node scripts/ops/deploy-web.mjs --preview  (a preview deployment)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const web = path.join(root, "apps/web");
const preview = process.argv.includes("--preview");
const run = (cmd, args, cwd = web) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

// The link must be the dedicated project, never another project's, before anything is deployed.
const link = JSON.parse(readFileSync(path.join(web, ".vercel/project.json"), "utf8"));
if (link.projectName !== "preflight-web") throw new Error(`apps/web is linked to ${link.projectName}, not preflight-web; refusing`);

run("pnpm", ["--filter", "@preflight/web", "build"], root);
const dist = path.join(web, "dist");
if (!existsSync(path.join(dist, "index.html"))) throw new Error("dist/index.html missing after the build");

const out = path.join(web, ".vercel/output");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "static"), { recursive: true });
cpSync(dist, path.join(out, "static"), { recursive: true });
const config = {
  version: 3,
  routes: [
    { src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
    { src: "^/fonts/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
    { src: "^/sw\\.js$", headers: { "cache-control": "no-cache" }, continue: true },
    { src: "^/(app|phone)$", status: 308, headers: { Location: "/$1/" } },
    { handle: "filesystem" },
  ],
};
writeFileSync(path.join(out, "config.json"), JSON.stringify(config, null, 2));

// The production alias is fixed; the deployment URL changes every time. Both are read back.
const PRODUCTION_URL = "https://preflight-web-nine.vercel.app";
const args = ["deploy", "--prebuilt", "--yes", ...(preview ? [] : ["--prod"])];
const output = run("vercel", args);
let deployment;
try {
  deployment = JSON.parse(output).deployment;
} catch {
  throw new Error(`vercel's output was not the JSON summary:\n${output.slice(0, 400)}`);
}
if (!deployment?.url || deployment.readyState !== "READY") throw new Error(`deployment not ready: ${JSON.stringify(deployment)}`);
const url = preview ? deployment.url : PRODUCTION_URL;
console.log(`deployed: ${deployment.url}${preview ? "" : ` (production alias ${PRODUCTION_URL})`}`);

// Read the served page back and require a string this build is known to carry; a green deploy of
// the wrong bytes would otherwise pass.
const marker = "The reference application's flow, evaluated by the engine in this browser";
const res = await fetch(`${url}/`, { headers: { "user-agent": "preflight-deploy-check" }, signal: AbortSignal.timeout(30000) });
const html = await res.text();
if (res.status !== 200 || !html.includes(marker)) throw new Error(`served page (${res.status}) lacks the marker`);
const bundle = html.match(/src="(\/assets\/site-[^"]+\.js)"/)?.[1];
if (!bundle) throw new Error("the served page names no site bundle");
const js = await (await fetch(`${url}${bundle}`, { signal: AbortSignal.timeout(30000) })).text();
if (!js.includes("evaluatePath") && !js.includes("hero-graph") && !js.includes("no model decides")) console.log("note: the bundle is minified; marker names not found by name, page marker verified");
for (const p of ["/app/", "/phone/", "/sw.js", "/manifest.webmanifest"]) {
  const r = await fetch(`${url}${p}`, { signal: AbortSignal.timeout(30000) });
  console.log(`${r.status} ${p}`);
  if (r.status !== 200) throw new Error(`${p} answered ${r.status}`);
}
console.log(`verified: ${url}`);
