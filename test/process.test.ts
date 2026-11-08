/** The shared loop (spec §6.3): skip labeled mail, dry run, time budget, failures. */
import { describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import type { ClassifyResult } from "../lib/classify";
import type { LabelIds } from "../lib/gmail";
import { processInbox, type ProcessDeps } from "../lib/process";

const labelIds: LabelIds = { "Interview / Recruiter": "L1", "Job Alerts": "L2", Rejections: "L3", Other: "L4" };

function msg(id: string, labels: string[] = ["INBOX", "UNREAD"]): gmail_v1.Schema$Message {
  const header = (name: string, value: string) => ({ name, value });
  return {
    id,
    labelIds: labels,
    payload: {
      headers: [header("From", "Riya <riya@example-corp.com>"), header("Subject", `Subject ${id}`)],
      mimeType: "text/plain",
      body: { data: Buffer.from("hello").toString("base64url") },
    },
  };
}

function setup(over: Partial<ProcessDeps> & { messages?: Record<string, gmail_v1.Schema$Message> } = {}) {
  const messages = over.messages ?? { a: msg("a"), b: msg("b"), c: msg("c") };
  let clock = 0;
  const deps: ProcessDeps = {
    config: { llm: { apiKey: "", models: [], timeoutMs: 1, appUrl: "" }, dryRun: false, maxMessagesPerRun: 10, runTimeBudgetMs: 45_000 },
    resolveLabelIds: async () => labelIds,
    listCandidates: async () => Object.keys(messages),
    getMessage: async (id) => messages[id],
    addLabel: vi.fn(async () => {}),
    classify: vi.fn(async (): Promise<ClassifyResult> => ({ ok: true, label: "Rejections", source: "llm", model: "m", reason: "r", errors: [] })),
    now: () => clock,
    ...over,
  };
  return { deps, advance: (ms: number) => (clock += ms) };
}

describe("processInbox", () => {
  it("labels every unlabeled candidate with the classified label", async () => {
    const { deps } = setup();
    const c = await processInbox({ lookbackDays: 2, trigger: "push" }, deps);
    expect(c).toMatchObject({ processed: 3, labeled: 3, failed: 0, skipped: 0, deferred: 0, budgetHit: false });
    expect(deps.addLabel).toHaveBeenCalledWith("a", "L3");
  });

  it("skips messages that already have one of the four labels", async () => {
    const { deps } = setup({ messages: { a: msg("a", ["INBOX", "L2"]), b: msg("b") } });
    const c = await processInbox({ lookbackDays: 2, trigger: "push" }, deps);
    expect(c).toMatchObject({ processed: 1, labeled: 1, skipped: 1 });
    expect(deps.addLabel).toHaveBeenCalledTimes(1);
    expect(deps.addLabel).toHaveBeenCalledWith("b", "L3");
  });

  it("DRY_RUN never calls addLabel", async () => {
    const { deps } = setup();
    deps.config = { ...deps.config, dryRun: true };
    const c = await processInbox({ lookbackDays: 2, trigger: "push" }, deps);
    expect(c.labeled).toBe(3);
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("failed classification leaves the message unlabeled", async () => {
    const { deps } = setup({ classify: vi.fn(async (): Promise<ClassifyResult> => ({ ok: false, errors: [{ model: "m", kind: "timeout" }] })) });
    const c = await processInbox({ lookbackDays: 2, trigger: "push" }, deps);
    expect(c).toMatchObject({ processed: 3, labeled: 0, failed: 3 });
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("stops starting new messages after the time budget, but finishes the current one", async () => {
    const { deps, advance } = setup();
    deps.classify = vi.fn(async (): Promise<ClassifyResult> => {
      advance(30_000); // each message takes 30 s
      return { ok: true, label: "Other", source: "llm", model: "m", reason: "r", errors: [] };
    });
    const c = await processInbox({ lookbackDays: 2, trigger: "push" }, deps);
    // a: starts at 0 s; b: starts at 30 s (< 45 s) and finishes at 60 s; c: not started.
    expect(c).toMatchObject({ processed: 2, labeled: 2, deferred: 1, budgetHit: true });
  });

  it("respects MAX_MESSAGES_PER_RUN", async () => {
    const { deps } = setup();
    deps.config = { ...deps.config, maxMessagesPerRun: 2 };
    const c = await processInbox({ lookbackDays: 2, trigger: "cron" }, deps);
    expect(c).toMatchObject({ processed: 2, deferred: 1, budgetHit: false });
  });

  it("re-checks labels right before writing (concurrent run already labeled it)", async () => {
    const first = msg("a");
    const { deps } = setup({ messages: { a: first } });
    deps.getMessage = vi.fn(async (_id: string, format: "full" | "minimal") => (format === "minimal" ? msg("a", ["INBOX", "L4"]) : first));
    const c = await processInbox({ lookbackDays: 2, trigger: "push" }, deps);
    expect(c).toMatchObject({ processed: 1, labeled: 0, skipped: 1 });
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("throws (→ 500) when the labels cannot be resolved", async () => {
    const { deps } = setup({ resolveLabelIds: async () => Promise.reject(new Error("Gmail label(s) not found")) });
    await expect(processInbox({ lookbackDays: 2, trigger: "push" }, deps)).rejects.toThrow(/not found/);
  });
});
