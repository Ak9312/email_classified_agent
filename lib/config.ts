/**
 * Environment parsing/validation (fail fast), shared constants and the logger.
 *
 * Config is read lazily (getConfig / getLlmConfig) so that unit tests and the
 * eval script can import modules without having every variable set.
 */
import { z } from "zod";

/** The four categories, in precedence order (spec §7.2). */
export const CATEGORIES = ["Rejections", "Interview / Recruiter", "Job Alerts", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Exact Gmail label name for each category. Normally identical to the category.
 * If Gmail stored a label differently (e.g. as a nested label, see README step
 * "Check the label names"), change the right-hand side here to whatever the
 * Gmail API returns. The system never creates or renames labels.
 */
export const GMAIL_LABEL_NAMES: Record<Category, string> = {
  "Interview / Recruiter": "Interview / Recruiter",
  "Job Alerts": "Job Alerts",
  Rejections: "Rejections",
  Other: "Other",
};

/** Per-model OpenRouter timeout (spec §7.4). */
export const LLM_TIMEOUT_MS = 15_000;
/** Body text sent to the LLM is truncated to this many characters (spec §7.1). */
export const BODY_MAX_CHARS = 3_000;
/** messages.list page size (spec §6.3). */
export const LIST_MAX_RESULTS = 50;

const boolFromString = z
  .enum(["true", "false"])
  .default("true")
  .transform((v) => v === "true");

const intFromString = (def: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .default(String(def))
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => n > 0, "must be greater than 0");

const modelList = z
  .string()
  .min(1, "list at least one model")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .refine((list) => list.length > 0, "list at least one model");

const secret = z.string().min(32, "must be at least 32 characters");

const llmSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODELS: modelList,
});

const fullSchema = llmSchema.extend({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
  GMAIL_ADDRESS: z
    .string()
    .regex(/^[^@\s]+@[^@\s]+$/, "must be an email address")
    .transform((v) => v.toLowerCase()),
  PUBSUB_TOPIC: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/, "must look like projects/<project>/topics/<topic>"),
  WEBHOOK_SECRET: secret,
  CRON_SECRET: secret,
  DRY_RUN: boolFromString,
  PUSH_LOOKBACK_DAYS: intFromString(2),
  SWEEP_LOOKBACK_DAYS: intFromString(7),
  MAX_MESSAGES_PER_RUN: intFromString(10),
  RUN_TIME_BUDGET_SECONDS: intFromString(45),
});

export interface LlmConfig {
  apiKey: string;
  models: string[];
  timeoutMs: number;
  appUrl: string;
}

export interface AppConfig {
  llm: LlmConfig;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  gmailAddress: string;
  pubsubTopic: string;
  webhookSecret: string;
  cronSecret: string;
  dryRun: boolean;
  pushLookbackDays: number;
  sweepLookbackDays: number;
  maxMessagesPerRun: number;
  runTimeBudgetMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Treat empty strings as "not set" so defaults apply. */
function readEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === undefined || v.trim() === "" ? undefined : v.trim();
  return out;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`).join("; ");
}

function appUrl(env: NodeJS.ProcessEnv): string {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : "https://github.com/Ak9312/email_classified_agent";
}

/** Only the OpenRouter settings (used by the eval script). */
export function getLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const parsed = llmSchema.safeParse(readEnv(env));
  if (!parsed.success) throw new ConfigError(`Invalid environment: ${formatIssues(parsed.error)}`);
  return {
    apiKey: parsed.data.OPENROUTER_API_KEY,
    models: parsed.data.OPENROUTER_MODELS,
    timeoutMs: LLM_TIMEOUT_MS,
    appUrl: appUrl(env),
  };
}

let cached: AppConfig | undefined;

/** Full config for the Vercel functions. Throws ConfigError listing every problem. */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const parsed = fullSchema.safeParse(readEnv(env));
  if (!parsed.success) throw new ConfigError(`Invalid environment: ${formatIssues(parsed.error)}`);
  const d = parsed.data;
  const config: AppConfig = {
    llm: { apiKey: d.OPENROUTER_API_KEY, models: d.OPENROUTER_MODELS, timeoutMs: LLM_TIMEOUT_MS, appUrl: appUrl(env) },
    googleClientId: d.GOOGLE_CLIENT_ID,
    googleClientSecret: d.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: d.GOOGLE_REFRESH_TOKEN,
    gmailAddress: d.GMAIL_ADDRESS,
    pubsubTopic: d.PUBSUB_TOPIC,
    webhookSecret: d.WEBHOOK_SECRET,
    cronSecret: d.CRON_SECRET,
    dryRun: d.DRY_RUN,
    pushLookbackDays: d.PUSH_LOOKBACK_DAYS,
    sweepLookbackDays: d.SWEEP_LOOKBACK_DAYS,
    maxMessagesPerRun: d.MAX_MESSAGES_PER_RUN,
    runTimeBudgetMs: d.RUN_TIME_BUDGET_SECONDS * 1000,
  };
  if (env === process.env) cached = config;
  return config;
}

/** One JSON line per event (spec §10). Never pass email bodies or secrets. */
export function log(evt: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ evt, ...fields }));
}
