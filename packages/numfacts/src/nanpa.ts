/**
 * The NANPA central office code prior, read from the committed derived table
 * (packages/numfacts/data/co-codes.tsv, produced by scripts/fetch-numfacts.mjs).
 *
 * What it gives: for an NPA-NXX, the state, the rate center, the operating company number and a
 * line class derived from the carrier's NAME. What it cannot give: porting. A number ported from a
 * landline carrier to a wireless one still shows the original code holder here, which is why every
 * fact from this table carries confidence "low" and the paid lookup exists for the ambiguous cases.
 */
export type LineClass = "wireless" | "landline" | "voip";

export interface CoCodeRow {
  npanxx: string;
  state: string;
  rateCenter: string;
  ocn: string;
  lineClass: LineClass;
}

const CLASS: Record<string, LineClass> = { W: "wireless", L: "landline", V: "voip" };
const HEADER = "npanxx\tstate\trate_center\tocn\tline_class";

export class CoCodeTable {
  private constructor(private readonly rows: Map<string, CoCodeRow>) {}

  static parse(text: string): CoCodeTable {
    const lines = text.split("\n");
    if (lines[0] !== HEADER) throw new Error(`co-codes.tsv header is "${lines[0]}", expected "${HEADER}"`);
    const rows = new Map<string, CoCodeRow>();
    for (const line of lines.slice(1)) {
      if (line.length === 0) continue;
      const [npanxx = "", state = "", rateCenter = "", ocn = "", cls = ""] = line.split("\t");
      const lineClass = CLASS[cls];
      if (!/^\d{6}$/.test(npanxx) || !lineClass) throw new Error(`bad co-codes.tsv row: ${line}`);
      rows.set(npanxx, { npanxx, state, rateCenter, ocn, lineClass });
    }
    return new CoCodeTable(rows);
  }

  get size(): number {
    return this.rows.size;
  }

  /** Looks up the first six digits of a ten-digit NANP number. */
  lookup(nationalNumber: string): CoCodeRow | undefined {
    return this.rows.get(nationalNumber.slice(0, 6));
  }
}
