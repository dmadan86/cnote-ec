import { describe, expect, it } from "vitest";
import { domainsConfig } from "../src/config";
import { classifyKind, hostFromHeader, isPlatformHost, subdomainSlug, validateHostname } from "../src/hostname";

const cfg = domainsConfig({ STOREFRONT_ROOT_DOMAIN: "cnote.in", PLATFORM_HOSTS: "app.example.com,*.preview.cnote.dev" } as NodeJS.ProcessEnv);

describe("validateHostname", () => {
  it.each([
    ["www.acme.com", "www.acme.com", "subdomain"],
    ["  WWW.Acme.COM. ", "www.acme.com", "subdomain"],
    ["acme.com", "acme.com", "apex"],
    ["acme.co.in", "acme.co.in", "apex"],
    ["shop.acme.co.in", "shop.acme.co.in", "subdomain"],
    ["bücher.example.de", "xn--bcher-kva.example.de", "subdomain"],
    ["दुकान.भारत", "xn--11b7ah1gn.xn--h2brj9c", "apex"],
  ])("accepts %s", (input, hostname, kind) => {
    expect(validateHostname(input, cfg)).toEqual({ hostname, kind });
  });

  it.each([
    "", "https://acme.com", "acme.com/path", "acme.com:8080", "*.acme.com", "192.168.1.1", "1.2.3.4", "localhost", "acme",
    "acme.local", "foo.internal", "co.in", "com", "-bad-.com", "a..b.com", "acme.c", "exa mple.com", "user@acme.com",
    "cnote.in", "www.cnote.in", "shop.cnote.in", "app.example.com", "x.preview.cnote.dev", "site.vercel.app", "x.github.io",
  ])("rejects %j", (input) => {
    expect(() => validateHostname(input, cfg)).toThrowError();
  });

  it("uses a validation DomainError", () => {
    try {
      validateHostname("1.2.3.4", cfg);
    } catch (e) {
      expect((e as { code: string }).code).toBe("validation");
    }
  });
});

describe("kind and platform helpers", () => {
  it("classifies apex vs subdomain across two-level suffixes", () => {
    expect(classifyKind("acme.com")).toBe("apex");
    expect(classifyKind("acme.co.in")).toBe("apex");
    expect(classifyKind("www.acme.co.in")).toBe("subdomain");
    expect(classifyKind("a.b.acme.com")).toBe("subdomain");
  });
  it("finds platform subdomain slugs and skips infra labels", () => {
    expect(subdomainSlug("acme-tools.cnote.in", cfg)).toBe("acme-tools");
    expect(subdomainSlug("stores.cnote.in", cfg)).toBeNull(); // cname target
    expect(subdomainSlug("www.cnote.in", cfg)).toBeNull();
    expect(subdomainSlug("a.b.cnote.in", cfg)).toBeNull();
    expect(subdomainSlug("acme.com", cfg)).toBeNull();
  });
  it("recognises platform hosts", () => {
    expect(isPlatformHost("cnote.in", cfg)).toBe(true);
    expect(isPlatformHost("app.example.com", cfg)).toBe(true);
    expect(isPlatformHost("pr-1.preview.cnote.dev", cfg)).toBe(true);
    expect(isPlatformHost("127.0.0.1", cfg)).toBe(true);
    expect(isPlatformHost("www.acme.com", cfg)).toBe(false);
  });
  it("strips ports from Host headers", () => {
    expect(hostFromHeader("WWW.Acme.com:3000")).toBe("www.acme.com");
    expect(hostFromHeader(null)).toBe("");
  });
});
