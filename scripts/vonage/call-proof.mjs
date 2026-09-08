export function assertCallEvidence({ uuid, entries, eventsBefore, eventsAfter }) {
  if (typeof uuid !== "string" || uuid.length === 0) throw new Error("a placed call UUID is required");
  if (!Number.isSafeInteger(eventsBefore) || !Number.isSafeInteger(eventsAfter) || eventsAfter <= eventsBefore) {
    throw new Error("no positive control: signed platform events did not increase after placement");
  }
  if (!Array.isArray(entries)) throw new Error("ledger entries are missing");
  const matching = entries.filter((entry) => entry.call_uuid === uuid);
  const placement = matching.find((entry) => entry.decision === "pass" && entry.detail?.placed === true && entry.detail?.platform_status === 201);
  if (!placement) throw new Error("the call has no successful gateway placement receipt");
  const decisions = matching.filter((entry) => entry.detail?.platform_status === undefined && ["pass", "block", "hold"].includes(entry.decision));
  if (decisions.length === 0) throw new Error("the placed call has no answer or branch decision");
  if (decisions.some((entry) => entry.decision !== "pass")) throw new Error("the placed call did not pass its answer and branch decisions");
  return { uuid, placementSeq: placement.seq, decisionSeqs: decisions.map((entry) => entry.seq), eventsBefore, eventsAfter };
}
