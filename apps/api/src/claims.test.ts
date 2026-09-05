import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Claim drift: a judge-facing surface may name only what the shipped code calls. The README's
 * "What is real" table must point at files that exist, and every vendor product or external system
 * named outside the README's honest-status section must have its call in the tree. A plan-tier
 * claim that outlives the code is what this catches.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");
const has = (file: string, needle: string): boolean => existsSync(path.join(root, file)) && read(file).includes(needle);

const SURFACES = ["README.md", "docs/fact-sheet.md", "docs/api.md", "docs/judges.md", "docs/submission/devpost.md"];

/** Each term the surfaces may use, with the evidence in the tree that makes it true. */
const CLAIMS: Array<{ term: RegExp; evidence: () => boolean; where: string }> = [
  { term: /Identity Insights/, evidence: () => has("packages/numfacts/src/identityInsights.ts", "/identity-insights/v1/requests"), where: "packages/numfacts/src/identityInsights.ts" },
  { term: /Verify v2/, evidence: () => has("apps/api/src/consent/verify.ts", "/v2/verify"), where: "apps/api/src/consent/verify.ts" },
  { term: /Reports API/, evidence: () => has("scripts/vonage/reconcile.mjs", "/v2/reports/records"), where: "scripts/vonage/reconcile.mjs" },
  { term: /Application API/, evidence: () => has("apps/api/src/setup/application.ts", "/v2/applications/"), where: "apps/api/src/setup/application.ts" },
  { term: /Sigstore|Rekor/, evidence: () => has(".github/workflows/seal.yml", "rekor-cli upload"), where: ".github/workflows/seal.yml" },
  { term: /NANPA/, evidence: () => existsSync(path.join(root, "packages/numfacts/data/co-codes.tsv")), where: "packages/numfacts/data/co-codes.tsv" },
  { term: /eCFR/, evidence: () => existsSync(path.join(root, "packages/rules/data/47-cfr-64.1200.txt")), where: "packages/rules/data/47-cfr-64.1200.txt" },
  { term: /libphonenumber/, evidence: () => existsSync(path.join(root, "packages/numfacts/data/tz-map.txt")), where: "packages/numfacts/data/tz-map.txt" },
  { term: /@vonage\/jwt/, evidence: () => has("apps/api/src/vonage/verifyWebhook.ts", "@vonage/jwt"), where: "apps/api/src/vonage/verifyWebhook.ts" },
  { term: /Client SDK|softphone/, evidence: () => has("apps/api/src/softphone/routes.ts", "acl") && has("apps/api/src/softphone/routes.ts", "/v1/users"), where: "apps/api/src/softphone/routes.ts" },
  { term: /Web Push|PWA/, evidence: () => has("apps/api/src/push/notify.ts", "web-push"), where: "apps/api/src/push/notify.ts" },
  { term: /GSAP|Lenis/, evidence: () => has("apps/web/package.json", "gsap"), where: "apps/web/package.json (not built yet)" },
];

/** The README section where unbuilt things are allowed to be named, as things that are not built. */
function outsideHonestStatus(readme: string): string {
  const a = readme.indexOf("## Honest status");
  const b = readme.indexOf("\n## ", a + 1);
  if (a === -1) return readme;
  return readme.slice(0, a) + (b === -1 ? "" : readme.slice(b));
}

describe("claim drift on the judge-facing surfaces", () => {
  it("every repository path the README's what-is-real table names exists", () => {
    const readme = read("README.md");
    const table = readme.slice(readme.indexOf("## What is real"), readme.indexOf("\n## ", readme.indexOf("## What is real") + 1));
    const paths = [...table.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string).filter((p) => /^(apps|packages|scripts|corpus|docs|\.github)\//.test(p) && !p.includes(" "));
    expect(paths.length).toBeGreaterThan(20);
    const missing = paths.filter((p) => !existsSync(path.join(root, p)));
    expect(missing).toEqual([]);
  });

  it("every vendor product or external system named outside the honest-status section is called by shipped code", () => {
    const failures: string[] = [];
    for (const surface of SURFACES) {
      const text = surface === "README.md" ? outsideHonestStatus(read(surface)) : read(surface);
      for (const c of CLAIMS) {
        if (c.term.test(text) && !c.evidence()) failures.push(`${surface} names ${c.term.source} but ${c.where} does not carry the call`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("the honest-status section names only things that are genuinely absent", () => {
    const readme = read("README.md");
    const a = readme.indexOf("## Honest status");
    expect(a, "the README carries an Honest status section").toBeGreaterThan(0);
    const honest = readme.slice(a, readme.indexOf("\n## ", a + 1));
    // The section names shipped things (the push line, the softphone line) as proven or as limited, never as unbuilt.
    const named = CLAIMS.filter((c) => c.term.test(honest));
    expect(named.length, "the honest status names at least one shipped integration").toBeGreaterThan(0);
    for (const c of named) {
      expect(c.evidence(), `${c.term.source} is named in the honest status but ${c.where} does not carry the call`).toBe(true);
      for (const line of honest.split("\n").filter((l) => c.term.test(l))) expect(line, `honest status lists ${c.term.source} as unbuilt`).not.toMatch(/not (yet )?(started|built|present|deployed|wired)/);
    }
  });
});
