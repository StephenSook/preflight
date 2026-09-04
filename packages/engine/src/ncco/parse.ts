import {
  KNOWN_ACTIONS,
  type ConnectAction,
  type ConversationAction,
  type Endpoint,
  type HttpMethod,
  type InputAction,
  type NccoAction,
  type NotifyAction,
  type PayAction,
  type RecordAction,
  type StreamAction,
  type TalkAction,
  type UnknownAction,
} from "./types.js";

export interface ParseIssue {
  /** JSON-pointer-like path into the object, e.g. `[2].endpoint[0].number`. */
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ParseResult {
  actions: NccoAction[];
  issues: ParseIssue[];
  /** True when no error-severity issue was raised. Warnings never clear this flag on their own. */
  ok: boolean;
}

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

class Issues {
  readonly list: ParseIssue[] = [];
  error(path: string, message: string): void {
    this.list.push({ path, message, severity: "error" });
  }
  warn(path: string, message: string): void {
    this.list.push({ path, message, severity: "warning" });
  }
}

/* Field readers. Each returns the value when present and well typed, undefined when absent, and
   undefined plus an error when present but malformed. */
function str(raw: Raw, key: string, path: string, issues: Issues): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    issues.error(`${path}.${key}`, `expected string, got ${typeName(v)}`);
    return undefined;
  }
  return v;
}
function bool(raw: Raw, key: string, path: string, issues: Issues): boolean | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    issues.error(`${path}.${key}`, `expected boolean, got ${typeName(v)}`);
    return undefined;
  }
  return v;
}
function num(raw: Raw, key: string, path: string, issues: Issues): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    issues.error(`${path}.${key}`, `expected finite number, got ${typeName(v)}`);
    return undefined;
  }
  return v;
}
function strArr(raw: Raw, key: string, path: string, issues: Issues): string[] | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    issues.error(`${path}.${key}`, `expected array of strings, got ${typeName(v)}`);
    return undefined;
  }
  return v as string[];
}
function obj(raw: Raw, key: string, path: string, issues: Issues): Raw | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (!isObject(v)) {
    issues.error(`${path}.${key}`, `expected object, got ${typeName(v)}`);
    return undefined;
  }
  return v;
}
function oneOf<T extends string>(values: readonly T[]) {
  return (raw: Raw, key: string, path: string, issues: Issues): T | undefined => {
    const v = str(raw, key, path, issues);
    if (v === undefined) return undefined;
    if (!(values as readonly string[]).includes(v)) {
      issues.error(`${path}.${key}`, `expected one of ${values.join(", ")}, got "${v}"`);
      return undefined;
    }
    return v as T;
  };
}
const method = oneOf<HttpMethod>(["GET", "POST"]);

/** Drops undefined keys so optional fields are absent rather than present-and-undefined. */
function compact<T extends object>(o: Record<string, unknown>): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o as T;
}

function warnUnknownFields(raw: Raw, known: readonly string[], path: string, issues: Issues): void {
  for (const k of Object.keys(raw)) {
    if (k === "action" || known.includes(k)) continue;
    issues.warn(`${path}.${k}`, "field is not in the NCCO reference; the parser ignores it and the platform may reject it");
  }
}

function unknown(raw: Raw, index: number, declaredAction: string): UnknownAction {
  return { action: "unknown", index, declaredAction, raw };
}

function parseEndpoint(v: unknown, path: string, issues: Issues): Endpoint | undefined {
  if (!isObject(v)) {
    issues.error(path, `expected endpoint object, got ${typeName(v)}`);
    return undefined;
  }
  const type = str(v, "type", path, issues);
  switch (type) {
    case "phone": {
      const number = str(v, "number", path, issues);
      if (number === undefined) {
        issues.error(`${path}.number`, "phone endpoint requires number");
        return undefined;
      }
      const onAnswerRaw = obj(v, "onAnswer", path, issues);
      const onAnswer = onAnswerRaw ? compact<{ url: string; ringbackTone?: string }>({ url: str(onAnswerRaw, "url", `${path}.onAnswer`, issues), ringbackTone: str(onAnswerRaw, "ringbackTone", `${path}.onAnswer`, issues) }) : undefined;
      if (onAnswer && onAnswer.url === undefined) issues.error(`${path}.onAnswer.url`, "onAnswer requires url");
      return compact<Endpoint>({ type, number, dtmfAnswer: str(v, "dtmfAnswer", path, issues), onAnswer });
    }
    case "app": {
      const user = str(v, "user", path, issues);
      if (user === undefined) {
        issues.error(`${path}.user`, "app endpoint requires user");
        return undefined;
      }
      return { type, user };
    }
    case "websocket": {
      const uri = str(v, "uri", path, issues);
      if (uri === undefined) {
        issues.error(`${path}.uri`, "websocket endpoint requires uri");
        return undefined;
      }
      return compact<Endpoint>({ type, uri, "content-type": str(v, "content-type", path, issues), headers: obj(v, "headers", path, issues) });
    }
    case "sip": {
      const uri = str(v, "uri", path, issues);
      const user = str(v, "user", path, issues);
      const domain = str(v, "domain", path, issues);
      if (uri === undefined && (user === undefined || domain === undefined)) {
        issues.error(path, "sip endpoint requires uri, or user together with domain");
        return undefined;
      }
      return compact<Endpoint>({ type, uri, user, domain, headers: obj(v, "headers", path, issues) });
    }
    case "vbc": {
      const extension = str(v, "extension", path, issues);
      if (extension === undefined) {
        issues.error(`${path}.extension`, "vbc endpoint requires extension");
        return undefined;
      }
      return { type, extension };
    }
    case undefined:
      issues.error(`${path}.type`, "endpoint requires type");
      return undefined;
    default:
      issues.error(`${path}.type`, `unknown endpoint type "${type}"`);
      return undefined;
  }
}

const FIELDS = {
  talk: ["text", "bargeIn", "loop", "level", "language", "style", "premium"],
  stream: ["streamUrl", "bargeIn", "loop", "level"],
  input: ["type", "eventUrl", "eventMethod", "mode", "dtmf", "speech"],
  connect: ["endpoint", "from", "randomFromNumber", "eventType", "timeout", "limit", "machineDetection", "advancedMachineDetection", "eventUrl", "eventMethod", "ringbackTone"],
  notify: ["payload", "eventUrl", "eventMethod"],
  record: ["format", "split", "channels", "endOnSilence", "endOnKey", "timeOut", "beepStart", "eventUrl", "eventMethod", "transcription"],
  conversation: ["name", "musicOnHoldUrl", "startOnEnter", "endOnExit", "record", "canSpeak", "canHear", "mute", "transcription"],
  pay: ["amount", "currency", "eventUrl", "prompts", "voice"],
} as const;

function parseAction(raw: Raw, index: number, issues: Issues): NccoAction {
  const path = `[${index}]`;
  const action = raw["action"];
  if (typeof action !== "string") {
    issues.error(`${path}.action`, action === undefined ? "action is required" : `expected string, got ${typeName(action)}`);
    return unknown(raw, index, action === undefined ? "" : String(action));
  }
  if (!(KNOWN_ACTIONS as readonly string[]).includes(action)) {
    issues.error(`${path}.action`, `unknown action "${action}"`);
    return unknown(raw, index, action);
  }
  warnUnknownFields(raw, FIELDS[action as keyof typeof FIELDS], path, issues);

  switch (action) {
    case "talk": {
      const text = str(raw, "text", path, issues);
      if (text === undefined) {
        issues.error(`${path}.text`, "talk requires text");
        return unknown(raw, index, action);
      }
      return compact<TalkAction>({ action, index, text, bargeIn: bool(raw, "bargeIn", path, issues), loop: num(raw, "loop", path, issues), level: num(raw, "level", path, issues), language: str(raw, "language", path, issues), style: num(raw, "style", path, issues), premium: bool(raw, "premium", path, issues) });
    }
    case "stream": {
      const streamUrl = strArr(raw, "streamUrl", path, issues);
      if (streamUrl === undefined || streamUrl.length === 0) {
        issues.error(`${path}.streamUrl`, "stream requires a non-empty streamUrl array");
        return unknown(raw, index, action);
      }
      return compact<StreamAction>({ action, index, streamUrl, bargeIn: bool(raw, "bargeIn", path, issues), loop: num(raw, "loop", path, issues), level: num(raw, "level", path, issues) });
    }
    case "input": {
      const type = strArr(raw, "type", path, issues);
      const okType = type !== undefined && type.length > 0 && type.every((t) => t === "dtmf" || t === "speech");
      if (!okType) {
        issues.error(`${path}.type`, 'input requires type as a non-empty array drawn from "dtmf" and "speech"');
        return unknown(raw, index, action);
      }
      const dtmfRaw = obj(raw, "dtmf", path, issues);
      const dtmf = dtmfRaw ? compact<NonNullable<InputAction["dtmf"]>>({ timeOut: num(dtmfRaw, "timeOut", `${path}.dtmf`, issues), maxDigits: num(dtmfRaw, "maxDigits", `${path}.dtmf`, issues), submitOnHash: bool(dtmfRaw, "submitOnHash", `${path}.dtmf`, issues) }) : undefined;
      return compact<InputAction>({ action, index, type: type as InputAction["type"], eventUrl: strArr(raw, "eventUrl", path, issues), eventMethod: method(raw, "eventMethod", path, issues), mode: oneOf(["synchronous", "asynchronous"] as const)(raw, "mode", path, issues), dtmf, speech: obj(raw, "speech", path, issues) });
    }
    case "connect": {
      const endpointRaw = raw["endpoint"];
      if (!Array.isArray(endpointRaw) || endpointRaw.length === 0) {
        issues.error(`${path}.endpoint`, "connect requires a non-empty endpoint array");
        return unknown(raw, index, action);
      }
      const endpoint = endpointRaw.map((e, i) => parseEndpoint(e, `${path}.endpoint[${i}]`, issues)).filter((e): e is Endpoint => e !== undefined);
      if (endpoint.length === 0) return unknown(raw, index, action);
      return compact<ConnectAction>({ action, index, endpoint, from: str(raw, "from", path, issues), randomFromNumber: bool(raw, "randomFromNumber", path, issues), eventType: oneOf(["synchronous"] as const)(raw, "eventType", path, issues), timeout: num(raw, "timeout", path, issues), limit: num(raw, "limit", path, issues), machineDetection: oneOf(["continue", "hangup"] as const)(raw, "machineDetection", path, issues), advancedMachineDetection: obj(raw, "advancedMachineDetection", path, issues), eventUrl: strArr(raw, "eventUrl", path, issues), eventMethod: method(raw, "eventMethod", path, issues), ringbackTone: str(raw, "ringbackTone", path, issues) });
    }
    case "notify": {
      const payload = obj(raw, "payload", path, issues);
      const eventUrl = strArr(raw, "eventUrl", path, issues);
      if (payload === undefined || eventUrl === undefined || eventUrl.length === 0) {
        issues.error(path, "notify requires payload and a non-empty eventUrl array");
        return unknown(raw, index, action);
      }
      return compact<NotifyAction>({ action, index, payload, eventUrl, eventMethod: method(raw, "eventMethod", path, issues) });
    }
    case "record":
      return compact<RecordAction>({ action, index, format: str(raw, "format", path, issues), split: oneOf(["conversation"] as const)(raw, "split", path, issues), channels: num(raw, "channels", path, issues), endOnSilence: num(raw, "endOnSilence", path, issues), endOnKey: str(raw, "endOnKey", path, issues), timeOut: num(raw, "timeOut", path, issues), beepStart: bool(raw, "beepStart", path, issues), eventUrl: strArr(raw, "eventUrl", path, issues), eventMethod: method(raw, "eventMethod", path, issues), transcription: obj(raw, "transcription", path, issues) });
    case "conversation": {
      const name = str(raw, "name", path, issues);
      if (name === undefined) {
        issues.error(`${path}.name`, "conversation requires name");
        return unknown(raw, index, action);
      }
      return compact<ConversationAction>({ action, index, name, musicOnHoldUrl: strArr(raw, "musicOnHoldUrl", path, issues), startOnEnter: bool(raw, "startOnEnter", path, issues), endOnExit: bool(raw, "endOnExit", path, issues), record: bool(raw, "record", path, issues), canSpeak: strArr(raw, "canSpeak", path, issues), canHear: strArr(raw, "canHear", path, issues), mute: bool(raw, "mute", path, issues), transcription: obj(raw, "transcription", path, issues) });
    }
    case "pay": {
      const amount = num(raw, "amount", path, issues);
      if (amount === undefined) {
        issues.error(`${path}.amount`, "pay requires amount");
        return unknown(raw, index, action);
      }
      const prompts = raw["prompts"];
      return compact<PayAction>({ action, index, amount, currency: str(raw, "currency", path, issues), eventUrl: strArr(raw, "eventUrl", path, issues), prompts: Array.isArray(prompts) ? prompts : undefined, voice: obj(raw, "voice", path, issues) });
    }
    default:
      return unknown(raw, index, action);
  }
}

/**
 * Parses an NCCO from raw bytes or an already-decoded value. Never throws: every defect becomes an
 * issue with a path, and an action that cannot be typed is kept as `unknown` so its position in the
 * flow is preserved for the monitors, which treat it as undecidable rather than as harmless.
 */
export function parseNcco(input: unknown): ParseResult {
  const issues = new Issues();
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (err) {
      issues.error("", `body is not JSON: ${err instanceof Error ? err.message : String(err)}`);
      return { actions: [], issues: issues.list, ok: false };
    }
  }
  if (!Array.isArray(value)) {
    issues.error("", `an NCCO is a JSON array of actions, got ${typeName(value)}`);
    return { actions: [], issues: issues.list, ok: false };
  }
  if (value.length === 0) issues.warn("", "empty NCCO: the platform hangs up with no action");
  const actions = value.map((item, index) => {
    if (!isObject(item)) {
      issues.error(`[${index}]`, `expected action object, got ${typeName(item)}`);
      return unknown({}, index, "");
    }
    return parseAction(item, index, issues);
  });
  return { actions, issues: issues.list, ok: !issues.list.some((i) => i.severity === "error") };
}
