import { Resolver } from "node:dns/promises";
import type { DomainsConfig } from "./config";
import type { DomainKind } from "./hostname";
import { VERIFY_LABEL } from "./records";

export interface CaaRecord {
  critical?: number;
  issue?: string;
  issuewild?: string;
  iodef?: string;
}

/** The DNS surface verification needs. Inject a fake in tests. Methods return [] for "no such record". */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolveCaa(name: string): Promise<CaaRecord[]>;
}

const EMPTY_CODES = new Set(["ENODATA", "ENOTFOUND", "ENOENT", "NODATA", "NXDOMAIN", "EBADNAME"]);

async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && EMPTY_CODES.has(code)) return [];
    throw err;
  }
}

/** Resolver pinned to public DNS so results match what the wider internet sees. */
export function createPublicResolver(cfg: DomainsConfig): DnsResolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(cfg.resolvers);
  return {
    resolveTxt: (n) => orEmpty(r.resolveTxt(n)),
    resolveCname: (n) => orEmpty(r.resolveCname(n)),
    resolve4: (n) => orEmpty(r.resolve4(n)),
    resolveCaa: (n) => orEmpty(r.resolveCaa(n) as Promise<CaaRecord[]>),
  };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

export interface DnsDiagnostics {
  checkedAt: string;
  txt: { name: string; expected: string; observed: string[]; ok: boolean };
  routing: {
    mode: "cname" | "a";
    expected: string[];
    observedCname: string[];
    observedA: string[];
    ok: boolean;
    /** how it matched: direct CNAME, CNAME chain, or A records overlapping our edge (proxied / flattened) */
    via?: "cname" | "cname-chain" | "a-overlap";
  };
  caa: { records: string[]; blocking: boolean; allowed: string[]; warning?: string };
  /** seller-readable problems, empty when ok */
  problems: string[];
  /** resolver failures (SERVFAIL/timeouts), as opposed to records that are simply absent: treat as transient */
  lookupErrors: number;
  ok: boolean;
}

async function followCname(r: DnsResolver, host: string, target: string, maxHops = 5): Promise<{ chain: string[]; hit: boolean }> {
  const chain: string[] = [];
  let cur = host;
  for (let i = 0; i < maxHops; i++) {
    const next = (await r.resolveCname(cur)).map(norm);
    if (!next.length) break;
    chain.push(next[0]!);
    if (next.includes(target)) return { chain, hit: true };
    cur = next[0]!;
  }
  return { chain, hit: false };
}

/** CAA lookup walks up the tree; the closest name that has records wins (RFC 8659). */
export async function checkCaa(r: DnsResolver, hostname: string, allowedIssuers: string[]): Promise<DnsDiagnostics["caa"]> {
  const labels = hostname.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join(".");
    let recs: CaaRecord[] = [];
    try {
      recs = await r.resolveCaa(name);
    } catch {
      return { records: [], blocking: false, allowed: allowedIssuers };
    }
    const issue = recs.filter((c) => c.issue !== undefined).map((c) => norm((c.issue ?? "").split(";")[0] ?? ""));
    if (recs.length) {
      const display = recs.map((c) => (c.issue !== undefined ? `issue "${c.issue}"` : c.issuewild !== undefined ? `issuewild "${c.issuewild}"` : "iodef"));
      if (!issue.length) return { records: display, blocking: false, allowed: allowedIssuers }; // only issuewild/iodef: no restriction on plain certs
      const ok = issue.some((i) => i !== "" && allowedIssuers.some((a) => i === a || i.endsWith(`.${a}`)));
      return {
        records: display,
        blocking: !ok,
        allowed: allowedIssuers,
        warning: ok ? undefined : `Your CAA records (on ${name}) do not allow our certificate authorities. Add a CAA record allowing: ${allowedIssuers.join(", ")}.`,
      };
    }
  }
  return { records: [], blocking: false, allowed: allowedIssuers };
}

/**
 * Check that ownership TXT and routing records are in place, as seen from public resolvers.
 * Never throws for missing records; resolver errors (SERVFAIL, timeouts) become `problems`.
 */
export async function checkDns(
  r: DnsResolver,
  d: { hostname: string; kind: DomainKind; verifyToken: string },
  cfg: DomainsConfig,
  caaIssuers: string[],
  now: () => Date = () => new Date(),
): Promise<DnsDiagnostics> {
  const problems: string[] = [];
  let lookupErrors = 0;
  const safe = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch (err) {
      lookupErrors++;
      problems.push(`DNS lookup for ${label} failed (${(err as { code?: string }).code ?? "error"}). We will retry shortly.`);
      return [];
    }
  };

  const txtName = `${VERIFY_LABEL}.${d.hostname}`;
  const txtObserved = (await safe(txtName, () => r.resolveTxt(txtName))).map((parts) => parts.join(""));
  const txtOk = txtObserved.some((v) => v.trim() === d.verifyToken);
  if (!txtOk) {
    problems.push(
      txtObserved.length
        ? `The TXT record at ${txtName} has a different value than expected.`
        : `We could not find the TXT record at ${txtName}. DNS changes can take up to a few hours to spread.`,
    );
  }

  const target = norm(cfg.cnameTarget);
  const observedCname = (await safe(d.hostname, () => r.resolveCname(d.hostname))).map(norm);
  const observedA = await safe(d.hostname, () => r.resolve4(d.hostname));
  let expected: string[];
  let routingOk = false;
  let via: DnsDiagnostics["routing"]["via"];
  const mode: "cname" | "a" = d.kind === "subdomain" ? "cname" : "a";

  if (d.kind === "subdomain") {
    expected = [target];
    if (observedCname.includes(target)) {
      routingOk = true;
      via = "cname";
    } else if (observedCname.length) {
      const f = await followCname(r, d.hostname, target).catch(() => ({ chain: [] as string[], hit: false }));
      if (f.hit) {
        routingOk = true;
        via = "cname-chain";
      }
    }
    if (!routingOk && observedA.length) {
      const edgeA = new Set([...cfg.apexIps, ...(await safe(target, () => r.resolve4(target)))]);
      if (observedA.some((ip) => edgeA.has(ip))) {
        routingOk = true;
        via = "a-overlap";
      }
    }
    if (!routingOk) {
      if (observedCname.length) problems.push(`${d.hostname} points to ${observedCname.join(", ")} instead of ${target}.`);
      else if (observedA.length) problems.push(`${d.hostname} has A records (${observedA.join(", ")}) but should be a CNAME to ${target}. Remove the A records first.`);
      else problems.push(`We could not find a CNAME for ${d.hostname} pointing to ${target}.`);
    }
  } else {
    const edgeA = new Set(cfg.apexIps);
    if (!edgeA.size) for (const ip of await safe(target, () => r.resolve4(target))) edgeA.add(ip);
    expected = [...edgeA];
    if (observedA.some((ip) => edgeA.has(ip))) {
      routingOk = true;
      via = "a-overlap";
    } else if (observedCname.includes(target)) {
      routingOk = true;
      via = "cname";
    } else {
      problems.push(
        observedA.length
          ? `${d.hostname} points to ${observedA.join(", ")} but should point to ${expected.join(", ") || target}.`
          : `We could not find A/ALIAS records for ${d.hostname} pointing to ${expected.join(", ") || target}.`,
      );
    }
  }

  const caa = await checkCaa(r, d.hostname, caaIssuers).catch(() => ({ records: [], blocking: false, allowed: caaIssuers }) as DnsDiagnostics["caa"]);
  if (caa.warning) problems.push(caa.warning);

  return {
    checkedAt: now().toISOString(),
    txt: { name: txtName, expected: d.verifyToken, observed: txtObserved, ok: txtOk },
    routing: { mode, expected, observedCname, observedA, ok: routingOk, via },
    caa,
    problems,
    lookupErrors,
    ok: txtOk && routingOk,
  };
}
