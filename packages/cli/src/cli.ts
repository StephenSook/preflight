import { readFileSync } from "node:fs";
import type { CallFacts, FlowDeclaration } from "@preflight/engine";
import { checkObject, renderReplay, renderVerdicts, renderVerify, replayCorpus, unwrapObjectFile, verifyLedgerSource } from "./index.js";

const VERSION = "0.2.0";
const USAGE = `preflight ${VERSION}: the call that doesn't happen

  preflight check <object.json> [--declaration decl.json] [--from 14045550100]
                  [--line-type wireless|landline|voip|unknown] [--within-hours true|false|unknown]
                  [--policy strict|advisory] [--open]
        Run P1..P5 over one call-control object (a bare object, or a corpus file that wraps one).
        Exit 0 pass, 2 block, 3 hold, 1 error.

  preflight replay [corpus/ncco]
        Re-run every labelled corpus object and compare verdicts, decision and witness path to its labels.
        Exit 0 when every label matches, 1 otherwise.

  preflight verify-ledger <https://host | entries.json>
        Recompute every hash and link of an evidence log from genesis. Exit 0 intact, 4 broken.

Number facts are given, not looked up: this tool carries no data tables and needs no account.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd === "--version" || cmd === "-v") {
    out(VERSION);
    return 0;
  }
  try {
    if (cmd === "check") {
      const file = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1]?.startsWith("--") !== true);
      if (!file) throw new Error("check needs an object file");
      const unwrapped = unwrapObjectFile(JSON.parse(readFileSync(file, "utf8")));
      const object = unwrapped.object;
      const declFile = flag(rest, "--declaration");
      const declaration = declFile ? (JSON.parse(readFileSync(declFile, "utf8")) as FlowDeclaration) : unwrapped.declaration;
      const lineType = (flag(rest, "--line-type") ?? "unknown") as CallFacts["lineType"];
      const wh = flag(rest, "--within-hours") ?? "unknown";
      const facts: CallFacts = { from: flag(rest, "--from"), lineType, withinHours: wh === "true" ? true : wh === "false" ? false : null };
      const policy = (flag(rest, "--policy") ?? "strict") as "strict" | "advisory";
      const result = checkObject(object, { declaration, facts, policy, open: rest.includes("--open") });
      out(renderVerdicts(result));
      return result.decision === "pass" ? 0 : result.decision === "block" ? 2 : 3;
    }
    if (cmd === "replay") {
      const dir = rest.find((a) => !a.startsWith("--")) ?? "corpus/ncco";
      const { rows, ok } = replayCorpus(dir);
      out(renderReplay(rows));
      return ok ? 0 : 1;
    }
    if (cmd === "verify-ledger") {
      const source = rest[0];
      if (!source) throw new Error("verify-ledger needs a host URL or a file");
      const r = await verifyLedgerSource(source);
      out(renderVerify(r));
      return r.ok ? 0 : 4;
    }
    throw new Error(`unknown command "${cmd}"`);
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    out(USAGE);
    return 1;
  }
}

if (process.argv[1] && /preflight(\.js|\.ts)?$|cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
