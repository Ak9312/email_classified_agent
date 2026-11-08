/**
 * The shared loop used by both endpoints (spec §6.3): find recent inbox mail that has none of the
 * four labels, classify it, add one label. Stateless — the labels themselves record what is done.
 */
import type { gmail_v1 } from "googleapis";
import { CATEGORIES, getConfig, log, type AppConfig } from "./config";
import { classify, type ClassifyResult } from "./classify";
import { extract, type EmailFeatures } from "./extract";
import * as gmailApi from "./gmail";

export interface ProcessCounters {
  processed: number;
  labeled: number;
  failed: number;
  skipped: number;
  deferred: number;
  budgetHit: boolean;
}

/** Everything processInbox touches, injectable for tests. */
export interface ProcessDeps {
  config: Pick<AppConfig, "llm" | "dryRun" | "maxMessagesPerRun" | "runTimeBudgetMs">;
  resolveLabelIds: () => Promise<gmailApi.LabelIds>;
  listCandidates: (lookbackDays: number) => Promise<string[]>;
  getMessage: (id: string, format: "full" | "minimal") => Promise<gmail_v1.Schema$Message>;
  addLabel: (messageId: string, labelId: string) => Promise<void>;
  classify: (email: EmailFeatures) => Promise<ClassifyResult>;
  now: () => number;
}

export function defaultDeps(): ProcessDeps {
  const config = getConfig();
  return {
    config,
    resolveLabelIds: gmailApi.resolveLabelIds,
    listCandidates: gmailApi.listCandidates,
    getMessage: gmailApi.getMessage,
    addLabel: gmailApi.addLabel,
    classify: (email) => classify(email, config.llm),
    now: Date.now,
  };
}

function hasClassifierLabel(message: gmail_v1.Schema$Message, ourIds: string[]): boolean {
  return (message.labelIds ?? []).some((id) => ourIds.includes(id));
}

/**
 * Throws only for failures before any message is processed (label lookup, listing) so the caller
 * can return 500. Per-message failures are logged and counted, never thrown.
 */
export async function processInbox(
  opts: { lookbackDays: number; trigger: "push" | "cron" },
  deps: ProcessDeps = defaultDeps(),
): Promise<ProcessCounters> {
  const startedAt = deps.now();
  const { config } = deps;
  const counters: ProcessCounters = { processed: 0, labeled: 0, failed: 0, skipped: 0, deferred: 0, budgetHit: false };

  const labelIds = await deps.resolveLabelIds();
  const ourIds = CATEGORIES.map((c) => labelIds[c]);
  const candidates = await deps.listCandidates(opts.lookbackDays);

  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];

    // Budget is checked BEFORE starting a message; one already started always finishes.
    if (deps.now() - startedAt >= config.runTimeBudgetMs) {
      counters.budgetHit = true;
      counters.deferred = candidates.length - i;
      break;
    }
    if (counters.processed >= config.maxMessagesPerRun) {
      counters.deferred = candidates.length - i;
      break;
    }

    const t0 = deps.now();
    let message: gmail_v1.Schema$Message;
    try {
      message = await deps.getMessage(id, "full");
    } catch (err) {
      counters.failed++;
      log("classify_failed", { msgId: id, errors: [{ kind: "gmail_get", detail: errMsg(err) }] });
      continue;
    }

    // Already labeled (by us earlier, or by hand) — always respected, never touched.
    if (hasClassifierLabel(message, ourIds)) {
      counters.skipped++;
      continue;
    }

    counters.processed++;
    const email = extract(message);
    const base = { msgId: id, from: email.from.address, subject: email.subject };

    let result: ClassifyResult;
    try {
      result = await deps.classify(email);
    } catch (err) {
      counters.failed++;
      log("classify_failed", { ...base, errors: [{ kind: "exception", detail: errMsg(err) }], ms: deps.now() - t0 });
      continue;
    }

    if (!result.ok) {
      counters.failed++;
      log("classify_failed", { ...base, errors: result.errors, ms: deps.now() - t0 });
      continue;
    }

    try {
      // Re-check right before writing, to reduce races between overlapping invocations.
      const fresh = await deps.getMessage(id, "minimal");
      if (hasClassifierLabel(fresh, ourIds)) {
        counters.skipped++;
        continue;
      }
      if (!config.dryRun) await deps.addLabel(id, labelIds[result.label]);
      counters.labeled++;
      log("classified", {
        ...base,
        label: result.label,
        source: result.source,
        ...(result.source === "llm" ? { model: result.model } : { ruleId: result.ruleId }),
        reason: result.reason,
        dryRun: config.dryRun,
        trigger: opts.trigger,
        ms: deps.now() - t0,
      });
    } catch (err) {
      counters.failed++;
      log("classify_failed", { ...base, errors: [{ kind: "gmail_write", detail: errMsg(err) }], ms: deps.now() - t0 });
    }
  }

  log("run_done", { trigger: opts.trigger, candidates: candidates.length, ...counters, ms: deps.now() - startedAt });
  return counters;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
