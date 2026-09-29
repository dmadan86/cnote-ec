import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { DomainError } from "@cnote/core";
import type { DomainsConfig } from "./config";

export type DomainKind = "subdomain" | "apex";

const RESERVED_TLDS = new Set(["localhost", "local", "internal", "test", "invalid", "example", "onion", "arpa", "lan", "home", "corp", "intranet"]);
/** Second-level labels that act as public suffixes under a ccTLD (co.in, com.au …): a heuristic, not the full PSL. */
const SLD_SUFFIX = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "nic", "res", "mil"]);
/** Suffixes we never allow as a whole (multi-tenant hosts where a seller can't own the zone). */
const SHARED_SUFFIXES = ["vercel.app", "netlify.app", "github.io", "herokuapp.com", "pages.dev", "workers.dev", "blogspot.com", "wordpress.com", "myshopify.com", "wixsite.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com"];

/** Lowercase, IDNA (punycode) normalise and strip trailing dot. Returns "" for input that is not a bare hostname. */
export function normalizeHostname(input: string): string {
  let h = input.trim().toLowerCase();
  if (!h || /[\s/\\?#@:*_,;]/.test(h)) return "";
  h = h.replace(/\.$/, "");
  return domainToASCII(h);
}

function labelsOf(host: string): string[] {
  return host.split(".");
}

/** Number of labels that make up the public suffix (1 for .com, 2 for .co.in). */
export function publicSuffixLength(host: string): number {
  const l = labelsOf(host);
  if (l.length >= 2 && l[l.length - 1]!.length === 2 && SLD_SUFFIX.has(l[l.length - 2]!)) return 2;
  return 1;
}

export function classifyKind(host: string): DomainKind {
  return labelsOf(host).length <= publicSuffixLength(host) + 1 ? "apex" : "subdomain";
}

/** True for the marketplace's own hosts (root, its subdomains that are not storefront slugs, PLATFORM_HOSTS, IPs). */
export function isPlatformHost(host: string, cfg: DomainsConfig): boolean {
  const h = host.toLowerCase();
  if (isIP(h) || h === "localhost") return true;
  if (h === cfg.rootDomain || h === `www.${cfg.rootDomain}` || h === cfg.cnameTarget) return true;
  return cfg.platformHosts.some((p) => (p.startsWith("*.") ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p));
}

/** Slug of a `<slug>.<root>` platform subdomain, or null. Reserved infra labels are not slugs. */
export function subdomainSlug(host: string, cfg: DomainsConfig): string | null {
  const suffix = `.${cfg.rootDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".") || isPlatformHost(host, cfg)) return null;
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(label) ? label : null;
}

/** Strip port and lowercase a Host header value. */
export function hostFromHeader(value: string | null | undefined): string {
  if (!value) return "";
  const first = value.split(",")[0]!.trim().toLowerCase();
  if (first.startsWith("[")) return first; // IPv6 literal
  return first.replace(/:\d+$/, "").replace(/\.$/, "");
}

/**
 * Validate a seller-supplied hostname. Throws DomainError("validation") with a seller-readable message.
 * Returns the normalised ASCII hostname and its kind.
 */
export function validateHostname(input: string, cfg: DomainsConfig): { hostname: string; kind: DomainKind } {
  const bad = (m: string): never => {
    throw new DomainError("validation", m);
  };
  const raw = input.trim();
  if (/^[a-z]+:\/\//i.test(raw) || raw.includes("/")) bad("Enter only the domain name, like www.example.com (no https:// or path).");
  if (raw.includes(":")) bad("Enter the domain without a port number.");
  if (raw.includes("*")) bad("Wildcard domains are not supported.");
  const hostname = normalizeHostname(raw);
  if (!hostname) bad("That does not look like a valid domain name.");
  if (hostname.length > 253) bad("That domain name is too long.");
  if (isIP(hostname) || /^[\d.]+$/.test(hostname)) bad("Use a domain name, not an IP address.");
  const labels = labelsOf(hostname);
  if (labels.length < 2) bad("Enter a full domain name, like www.example.com.");
  for (const l of labels) {
    if (l.length < 1 || l.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l)) bad("That does not look like a valid domain name.");
  }
  const tld = labels[labels.length - 1]!;
  if (RESERVED_TLDS.has(tld) || !(/^[a-z]{2,63}$/.test(tld) || tld.startsWith("xn--"))) bad("That domain ending is not supported.");
  const psl = publicSuffixLength(hostname);
  if (labels.length <= psl) bad("That is a public domain suffix. Enter a domain you own, like example.in.");
  if (SHARED_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`))) bad("Domains on shared hosting platforms cannot be connected. Use a domain you own.");
  if (hostname === cfg.rootDomain || hostname.endsWith(`.${cfg.rootDomain}`) || isPlatformHost(hostname, cfg)) {
    bad("That address belongs to the platform and is already served automatically.");
  }
  return { hostname, kind: classifyKind(hostname) };
}
