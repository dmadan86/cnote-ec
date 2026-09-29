import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { domainsConfig } from "../src/config";
import { classifyKind, hostFromHeader, isPlatformHost, normalizeHostname, publicSuffixLength, subdomainSlug, validateHostname } from "../src/hostname";
import { DomainError } from "@cnote/core";

const cfg = domainsConfig({ STOREFRONT_ROOT_DOMAIN: "cnote.in", PLATFORM_HOSTS: "app.example.org,*.internal-tools.io" } as NodeJS.ProcessEnv);
const reject = (h: string) => expect(() => validateHostname(h, cfg), h).toThrow(DomainError);

describe("validateHostname table", () => {
  it.each([
    ["https://www.acme.com", "scheme"], ["www.acme.com/path", "path"], ["www.acme.com:8080", "port"], ["*.acme.com", "wildcard"],
    ["", "empty"], ["   ", "blank"], ["acme", "single label"], ["localhost", "localhost"], ["acme.local", "reserved tld"],
    ["acme.internal", "internal"], ["foo.test", "test"], ["1.2.3.4", "ipv4"], ["999.999.1.1", "numeric"], ["[::1]", "ipv6"],
    ["-acme.com", "leading hyphen"], ["acme-.com", "trailing hyphen"], ["ac me.com", "space"], ["acme_x.com", "underscore"],
    ["co.in", "public suffix co.in"], ["com.au", "public suffix"], ["acme.c", "1-char tld"], ["acme.123", "numeric tld"],
    ["shop.vercel.app", "shared"], ["x.github.io", "shared"], ["x.myshopify.com", "shared"], ["cnote.in", "platform root"],
    ["shop.cnote.in", "platform sub"], ["stores.cnote.in", "cname target"], ["app.example.org", "platform host"], ["x.internal-tools.io", "wildcard platform"],
    [`${"a".repeat(64)}.com`, "label >63"], [`${Array(30).fill("abcdefgh").join(".")}.com`, ">253"],
  ])("rejects %s (%s)", (h) => reject(h));

  it.each([
    ["www.acme.com", "www.acme.com", "subdomain"], ["ACME.com", "acme.com", "apex"], ["acme.co.in", "acme.co.in", "apex"],
    ["shop.acme.co.in", "shop.acme.co.in", "subdomain"], ["acme.com.", "acme.com", "apex"], ["  Shop.Acme.In ", "shop.acme.in", "subdomain"],
    ["bücher.de", "xn--bcher-kva.de", "apex"], ["www.bücher.de", "www.xn--bcher-kva.de", "subdomain"], ["acme.xn--p1ai", "acme.xn--p1ai", "apex"],
  ])("accepts %s", (input, host, kind) => {
    expect(validateHostname(input, cfg)).toEqual({ hostname: host, kind });
  });

  it("error messages are seller-readable and typed as validation", () => {
    try { validateHostname("https://x.com", cfg); expect.unreachable(); } catch (e) { expect((e as DomainError).message).toMatch(/no https/); expect((e as DomainError).code).toBe("validation"); }
  });
});

describe("hostname helpers", () => {
  it("publicSuffixLength / classifyKind", () => {
    expect(publicSuffixLength("acme.co.in")).toBe(2);
    expect(publicSuffixLength("acme.com")).toBe(1);
    expect(publicSuffixLength("acme.com.au")).toBe(2);
    expect(publicSuffixLength("co.com")).toBe(1);
    expect(classifyKind("acme.co.in")).toBe("apex");
    expect(classifyKind("www.acme.co.in")).toBe("subdomain");
  });
  it("isPlatformHost", () => {
    expect(isPlatformHost("10.0.0.1", cfg)).toBe(true);
    expect(isPlatformHost("localhost", cfg)).toBe(true);
    expect(isPlatformHost("www.cnote.in", cfg)).toBe(true);
    expect(isPlatformHost("internal-tools.io", cfg)).toBe(true);
    expect(isPlatformHost("a.internal-tools.io", cfg)).toBe(true);
    expect(isPlatformHost("evilinternal-tools.io", cfg)).toBe(false);
    expect(isPlatformHost("acme.com", cfg)).toBe(false);
  });
  it("subdomainSlug", () => {
    expect(subdomainSlug("acme-shop.cnote.in", cfg)).toBe("acme-shop");
    expect(subdomainSlug("www.cnote.in", cfg)).toBeNull();
    expect(subdomainSlug("stores.cnote.in", cfg)).toBeNull();
    expect(subdomainSlug("a.b.cnote.in", cfg)).toBeNull();
    expect(subdomainSlug("cnote.in", cfg)).toBeNull();
    expect(subdomainSlug("x.cnote.in", cfg)).toBeNull(); // too short
    expect(subdomainSlug("-ab.cnote.in", cfg)).toBeNull();
    expect(subdomainSlug("acme.com", cfg)).toBeNull();
  });
  it("hostFromHeader", () => {
    expect(hostFromHeader(null)).toBe("");
    expect(hostFromHeader(undefined)).toBe("");
    expect(hostFromHeader("Acme.com:443")).toBe("acme.com");
    expect(hostFromHeader("a.com, b.com")).toBe("a.com");
    expect(hostFromHeader("[::1]:3000")).toBe("[::1]:3000");
    expect(hostFromHeader("acme.com.")).toBe("acme.com");
  });
  it("normalizeHostname rejects non-hostnames", () => {
    for (const s of ["", "a b", "a/b", "a@b", "a:1", "a*b", "a_b", "a,b"]) expect(normalizeHostname(s)).toBe("");
  });
});

describe("properties", () => {
  const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
  const tld = fc.constantFrom("com", "in", "org", "shop", "store");
  it("validateHostname never throws anything but DomainError on arbitrary input", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => {
      try { validateHostname(s, cfg); } catch (e) { expect(e).toBeInstanceOf(DomainError); }
    }), { numRuns: 500 });
  });
  it("accepted hostnames are ASCII lowercase, idempotent under normalise, and valid labels", () => {
    fc.assert(fc.property(fc.array(label, { minLength: 1, maxLength: 3 }), tld, (ls, t) => {
      const input = `${ls.join(".")}.${t}`;
      let r;
      try { r = validateHostname(input, cfg); } catch { return; }
      expect(r.hostname).toMatch(/^[a-z0-9.-]+$/);
      expect(normalizeHostname(r.hostname)).toBe(r.hostname);
      expect(validateHostname(r.hostname, cfg).hostname).toBe(r.hostname);
      expect(r.kind).toBe(classifyKind(r.hostname));
    }), { numRuns: 300 });
  });
  it("case and trailing dot never change the outcome", () => {
    fc.assert(fc.property(fc.array(label, { minLength: 1, maxLength: 3 }), tld, (ls, t) => {
      const h = `${ls.join(".")}.${t}`;
      const run = (x: string) => { try { return validateHostname(x, cfg); } catch { return null; } };
      expect(run(h.toUpperCase() + ".")).toEqual(run(h));
    }), { numRuns: 200 });
  });
  it("any host under the platform root is rejected", () => {
    fc.assert(fc.property(label, (l) => { reject(`${l}.cnote.in`); }), { numRuns: 100 });
  });
  it("slugs extracted are always valid single labels", () => {
    fc.assert(fc.property(fc.string({ maxLength: 20 }), (s) => {
      const slug = subdomainSlug(`${s.toLowerCase()}.cnote.in`, cfg);
      if (slug) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
    }), { numRuns: 300 });
  });
});
