/**
 * The safe NCCO returned when Preflight cannot let the origin's flow through. It is deliberately a
 * plain spoken sentence and a hangup: no branch, no input, nothing a monitor could object to.
 */
export function safeNcco(reason: string): unknown[] {
  return [{ action: "talk", text: `This call was stopped by Preflight. ${reason}` }];
}

/** The object served while a call is held for a human decision under strict policy. */
export function holdNcco(reason: string): unknown[] {
  return [{ action: "talk", text: `This call is held for review by Preflight. ${reason}` }];
}
