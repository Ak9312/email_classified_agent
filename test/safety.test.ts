/**
 * Safety guarantees (spec §9): the system can only ADD one of the four labels. This test fails the
 * build if any code could delete, trash, archive, mark as read, remove labels, send mail, or
 * create/edit labels.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { __setGmailClientForTests, addLabel, type LabelIds } from "../lib/gmail";

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["api", "lib", "scripts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

const files = SOURCE_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)));
const sources = files.map((f) => ({ file: relative(ROOT, f), text: readFileSync(f, "utf8") }));

const FORBIDDEN = [
  "messages.delete",
  "messages.trash",
  "batchDelete",
  "batchModify",
  "threads.modify",
  "threads.trash",
  "removeLabelIds",
  "labels.create",
  "labels.delete",
  "labels.patch",
  "labels.update",
  "messages.send",
  "drafts.",
];

describe("safety: forbidden Gmail operations", () => {
  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  for (const term of FORBIDDEN) {
    it(`no source file contains "${term}"`, () => {
      const hits = sources.filter((s) => s.text.includes(term)).map((s) => s.file);
      expect(hits).toEqual([]);
    });
  }

  it("only lib/gmail.ts imports googleapis at runtime", () => {
    const importers = sources
      .filter((s) => /from\s+["']googleapis["']|require\(\s*["']googleapis["']\s*\)/.test(s.text))
      // `import type` is erased at compile time and cannot call the API
      .filter((s) => /import\s+(?!type\b)[^;]*from\s+["']googleapis["']|require\(\s*["']googleapis["']\s*\)/.test(s.text))
      .map((s) => s.file);
    expect(importers).toEqual(["lib/gmail.ts"]);
  });

  it("messages.modify is called exactly once, inside lib/gmail.ts", () => {
    const calls = sources.flatMap((s) => (s.text.match(/\.modify\(/g) ?? []).map(() => s.file));
    expect(calls).toEqual(["lib/gmail.ts"]);
  });

  it("no code sets UNREAD/INBOX/TRASH/SPAM as a label to add", () => {
    const hits = sources.filter((s) => /addLabelIds\s*:\s*\[\s*["'](UNREAD|INBOX|TRASH|SPAM)["']/.test(s.text)).map((s) => s.file);
    expect(hits).toEqual([]);
  });
});

describe("safety: addLabel behaviour", () => {
  const labelIds: LabelIds = { "Interview / Recruiter": "L1", "Job Alerts": "L2", Rejections: "L3", Other: "L4" };

  function fakeClient() {
    const modify = vi.fn(async () => ({ data: {} }));
    __setGmailClientForTests({ users: { messages: { modify } } }, labelIds);
    return modify;
  }

  it("sends only addLabelIds with exactly one classifier label", async () => {
    const modify = fakeClient();
    await addLabel("msg1", "L3");
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith({ userId: "me", id: "msg1", requestBody: { addLabelIds: ["L3"] } });
    const call = modify.mock.calls[0] as unknown as [{ requestBody: Record<string, unknown> }];
    expect(Object.keys(call[0].requestBody)).toEqual(["addLabelIds"]);
  });

  for (const bad of ["TRASH", "SPAM", "INBOX", "UNREAD", "IMPORTANT", "Label_999", ""]) {
    it(`refuses to add ${JSON.stringify(bad)}`, async () => {
      const modify = fakeClient();
      await expect(addLabel("msg1", bad)).rejects.toThrow(/Refusing/);
      expect(modify).not.toHaveBeenCalled();
    });
  }

  it("refuses everything before the label IDs are resolved", async () => {
    const modify = vi.fn();
    __setGmailClientForTests({ users: { messages: { modify } } });
    await expect(addLabel("msg1", "L1")).rejects.toThrow(/Refusing/);
    expect(modify).not.toHaveBeenCalled();
  });
});
