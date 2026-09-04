/**
 * Canonical JSON: the one byte sequence an entry hashes to. Object keys sorted by code point, no
 * whitespace, strings escaped as JSON.stringify does, numbers restricted to safe integers so two
 * runtimes can never print the same value differently. Undefined values are omitted.
 */
export type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical | undefined };

export function canonicalize(value: Canonical): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new Error(`canonical JSON allows safe integers only, got ${String(value)}`);
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k] as Canonical)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON cannot encode ${typeof value}`);
  }
}
