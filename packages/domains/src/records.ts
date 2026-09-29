import { randomBytes } from "node:crypto";
import type { DomainsConfig } from "./config";
import type { DomainKind } from "./hostname";

export interface DnsRecord {
  type: "CNAME" | "A" | "ALIAS" | "TXT";
  /** fully-qualified name to create the record at */
  name: string;
  value: string;
  purpose: "routing" | "ownership";
}

export interface ExpectedRecords {
  kind: DomainKind;
  records: DnsRecord[];
  /** Human hint, e.g. how to do an apex on providers without ALIAS. */
  note?: string;
}

export const VERIFY_LABEL = "_cnote-verify";

export function newVerifyToken(): string {
  return `cnote-verify=${randomBytes(16).toString("hex")}`;
}

export function buildExpectedRecords(hostname: string, kind: DomainKind, verifyToken: string, cfg: DomainsConfig): ExpectedRecords {
  const txt: DnsRecord = { type: "TXT", name: `${VERIFY_LABEL}.${hostname}`, value: verifyToken, purpose: "ownership" };
  if (kind === "subdomain") {
    return { kind, records: [{ type: "CNAME", name: hostname, value: cfg.cnameTarget, purpose: "routing" }, txt] };
  }
  if (cfg.apexIps.length) {
    return {
      kind,
      records: [...cfg.apexIps.map((ip): DnsRecord => ({ type: "A", name: hostname, value: ip, purpose: "routing" })), txt],
      note: "If your DNS provider supports ALIAS/ANAME/CNAME flattening you can point the root domain to " + cfg.cnameTarget + " instead.",
    };
  }
  return {
    kind,
    records: [{ type: "ALIAS", name: hostname, value: cfg.cnameTarget, purpose: "routing" }, txt],
    note: "Use an ALIAS, ANAME or flattened CNAME record for the root domain. If your DNS provider does not offer one, connect www." + hostname + " instead and redirect the root domain to it.",
  };
}
