/** HTTP behaviour of the two endpoints (spec §6.1, §6.2) with Gmail and the loop mocked out. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/process", () => ({
  processInbox: vi.fn(async () => ({ processed: 1, labeled: 1, failed: 0, skipped: 0, deferred: 0, budgetHit: false })),
}));
vi.mock("../lib/gmail", () => ({
  startWatch: vi.fn(async () => ({ historyId: "1", expiration: "2026-11-15T00:00:00.000Z" })),
}));

import pushHandler, { parsePushBody } from "../api/gmail-push";
import cronHandler from "../api/cron/renew-watch";
import { processInbox } from "../lib/process";
import { startWatch } from "../lib/gmail";

const WEBHOOK = "w".repeat(64);
const CRON = "c".repeat(64);
const ENV = {
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_REFRESH_TOKEN: "token",
  GMAIL_ADDRESS: "Me.Jobs@example.com",
  PUBSUB_TOPIC: "projects/p/topics/t",
  WEBHOOK_SECRET: WEBHOOK,
  CRON_SECRET: CRON,
  OPENROUTER_API_KEY: "k",
  OPENROUTER_MODELS: "a:free, b:free",
};

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const pushBody = (emailAddress: string) => ({
  message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId: 123 })).toString("base64"), messageId: "1" },
  subscription: "projects/p/subscriptions/s",
});

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, ENV);
  vi.clearAllMocks();
});
afterEach(() => {
  process.env = saved;
});

// getConfig caches per process; every test uses the same ENV so the cache is consistent.

describe("POST /api/gmail-push", () => {
  const call = async (req: Record<string, unknown>) => {
    const res = fakeRes();
    await pushHandler({ method: "POST", headers: {}, query: {}, ...req } as never, res as never);
    return res;
  };

  it("401 on wrong key, and no Gmail work", async () => {
    const res = await call({ query: { key: "nope" }, body: pushBody("me.jobs@example.com") });
    expect(res.statusCode).toBe(401);
    expect(processInbox).not.toHaveBeenCalled();
  });
  it("401 on missing key", async () => {
    expect((await call({ body: pushBody("me.jobs@example.com") })).statusCode).toBe(401);
  });
  it("405 on GET", async () => {
    expect((await call({ method: "GET", query: { key: WEBHOOK } })).statusCode).toBe(405);
  });
  it("204 and no processing for a malformed body", async () => {
    const res = await call({ query: { key: WEBHOOK }, body: { nope: true } });
    expect(res.statusCode).toBe(204);
    expect(processInbox).not.toHaveBeenCalled();
  });
  it("204 and no processing for another account", async () => {
    const res = await call({ query: { key: WEBHOOK }, body: pushBody("someone@example.com") });
    expect(res.statusCode).toBe(204);
    expect(processInbox).not.toHaveBeenCalled();
  });
  it("204 after processing with the push lookback", async () => {
    const res = await call({ query: { key: WEBHOOK }, body: pushBody("ME.JOBS@example.com") });
    expect(res.statusCode).toBe(204);
    expect(processInbox).toHaveBeenCalledWith({ lookbackDays: 2, trigger: "push" });
  });
  it("500 when processing fails before any message (Pub/Sub retries)", async () => {
    vi.mocked(processInbox).mockRejectedValueOnce(new Error("label missing"));
    const res = await call({ query: { key: WEBHOOK }, body: pushBody("me.jobs@example.com") });
    expect(res.statusCode).toBe(500);
  });
  it("parsePushBody decodes Pub/Sub data", () => {
    expect(parsePushBody(pushBody("A@B.com"))).toEqual({ emailAddress: "a@b.com", historyId: "123" });
    expect(parsePushBody({ message: { data: "!!!" } })).toBeNull();
  });
});

describe("GET /api/cron/renew-watch", () => {
  const call = async (auth?: string) => {
    const res = fakeRes();
    await cronHandler({ method: "GET", headers: auth ? { authorization: auth } : {}, query: {} } as never, res as never);
    return res;
  };

  it("401 without the cron secret", async () => {
    expect((await call()).statusCode).toBe(401);
    expect((await call("Bearer wrong")).statusCode).toBe(401);
    expect(startWatch).not.toHaveBeenCalled();
  });
  it("renews the watch and sweeps with the long lookback", async () => {
    const res = await call(`Bearer ${CRON}`);
    expect(res.statusCode).toBe(200);
    expect(startWatch).toHaveBeenCalledWith("projects/p/topics/t");
    expect(processInbox).toHaveBeenCalledWith({ lookbackDays: 7, trigger: "cron" });
    expect(res.body).toMatchObject({ watchExpiration: "2026-11-15T00:00:00.000Z", processed: 1, labeled: 1, deferred: 0 });
  });
  it("still sweeps when renewal fails, then returns 500", async () => {
    vi.mocked(startWatch).mockRejectedValueOnce(new Error("permission denied"));
    const res = await call(`Bearer ${CRON}`);
    expect(processInbox).toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ watchError: "permission denied" });
  });
});
