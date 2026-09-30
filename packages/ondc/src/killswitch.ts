// Per-environment kill switch (ADR-021): a DB toggle, so ops can suspend ONDC without a redeploy. While on, every inbound
// request is NACKed (503, retryable), nothing is published, and queued callbacks stay pending until the switch is released.
// Audit: the admin action wraps setKillSwitch() in audited() (AdminAuditLog); the row also stores who/why.
import { getJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import "./types";

export const KILL_KEY = "killswitch";
const CACHE_MS = 3000;
let cache: { at: number; killed: boolean } | null = null;

/** True while ONDC is suspended. Cached briefly (a few seconds) so hot paths stay cheap. A DB error propagates (the route answers a retryable 503). */
export async function isKilled(now: number = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < CACHE_MS) return cache.killed;
  const row = await prisma.ondcControl.findUnique({ where: { key: KILL_KEY }, select: { enabled: true } });
  cache = { at: now, killed: row?.enabled === true };
  return cache.killed;
}

export const resetKillSwitchCache = (): void => {
  cache = null;
};

export interface KillSwitchState { killed: boolean; note: string | null; updatedBy: string | null; updatedAt: string | null }

export async function getKillSwitch(): Promise<KillSwitchState> {
  const row = await prisma.ondcControl.findUnique({ where: { key: KILL_KEY } });
  return { killed: row?.enabled === true, note: row?.note ?? null, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt.toISOString() ?? null };
}

/** Engage or release the switch. Releasing re-queues callbacks and inbound requests parked while it was on. */
export async function setKillSwitch(killed: boolean, by: string, note?: string): Promise<KillSwitchState> {
  await prisma.ondcControl.upsert({
    where: { key: KILL_KEY },
    create: { key: KILL_KEY, enabled: killed, note: note?.slice(0, 500) ?? null, updatedBy: by },
    update: { enabled: killed, note: note?.slice(0, 500) ?? null, updatedBy: by },
  });
  resetKillSwitchCache();
  if (!killed) await resumePending();
  return getKillSwitch();
}

/** Re-enqueue outbound callbacks left pending and inbound requests left received while suspended. */
export async function resumePending(limit = 500): Promise<number> {
  const q = getJobQueue();
  const out = await prisma.ondcMessage.findMany({ where: { direction: "outbound", status: "pending" }, select: { id: true }, take: limit, orderBy: { createdAt: "asc" } });
  const inn = await prisma.ondcMessage.findMany({ where: { direction: "inbound", status: "received" }, select: { id: true }, take: limit, orderBy: { createdAt: "asc" } });
  for (const r of out) await q.enqueue("ondc.callback", { messageId: r.id });
  for (const r of inn) await q.enqueue("ondc.inbound", { messageId: r.id });
  return out.length + inn.length;
}

// ---- manual certification checklist items (admin-toggled, audited) ----
export const CERT_ITEMS = [
  { id: "legal_terms", label: "ONDC seller terms reviewed by legal" },
  { id: "b2b_domain_code", label: "B2B domain code and city codes confirmed with ONDC" },
  { id: "error_codes", label: "Error-code sheet reconciled" },
  { id: "search_logs", label: "Log-verification suite passed: search / on_search" },
  { id: "order_logs", label: "Log-verification suite passed: select, init, confirm, status, cancel" },
  { id: "fulfilment_logs", label: "Log-verification suite passed: unsolicited on_status fulfilment states" },
  { id: "igm_logs", label: "IGM log verification passed: issue, on_issue, issue_status, on_issue_status" },
  { id: "gateway_auth", label: "Gateway X-Gateway-Authorization verified against the ONDC staging gateway" },
  { id: "retention_registered", label: "OndcOrder / OndcIssue payload retention registered with compliance" },
  { id: "alerts", label: "Alerts on failed callbacks, dead-lettered ondc.* topics and overdue issues" },
] as const;
export type CertItemId = (typeof CERT_ITEMS)[number]["id"];

export async function getCertState(): Promise<Record<CertItemId, { done: boolean; note: string | null; updatedBy: string | null }>> {
  const rows = await prisma.ondcControl.findMany({ where: { key: { startsWith: "cert." } } });
  const by = new Map(rows.map((r) => [r.key, r]));
  return Object.fromEntries(CERT_ITEMS.map((i) => {
    const r = by.get(`cert.${i.id}`);
    return [i.id, { done: r?.enabled === true, note: r?.note ?? null, updatedBy: r?.updatedBy ?? null }];
  })) as Record<CertItemId, { done: boolean; note: string | null; updatedBy: string | null }>;
}

export async function setCertItem(id: CertItemId, done: boolean, by: string, note?: string): Promise<void> {
  if (!CERT_ITEMS.some((i) => i.id === id)) throw new Error("unknown certification item");
  await prisma.ondcControl.upsert({
    where: { key: `cert.${id}` },
    create: { key: `cert.${id}`, enabled: done, note: note?.slice(0, 500) ?? null, updatedBy: by },
    update: { enabled: done, note: note?.slice(0, 500) ?? null, updatedBy: by },
  });
}
