import { createHash } from "node:crypto";
import type { FlowDeclaration } from "@preflight/engine";
import { canonicalize, type Canonical } from "@preflight/ledger";
import type { Sql } from "postgres";

export interface DeclarationRecord {
  declaration: FlowDeclaration;
  /** sha256 over the canonical JSON of the declaration; what the evidence-log entry carries. */
  hash: string;
  declaredBy: string;
  declaredAt: string;
}

/** The developer's declaration about their flow, newest wins; absent means the environment's seed applies. */
export interface DeclarationStore {
  readonly name: "memory" | "postgres";
  current(): Promise<DeclarationRecord | undefined>;
  set(declaration: FlowDeclaration, declaredBy: string, declaredAt: string): Promise<DeclarationRecord>;
}

export function declarationHash(declaration: FlowDeclaration): string {
  return "sha256:" + createHash("sha256").update(canonicalize(declaration as unknown as Canonical)).digest("hex");
}

export class MemoryDeclarationStore implements DeclarationStore {
  readonly name = "memory" as const;
  private latest: DeclarationRecord | undefined;
  async current(): Promise<DeclarationRecord | undefined> {
    return this.latest;
  }
  async set(declaration: FlowDeclaration, declaredBy: string, declaredAt: string): Promise<DeclarationRecord> {
    this.latest = { declaration: structuredClone(declaration), hash: declarationHash(declaration), declaredBy, declaredAt };
    return this.latest;
  }
}

interface Row { declaration: FlowDeclaration; declaration_hash: string; declared_by: string; declared_at: Date }
const toRecord = (r: Row): DeclarationRecord => ({ declaration: r.declaration, hash: r.declaration_hash, declaredBy: r.declared_by, declaredAt: r.declared_at.toISOString() });

export class PgDeclarationStore implements DeclarationStore {
  readonly name = "postgres" as const;
  /** A deployment without an application id (local development) keeps one unscoped declaration. */
  constructor(private readonly sql: Sql, private readonly applicationId: string | undefined) {}
  async current(): Promise<DeclarationRecord | undefined> {
    const [r] = await this.sql<Row[]>`select declaration, declaration_hash, declared_by, declared_at from flow_declarations where application_id is not distinct from ${this.applicationId ?? null} order by id desc limit 1`;
    return r ? toRecord(r) : undefined;
  }
  async set(declaration: FlowDeclaration, declaredBy: string, declaredAt: string): Promise<DeclarationRecord> {
    const hash = declarationHash(declaration);
    const [r] = await this.sql<Row[]>`insert into flow_declarations (application_id, declaration, declaration_hash, declared_by, declared_at) values (${this.applicationId ?? null}, ${this.sql.json(declaration as never)}, ${hash}, ${declaredBy}, ${declaredAt}) returning declaration, declaration_hash, declared_by, declared_at`;
    if (!r) throw new Error("the declaration insert returned no row");
    return toRecord(r);
  }
}
