// @cnote/domains — custom domains for storefronts (DNS verification queue, edge provider port, host resolution)
// and privacy-friendly per-storefront traffic metering. PUBLIC CONTRACT. Extend, don't break.
export { domainsConfig, domainCheckSecret, type DomainsConfig } from "./config";
export { validateHostname, normalizeHostname, classifyKind, isPlatformHost, subdomainSlug, hostFromHeader, type DomainKind } from "./hostname";
export { buildExpectedRecords, VERIFY_LABEL, type DnsRecord, type ExpectedRecords } from "./records";
export { checkDns, checkCaa, createPublicResolver, type DnsResolver, type DnsDiagnostics, type CaaRecord } from "./dns";
export * from "./edge";
export { evaluateDomain, httpProbe, defaultProbe, domainCheckToken, pendingBackoffMs, tlsBackoffMs, CHECK_PATH, type DomainStatusName, type DomainState, type LastCheck, type Outcome, type ProbeResult } from "./verify";
export {
  addDomain, listDomains, domainSetupInfo, removeDomain, removeDomainById, setPrimary, requestRecheck, forceRecheck,
  processDomainCheck, startVerification, domainCheckResponse, adminListDomains, adminDomainCounts, recheckLiveDomains, sweepStalledDomains, toView,
  type DomainView, type AdminDomainRow,
} from "./lifecycle";
export { resolveHost, storefrontCanonical, customDomainOrigin, platformSubdomainHost, invalidateStorefrontHosts, type ResolvedHost } from "./resolve";
export { classifyBot, classifyDevice, classifySource, pickTrafficParams, referrerHost, type BotMatch, type BotCategory, type Device, type TrafficSource, type TrafficParams } from "./classify";
export { recordHit, recordStorefrontEnquiry, flushTraffic, classifyHit, totalsFromHash, dayKey, normalizePath, isPageView, type HitInput, type HostKind, type DailyTotals } from "./metering";
export { getTrafficSummary, getTrafficSummaryForSeller, getMeteredRequests, type TrafficSummary, type TrafficPoint, type Breakdown } from "./queries";
export { worker } from "./worker";
