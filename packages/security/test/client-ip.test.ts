import { describe, expect, it } from "vitest";
import { clientIp } from "../src/client-ip";

const h = (o: Record<string, string>) => new Headers(o);

describe("clientIp", () => {
  it("prefers cf-connecting-ip (Cloudflare overwrites client values)", () => {
    expect(clientIp(h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("203.0.113.9");
  });
  it("ignores the client-controlled first X-Forwarded-For entry; takes the one our proxy added", () => {
    // attacker sends "X-Forwarded-For: 6.6.6.6"; our ingress appends the real peer
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.2" }), { TRUSTED_PROXY_HOPS: "2" })).toBe("198.51.100.7");
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.7" }), { TRUSTED_PROXY_HOPS: "5" })).toBe("198.51.100.7");
  });
  it("falls back to x-real-ip; rejects junk; null when nothing usable", () => {
    expect(clientIp(h({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(h({ "cf-connecting-ip": "not an ip", "x-real-ip": "192.0.2.1" }))).toBe("192.0.2.1");
    expect(clientIp(h({ "x-forwarded-for": " , " }))).toBeNull();
    expect(clientIp(h({}))).toBeNull();
    expect(clientIp(h({ "x-forwarded-for": "junk!" }), { TRUSTED_PROXY_HOPS: "abc" })).toBeNull();
  });
});
