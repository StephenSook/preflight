import assert from "node:assert/strict";
import test from "node:test";
import { assertCallEvidence } from "./call-proof.mjs";

const placement = { seq: 1, call_uuid: "our-call", decision: "pass", detail: { placed: true, platform_status: 201 } };
const answer = { seq: 2, call_uuid: "our-call", decision: "pass" };
const input = (entries = [placement, answer]) => ({ uuid: "our-call", entries, eventsBefore: 10, eventsAfter: 12 });

test("accepts a placement and later passing decision for that same call", () => {
  assert.deepEqual(assertCallEvidence(input()).decisionSeqs, [2]);
});
test("a placement alone does not prove the answer path", () => {
  assert.throws(() => assertCallEvidence(input([placement])), /no answer or branch/);
});
test("another call cannot supply the passing decision", () => {
  assert.throws(() => assertCallEvidence(input([placement, { ...answer, call_uuid: "other-call" }])), /no answer or branch/);
});
test("an answer-time block fails the positive control", () => {
  assert.throws(() => assertCallEvidence(input([placement, { ...answer, decision: "block" }])), /did not pass/);
});
test("an unchanged or malformed event counter is not positive evidence", () => {
  for (const eventsAfter of [10, undefined, NaN]) assert.throws(() => assertCallEvidence({ ...input(), eventsAfter }), /no positive control/);
});
test("a rejected platform request is not a placement receipt", () => {
  assert.throws(() => assertCallEvidence(input([{ ...placement, detail: { placed: false, platform_status: 401 } }, answer])), /no successful/);
});
test("an answer recorded before the platform receipt still supplies evidence", () => {
  assert.deepEqual(assertCallEvidence(input([{ ...answer, seq: 1 }, { ...placement, seq: 2 }])).decisionSeqs, [1]);
});
test("an early block cannot disappear behind a later placement and passing decision", () => {
  assert.throws(() => assertCallEvidence(input([{ ...answer, seq: 1, decision: "block" }, { ...placement, seq: 2 }, { ...answer, seq: 3 }])), /did not pass/);
});
test("non-decision records cannot supply answer evidence", () => {
  assert.throws(() => assertCallEvidence(input([placement, { ...answer, decision: null }])), /no answer or branch/);
});
