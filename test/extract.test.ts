import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import { cleanBody, extract, parseAddress, splitAddressList, stripQuotedReply } from "../lib/extract";

const load = (name: string): gmail_v1.Schema$Message =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", "mime", name), "utf8"));

describe("extract", () => {
  it("plain text: headers, addresses, whitespace", () => {
    const e = extract(load("plain.json"));
    expect(e.from).toEqual({ name: "Sharma, Riya", address: "riya.sharma@example-corp.com" });
    expect(e.replyTo).toEqual({ name: "Recruiting", address: "jobs@example-corp.com" });
    expect(e.to).toEqual(["candidate@example.com", "other@example.com"]);
    expect(e.cc).toEqual(["hr@example-corp.com"]);
    expect(e.subject).toBe("Interview for Data Analyst");
    expect(e.date).toBe(new Date(1760432400000).toISOString());
    expect(e.headers).toEqual({});
    expect(e.bodyText).toBe("Hi Candidate,\n\nCan you do a call tomorrow at 11?\n\nThanks,\nRiya");
    expect(e.snippet).toContain("Can you do a call");
  });

  it("HTML-only: converted to text, links/images/scripts dropped, automation headers kept", () => {
    const e = extract(load("html-only.json"));
    expect(e.bodyText).toContain("Data Analyst & BI — Example Corp");
    expect(e.bodyText.toUpperCase()).toContain("JOBS FOR YOU");
    expect(e.bodyText).not.toContain("https://");
    expect(e.bodyText).not.toContain("track()");
    expect(e.bodyText).not.toContain("color:red");
    expect(e.headers).toEqual({ "List-Unsubscribe": "<https://example.com/unsub>", Precedence: "bulk" });
  });

  it("multipart: prefers text/plain and ignores attachments", () => {
    const e = extract(load("multipart.json"));
    expect(e.bodyText).toBe("PLAIN VERSION: please pick an interview slot.");
  });

  it("quoted reply (Gmail style, wrapped 'wrote:' line) is stripped", () => {
    const e = extract(load("quoted-reply.json"));
    expect(e.bodyText).toBe("Thanks! Confirming Thursday 3 PM.\n\nNeha");
  });

  it("quoted reply (Outlook header block) is stripped", () => {
    const e = extract(load("outlook-reply.json"));
    expect(e.bodyText).toBe("Sounds good, talk soon.");
  });

  it("truncates the body to 3,000 characters", () => {
    expect(cleanBody("x".repeat(5000))).toHaveLength(3000);
  });

  it("empty message does not crash", () => {
    const e = extract({ id: "x" });
    expect(e).toMatchObject({ from: { name: "", address: "" }, replyTo: null, to: [], subject: "", bodyText: "", snippet: "" });
  });
});

describe("address helpers", () => {
  it("parseAddress handles bare and named addresses", () => {
    expect(parseAddress("A@B.com")).toEqual({ name: "", address: "a@b.com" });
    expect(parseAddress("Name Here <x@y.com>")).toEqual({ name: "Name Here", address: "x@y.com" });
    expect(parseAddress(undefined)).toEqual({ name: "", address: "" });
  });
  it("splitAddressList respects quoted commas", () => {
    expect(splitAddressList('"Doe, Jane" <j@x.com>, k@y.com')).toEqual(["j@x.com", "k@y.com"]);
  });
  it("stripQuotedReply drops '>' lines", () => {
    expect(stripQuotedReply("hello\n> old\n>> older\nbye")).toBe("hello\nbye");
  });
});
