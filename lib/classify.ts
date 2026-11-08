/** Orchestrates rules → LLM into one label decision (spec §7). */
import type { Category, LlmConfig } from "./config";
import type { EmailFeatures } from "./extract";
import { classifyWithLlm, type FetchLike, type LlmAttemptError } from "./llm";
import { matchRule } from "./rules";

export type ClassifyResult =
  | { ok: true; label: Category; source: "rule"; ruleId: string; reason: string }
  | { ok: true; label: Category; source: "llm"; model: string; reason: string; errors: LlmAttemptError[] }
  | { ok: false; errors: LlmAttemptError[] };

export async function classify(email: EmailFeatures, llm: LlmConfig, fetchImpl?: FetchLike): Promise<ClassifyResult> {
  const rule = matchRule(email);
  if (rule) return { ok: true, label: rule.label, source: "rule", ruleId: rule.ruleId, reason: `rule ${rule.ruleId}` };

  const r = await classifyWithLlm(email, llm, fetchImpl);
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, label: r.label, source: "llm", model: r.model, reason: r.reason, errors: r.errors };
}
