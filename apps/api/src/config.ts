import { z } from "zod";

/**
 * Runtime configuration, parsed once at boot. Every value is validated so a missing secret fails the
 * boot rather than failing the first call. Nothing here is read from a file: Render and local dev both
 * supply the environment, and .env is loaded by the dev script only.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3131),
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** The api_key claim carried by every signed Vonage webhook. Selects the signature secret. */
  VONAGE_API_KEY: z.string().min(1),
  /** Signature secret from the Vonage dashboard (Settings > Signed webhooks). 1 to 50 characters. */
  VONAGE_SIGNATURE_SECRET: z.string().min(1).max(50),
  VONAGE_APPLICATION_ID: z.string().uuid().optional(),
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
