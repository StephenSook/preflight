import { readFileSync } from "node:fs";
import type { FlowDeclaration } from "@preflight/engine";
import { z } from "zod";

/**
 * Runtime configuration, parsed once at boot. Every value is validated so a missing secret fails the
 * boot rather than failing the first call. Nothing here is read from a file except the optional public
 * key path: Render and local dev both supply the environment, and .env is loaded by the dev script only.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3131),
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** The api_key claim carried by every signed Vonage webhook. Selects the signature secret. */
  VONAGE_API_KEY: z.string().min(1),
  /** Signature secret from the Vonage dashboard (Settings > Signed webhooks). 1 to 50 characters. */
  VONAGE_SIGNATURE_SECRET: z.string().min(1).max(50),
  VONAGE_APPLICATION_ID: z.string().uuid().optional(),
  /** PEM of the application's PUBLIC key (the operator generated the pair). Lets the gateway verify a caller's application JWT. */
  VONAGE_APPLICATION_PUBLIC_KEY_PATH: z.string().min(1).optional(),
  /** The same PEM inline, for hosts without a file system for secrets. Wins over the path. Backslash-n line breaks are accepted. */
  VONAGE_APPLICATION_PUBLIC_KEY_PEM: z.string().min(1).optional(),
  VONAGE_API_HOST: z.string().url().default("https://api.nexmo.com"),
  /** The developer's real answer URL that Preflight forwards to. */
  ORIGIN_ANSWER_URL: z.string().url(),
  /** Optional separate origin for event webhooks; defaults to ORIGIN_ANSWER_URL with /event. */
  ORIGIN_EVENT_URL: z.string().url().optional(),
  /** strict = hold on inconclusive; advisory = pass with a warning. */
  POLICY_MODE: z.enum(["strict", "advisory"]).default("strict"),
  /**
   * Vonage gives the answer webhook 5 s. Preflight budgets the origin round trip inside that, and
   * fails closed (safe NCCO) if the origin does not answer in time.
   */
  ORIGIN_TIMEOUT_MS: z.coerce.number().int().positive().max(4500).default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  /** What the developer declared about their flow (Setup screen), as JSON. See declarationFrom(). */
  FLOW_DECLARATION_JSON: z.string().optional(),
  /** Shared secret the seal workflow presents when it records a transparency-log seal. Absent disables the endpoint. */
  SEAL_TOKEN: z.string().min(16).optional(),
  /** Bearer token for the dashboard's write actions (deciding a held call). Absent disables them. */
  DASHBOARD_TOKEN: z.string().min(16).optional(),
  /** Mount the reference application under /reference on this host (one host for the whole demonstration). */
  REFERENCE_APP: z.enum(["on", "off"]).default("off"),
  REFERENCE_MODE: z.enum(["broken", "fixed"]).default("broken"),
  /** Bearer token that may switch the reference application's mode at runtime; absent disables switching. */
  REFERENCE_ADMIN_TOKEN: z.string().min(16).optional(),
  /** The live endpoint the reference flow connects to: an app user for the browser softphone, or a phone number. */
  REFERENCE_AGENT: z.string().min(1).default("scheduler"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Preflight configuration is invalid: ${issues}`);
  }
  return parsed.data;
}

/** The application public key PEM: the inline value first (hosted), else the file at the path (local), else nothing. */
export function applicationPublicKeyPem(config: Pick<Config, "VONAGE_APPLICATION_PUBLIC_KEY_PEM" | "VONAGE_APPLICATION_PUBLIC_KEY_PATH">): string | undefined {
  if (config.VONAGE_APPLICATION_PUBLIC_KEY_PEM) return config.VONAGE_APPLICATION_PUBLIC_KEY_PEM.replace(/\\n/g, "\n");
  if (config.VONAGE_APPLICATION_PUBLIC_KEY_PATH) return readFileSync(config.VONAGE_APPLICATION_PUBLIC_KEY_PATH, "utf8");
  return undefined;
}

const declarationSchema = z.object({
  identification: z.object({ phrases: z.array(z.string()).optional(), streamUrls: z.array(z.string()).optional() }).optional(),
  optOut: z.object({ eventUrlPatterns: z.array(z.string()).optional() }).optional(),
  endpoints: z.array(z.string()).optional(),
});

/** The declared identification beat and opt-out handler. Absent means nothing identifies and nothing offers opt-out. */
export function declarationFrom(config: Pick<Config, "FLOW_DECLARATION_JSON">): FlowDeclaration {
  if (!config.FLOW_DECLARATION_JSON) return {};
  let value: unknown;
  try {
    value = JSON.parse(config.FLOW_DECLARATION_JSON);
  } catch (err) {
    throw new Error(`FLOW_DECLARATION_JSON is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = declarationSchema.safeParse(value);
  if (!parsed.success) throw new Error(`FLOW_DECLARATION_JSON is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data as FlowDeclaration;
}
