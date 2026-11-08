import { describe, expect, it } from "vitest";
import { isValidCronAuth, isValidWebhookKey, safeEqual } from "../lib/webhook-auth";

const SECRET = "a".repeat(32) + "b".repeat(32);

describe("webhook auth (?key=)", () => {
  it("accepts the correct key", () => expect(isValidWebhookKey(SECRET, SECRET)).toBe(true));
  it("rejects a wrong key of the same length", () => expect(isValidWebhookKey("c".repeat(64), SECRET)).toBe(false));
  it("rejects a key of a different length", () => {
    expect(isValidWebhookKey(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(isValidWebhookKey(SECRET + "x", SECRET)).toBe(false);
  });
  it("rejects a missing or empty key", () => {
    expect(isValidWebhookKey(undefined, SECRET)).toBe(false);
    expect(isValidWebhookKey(null, SECRET)).toBe(false);
    expect(isValidWebhookKey("", SECRET)).toBe(false);
  });
  it("rejects a repeated key parameter (?key=a&key=b)", () => expect(isValidWebhookKey([SECRET, SECRET], SECRET)).toBe(false));
  it("rejects everything when the secret is not configured", () => expect(isValidWebhookKey("", "")).toBe(false));
  it("handles multi-byte characters by byte length", () => expect(safeEqual("é", "e")).toBe(false));
});

describe("cron auth (Bearer)", () => {
  it("accepts Bearer <secret>", () => expect(isValidCronAuth(`Bearer ${SECRET}`, SECRET)).toBe(true));
  it("rejects wrong / missing / bare secret", () => {
    expect(isValidCronAuth(`Bearer x${SECRET.slice(1)}`, SECRET)).toBe(false);
    expect(isValidCronAuth(undefined, SECRET)).toBe(false);
    expect(isValidCronAuth(SECRET, SECRET)).toBe(false);
  });
});
