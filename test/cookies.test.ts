import { describe, it, expect } from "vitest";
import {
  parseCookieString,
  buildCookieHeader,
  validateCredentials,
} from "../src/auth/cookies";

describe("parseCookieString", () => {
  it("extracts auth_token and ct0 from a document.cookie-style string", () => {
    const raw = "guest_id=v1%3A123; auth_token=AAAA1111; ct0=BBBB2222; lang=en";
    expect(parseCookieString(raw)).toEqual({ authToken: "AAAA1111", ct0: "BBBB2222" });
  });

  it("tolerates extra whitespace and quotes", () => {
    const raw = '  auth_token = "tok" ;  ct0="csrf"  ';
    expect(parseCookieString(raw)).toEqual({ authToken: "tok", ct0: "csrf" });
  });

  it("returns a partial result when one is missing", () => {
    expect(parseCookieString("auth_token=only")).toEqual({ authToken: "only" });
    expect(parseCookieString("ct0=only")).toEqual({ ct0: "only" });
  });

  it("returns empty on empty / junk input", () => {
    expect(parseCookieString("")).toEqual({});
    expect(parseCookieString("novalue; =bad")).toEqual({});
  });
});

describe("buildCookieHeader", () => {
  it("builds the Cookie header value", () => {
    expect(buildCookieHeader({ authToken: "a", ct0: "b" })).toBe("auth_token=a; ct0=b");
  });

  it("round-trips with parseCookieString", () => {
    const creds = { authToken: "tok123", ct0: "csrf456" };
    expect(parseCookieString(buildCookieHeader(creds))).toEqual(creds);
  });
});

describe("validateCredentials", () => {
  it("valid when both present", () => {
    expect(validateCredentials({ authToken: "a", ct0: "b" })).toEqual({ valid: true });
  });

  it("invalid (with reason) when ct0 missing", () => {
    const r = validateCredentials({ authToken: "a", ct0: "" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/ct0/);
  });

  it("invalid when auth_token missing", () => {
    const r = validateCredentials({ ct0: "b" });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/auth_token/);
  });

  it("invalid on null/undefined", () => {
    expect(validateCredentials(null).valid).toBe(false);
    expect(validateCredentials(undefined).valid).toBe(false);
  });
});
