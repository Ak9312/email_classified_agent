/** Applies the deterministic rules in rules.config.ts (spec §7.3). */
import type { EmailFeatures } from "./extract";
import { RULES, RULE_GUARD_SUBJECT, type Rule } from "./rules.config";

export interface RuleMatch {
  label: "Job Alerts";
  ruleId: string;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

function senderMatches(rule: Rule, address: string): boolean {
  const addr = address.toLowerCase();
  if (rule.fromAddress?.some((a) => a.toLowerCase() === addr)) return true;
  const domain = domainOf(addr);
  if (!domain) return false;
  return Boolean(rule.fromDomain?.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`)));
}

export function matchRule(email: Pick<EmailFeatures, "from" | "subject">, rules: Rule[] = RULES): RuleMatch | null {
  if (RULE_GUARD_SUBJECT.test(email.subject)) return null;
  for (const rule of rules) {
    if (!rule.fromAddress?.length && !rule.fromDomain?.length) continue; // a rule must name a sender
    if (!senderMatches(rule, email.from.address)) continue;
    if (rule.subjectRegex && !rule.subjectRegex.test(email.subject)) continue;
    return { label: rule.label, ruleId: rule.id };
  }
  return null;
}
