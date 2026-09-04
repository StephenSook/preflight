import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @preflight/rules
 * The statute and regulation texts the properties cite, committed at a pinned vintage with a
 * manifest, and the verbatim clauses quoted from them. A quote that is not a byte-for-byte
 * substring of its source text fails the build, and so does a quoted clause no code path uses
 * (the coverage file lists the exceptions with a written reason).
 */

export interface SourceFile {
  title: string;
  url: string;
  vintage: string;
  kind: string;
  terms: string;
  extraction: string;
  sha256: string;
}

export interface SourcesManifest {
  fetchedAt: string;
  files: Record<string, SourceFile>;
}

export interface Citation {
  id: string;
  /** The exact string a property carries, e.g. "47 CFR 64.1200(c)(1)". */
  citation: string;
  /** File under data/ the quote was sliced from. */
  source: string;
  /** Property ids, or a documentation path for a clause that is quoted but not monitored. */
  usedBy: string[];
  /** Required when usedBy names no property: why the clause is quoted at all. */
  reason?: string;
  /** Verbatim, including the source's own punctuation. */
  quote: string;
}

export interface Rules {
  dataDir: string;
  sources: SourcesManifest;
  texts: Record<string, string>;
  citations: Citation[];
  /** sha256 over every source file's hash and every citation, in canonical order. */
  digest: string;
}

export const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");

export function loadRules(dataDir = DEFAULT_DATA_DIR): Rules {
  const sources = JSON.parse(readFileSync(path.join(dataDir, "SOURCES.json"), "utf8")) as SourcesManifest;
  const citations = JSON.parse(readFileSync(path.join(dataDir, "citations.json"), "utf8")) as Citation[];
  const texts: Record<string, string> = {};
  for (const name of Object.keys(sources.files).sort()) texts[name] = readFileSync(path.join(dataDir, name), "utf8");
  const h = createHash("sha256");
  for (const name of Object.keys(sources.files).sort()) h.update(`${name}\n${sources.files[name]?.sha256 ?? ""}\n`);
  for (const c of [...citations].sort((a, b) => a.id.localeCompare(b.id))) h.update(`${c.id}\n${c.citation}\n${c.source}\n${c.quote}\n`);
  return { dataDir, sources, texts, citations, digest: `sha256:${h.digest("hex")}` };
}

export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Every citation part of a property's citation string, split on the separator the properties use. */
export const citationParts = (citation: string): string[] => citation.split(";").map((s) => s.trim()).filter((s) => s.length > 0);

export function citationsFor(rules: Rules, citation: string): Citation[] {
  return citationParts(citation).map((part) => {
    const found = rules.citations.find((c) => c.citation === part);
    if (!found) throw new Error(`no quoted clause for citation "${part}"`);
    return found;
  });
}
