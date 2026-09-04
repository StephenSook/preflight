/**
 * Vonage NCCO actions as typed records. Field names follow the NCCO reference exactly
 * (https://developer.vonage.com/voice/voice-api/ncco-reference). Every action carries its
 * position in the object it came from, because the monitors reason about order.
 */

export type EndpointType = "phone" | "app" | "websocket" | "sip" | "vbc";

export type Endpoint =
  | { type: "phone"; number: string; dtmfAnswer?: string; onAnswer?: { url: string; ringbackTone?: string } }
  | { type: "app"; user: string }
  | { type: "websocket"; uri: string; "content-type"?: string; headers?: Record<string, unknown> }
  | { type: "sip"; uri?: string; user?: string; domain?: string; headers?: Record<string, unknown> }
  | { type: "vbc"; extension: string };

/** Endpoint types that terminate on a person or a person's device rather than on a machine. */
export const LIVE_ENDPOINT_TYPES: readonly EndpointType[] = ["phone", "app", "sip", "vbc"];

export type HttpMethod = "GET" | "POST";

export interface TalkAction {
  action: "talk";
  index: number;
  text: string;
  bargeIn?: boolean;
  loop?: number;
  level?: number;
  language?: string;
  style?: number;
  premium?: boolean;
}

export interface StreamAction {
  action: "stream";
  index: number;
  streamUrl: string[];
  bargeIn?: boolean;
  loop?: number;
  level?: number;
}

export interface InputAction {
  action: "input";
  index: number;
  type: Array<"dtmf" | "speech">;
  eventUrl?: string[];
  eventMethod?: HttpMethod;
  mode?: "synchronous" | "asynchronous";
  dtmf?: { timeOut?: number; maxDigits?: number; submitOnHash?: boolean };
  speech?: Record<string, unknown>;
}

export interface ConnectAction {
  action: "connect";
  index: number;
  endpoint: Endpoint[];
  from?: string;
  randomFromNumber?: boolean;
  eventType?: "synchronous";
  timeout?: number;
  limit?: number;
  machineDetection?: "continue" | "hangup";
  advancedMachineDetection?: Record<string, unknown>;
  eventUrl?: string[];
  eventMethod?: HttpMethod;
  ringbackTone?: string;
}

export interface NotifyAction {
  action: "notify";
  index: number;
  payload: Record<string, unknown>;
  eventUrl: string[];
  eventMethod?: HttpMethod;
}

export interface RecordAction {
  action: "record";
  index: number;
  format?: string;
  split?: "conversation";
  channels?: number;
  endOnSilence?: number;
  endOnKey?: string;
  timeOut?: number;
  beepStart?: boolean;
  eventUrl?: string[];
  eventMethod?: HttpMethod;
  transcription?: Record<string, unknown>;
}

export interface ConversationAction {
  action: "conversation";
  index: number;
  name: string;
  musicOnHoldUrl?: string[];
  startOnEnter?: boolean;
  endOnExit?: boolean;
  record?: boolean;
  canSpeak?: string[];
  canHear?: string[];
  mute?: boolean;
  transcription?: Record<string, unknown>;
}

export interface PayAction {
  action: "pay";
  index: number;
  amount: number;
  currency?: string;
  eventUrl?: string[];
  prompts?: unknown[];
  voice?: Record<string, unknown>;
}

/** An action the parser could not type: an unknown name, or a known name missing a required field. */
export interface UnknownAction {
  action: "unknown";
  index: number;
  declaredAction: string;
  raw: Record<string, unknown>;
}

export type NccoAction =
  | TalkAction
  | StreamAction
  | InputAction
  | ConnectAction
  | NotifyAction
  | RecordAction
  | ConversationAction
  | PayAction
  | UnknownAction;

export type KnownActionName = Exclude<NccoAction["action"], "unknown">;
export const KNOWN_ACTIONS: readonly KnownActionName[] = ["talk", "stream", "input", "connect", "notify", "record", "conversation", "pay"];
