/** OpenRouter client with model fallback and strict output validation (spec §7.4). */
import { z } from "zod";
import { CATEGORIES, type Category, type LlmConfig } from "./config";
import type { EmailFeatures } from "./extract";
import { SYSTEM_PROMPT, buildEmailBlock } from "./prompt";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type LlmErrorKind =
  | "http_429"
  | "quota_exhausted"
  | "http_5xx"
  | "http_error"
  | "timeout"
  | "network"
  | "invalid_output";

export interface LlmAttemptError {
  model: string;
  kind: LlmErrorKind;
  detail?: string;
}

export type LlmResult =
  | { ok: true; label: Category; reason: string; model: string; errors: LlmAttemptError[] }
  | { ok: false; errors: LlmAttemptError[] };

const OutputSchema = z.object({
  label: z.string(),
  reason: z.string().optional(),
});

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/\s*\/\s*/g, " / ").trim();
}

/** Maps a model's label string to the exact category, allowing only case/whitespace differences. */
export function toCategory(raw: string): Category | null {
  const n = normalize(raw);
  return CATEGORIES.find((c) => normalize(c) === n) ?? null;
}

/** Extracts the first balanced {...} object from text (handles code fences and chatter). */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parses and validates model output. Returns null when it isn't exactly one valid category. */
export function parseLlmOutput(content: string | null | undefined): { label: Category; reason: string } | null {
  if (!content) return null;
  const stripped = content.replace(/```(?:json)?/gi, "");
  const json = firstJsonObject(stripped);
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = OutputSchema.safeParse(data);
  if (!parsed.success) return null;
  const label = toCategory(parsed.data.label);
  if (!label) return null;
  return { label, reason: (parsed.data.reason ?? "").slice(0, 200) };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function callModel(
  model: string,
  email: EmailFeatures,
  config: LlmConfig,
  fetchImpl: FetchLike,
): Promise<{ ok: true; content: string } | { ok: false; error: LlmAttemptError }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.appUrl,
        "X-Title": "job-inbox-classifier",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        // Many free models "think" before answering; turn that off and leave room in case a model
        // ignores the switch, so the JSON answer isn't cut off (empty content = invalid_output).
        max_tokens: 1000,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildEmailBlock(email) },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      const detail = text.slice(0, 300);
      if (res.status === 429) {
        const daily = /per[- ]day|daily|free-models-per-day/i.test(text);
        return { ok: false, error: { model, kind: daily ? "quota_exhausted" : "http_429", detail } };
      }
      return { ok: false, error: { model, kind: res.status >= 500 ? "http_5xx" : "http_error", detail: `${res.status} ${detail}` } };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: { model, kind: "invalid_output", detail: "response was not JSON" } };
    }
    // OpenRouter can return 200 with an error object (e.g. upstream provider failure).
    const b = body as { error?: { message?: string }; choices?: { message?: { content?: string | null } }[] };
    if (b.error) return { ok: false, error: { model, kind: "http_5xx", detail: String(b.error.message ?? "").slice(0, 300) } };
    const content = b.choices?.[0]?.message?.content ?? "";
    return { ok: true, content };
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return { ok: false, error: { model, kind: aborted ? "timeout" : "network", detail: err instanceof Error ? err.message : String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tries each model in order, one attempt per model, no sleeping. Returns the first valid label,
 * or ok:false when every model failed (the email then stays unlabeled — spec D4).
 */
export async function classifyWithLlm(
  email: EmailFeatures,
  config: LlmConfig,
  fetchImpl: FetchLike = fetch,
): Promise<LlmResult> {
  const errors: LlmAttemptError[] = [];
  for (const model of config.models) {
    const r = await callModel(model, email, config, fetchImpl);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    const parsed = parseLlmOutput(r.content);
    if (!parsed) {
      errors.push({ model, kind: "invalid_output", detail: r.content.slice(0, 200) });
      continue;
    }
    return { ok: true, label: parsed.label, reason: parsed.reason, model, errors };
  }
  return { ok: false, errors };
}
