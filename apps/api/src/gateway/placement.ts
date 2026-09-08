import { createHash } from "node:crypto";

export const PLACEMENT_QUERY = "pf_placement";

export function placementDigest(token: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  return createHash("sha256").update(`preflight-placement:${token}`).digest("hex");
}
