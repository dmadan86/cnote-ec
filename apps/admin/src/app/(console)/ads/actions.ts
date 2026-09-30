"use server";
import { audited } from "@cnote/admin";
import {
  ADS_CONFIG_KEYS, decideCampaign, invalidateClicksByStaff, REASON_CODES, reviewItem, setAdsConfig, setKillSwitch, setRateCard, suspendCampaign, unsuspendCampaign,
  type AdsConfig,
} from "@cnote/ads";
import { creditTopUp } from "@cnote/billing";
import { DomainError, rupeesToPaise } from "@cnote/core";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

// Every mutation: staff session -> audited() checks the privilege, runs, and appends to AdminAuditLog.
//   ads.review (approve/reject), ads.suspend (kill switches), ads.fraud.review (invalid traffic), ads.settings (config + rate card),
//   billing.adjust (pilot wallet credit after a bank transfer).
const uuid = z.uuid();
const s = (fd: FormData, k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string).trim() : "");
const reason = z.enum(REASON_CODES);

function done(paths: string[]) {
  for (const p of paths) revalidatePath(p);
}

export async function reviewItemAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const campaignId = uuid.parse(s(fd, "campaignId"));
    const subjectId = uuid.parse(s(fd, "subjectId"));
    const type = z.enum(["listing", "keyword", "ad_group"]).parse(s(fd, "subjectType"));
    const decision = z.enum(["approved", "rejected"]).parse(s(fd, "decision"));
    const code = decision === "rejected" ? reason.parse(s(fd, "reasonCode")) : undefined;
    const ctx = await actionContext();
    await audited(ctx, "ads.review", "ads.review_item", { type: `ad_${type}`, id: subjectId }, () =>
      reviewItem({ campaignId, staffId: ctx.staff.id, subject: { type, id: subjectId }, decision, reasonCode: code, note: s(fd, "note") || undefined }),
    { campaignId, decision, reasonCode: code ?? null });
  });
  if (r.ok) done(["/ads/review", "/ads"]);
  return r;
}

export async function decideCampaignAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const campaignId = uuid.parse(s(fd, "campaignId"));
    const decision = z.enum(["approved", "rejected"]).parse(s(fd, "decision"));
    const code = decision === "rejected" ? reason.parse(s(fd, "reasonCode")) : undefined;
    const ctx = await actionContext();
    await audited(ctx, "ads.review", "ads.decide_campaign", { type: "ad_campaign", id: campaignId }, () =>
      decideCampaign({ campaignId, staffId: ctx.staff.id, decision, reasonCode: code, note: s(fd, "note") || undefined }),
    { decision, reasonCode: code ?? null });
  });
  if (r.ok) done(["/ads/review", `/ads/review/${s(fd, "campaignId")}`, "/ads/campaigns", "/ads"]);
  return r;
}

export async function suspendCampaignAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const id = uuid.parse(s(fd, "campaignId"));
    const why = z.string().trim().min(3, "Give a reason (the seller sees it).").max(300).parse(s(fd, "reason"));
    const ctx = await actionContext();
    await audited(ctx, "ads.suspend", "ads.suspend_campaign", { type: "ad_campaign", id }, () => suspendCampaign(id, ctx.staff.id, why), { reason: why });
  });
  if (r.ok) done(["/ads/campaigns", "/ads"]);
  return r;
}

export async function unsuspendCampaignAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const id = uuid.parse(s(fd, "campaignId"));
    const ctx = await actionContext();
    await audited(ctx, "ads.suspend", "ads.unsuspend_campaign", { type: "ad_campaign", id }, () => unsuspendCampaign(id, ctx.staff.id));
  });
  if (r.ok) done(["/ads/campaigns", "/ads"]);
  return r;
}

/** Global or per-surface kill switch: takes effect on the next request, no deploy. */
export async function killSwitchAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const scope = z.enum(["all", "search", "category", "product_similar"]).parse(s(fd, "scope"));
    const on = z.enum(["on", "off"]).parse(s(fd, "state")) === "on";
    const ctx = await actionContext();
    await audited(ctx, "ads.suspend", on ? "ads.kill_on" : "ads.kill_off", { type: "ads_kill_switch", id: scope }, () => setKillSwitch(scope, on), { scope, on });
  });
  if (r.ok) done(["/ads"]);
  return r;
}

export async function invalidateClicksAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ids = fd.getAll("clickId").filter((x): x is string => typeof x === "string").map((x) => uuid.parse(x));
    if (!ids.length) throw new DomainError("validation", "Select at least one click.");
    const why = z.string().trim().min(3, "Give a reason.").max(60).parse(s(fd, "reason") || "staff_review");
    const ctx = await actionContext();
    await audited(ctx, "ads.fraud.review", "ads.invalidate_clicks", { type: "ad_campaign", id: s(fd, "campaignId") }, () => invalidateClicksByStaff(ids, why.replace(/\s+/g, "_").toLowerCase()), { count: ids.length, reason: why });
  });
  if (r.ok) done(["/ads/traffic", `/ads/traffic/${s(fd, "campaignId")}`]);
  return r;
}

export async function setConfigAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const patch: Record<string, number> = {};
    for (const k of ADS_CONFIG_KEYS) {
      if (k === "botUserAgentPatterns") continue;
      const raw = s(fd, k);
      if (raw !== "") patch[k] = Number(raw);
    }
    const ctx = await actionContext();
    await audited(ctx, "ads.settings", "ads.set_config", { type: "ad_config", id: "ads" }, () => setAdsConfig(patch as Partial<AdsConfig>, ctx.staff.id), { patch });
  });
  if (r.ok) done(["/ads/settings", "/ads"]);
  return r;
}

export async function setRateCardAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const cat = s(fd, "categoryId");
    const cpc = z.coerce.number().positive("Enter the price per click in rupees.").parse(s(fd, "cpcRupees"));
    const max = s(fd, "maxCpcRupees");
    const from = s(fd, "effectiveFrom");
    const input = {
      categoryId: cat === "" ? null : cat,
      surface: z.enum(["search", "category", "product_similar"]).parse(s(fd, "surface")),
      cpcPaise: rupeesToPaise(cpc),
      maxCpcPaise: max ? rupeesToPaise(Number(max)) : null,
      ...(from ? { effectiveFrom: new Date(`${from}T00:00:00+05:30`) } : {}),
    };
    const ctx = await actionContext();
    await audited(ctx, "ads.settings", "ads.set_rate_card", { type: "ad_rate_card", id: `${input.categoryId ?? "default"}:${input.surface}` }, () => setRateCard(input, ctx.staff.id), { ...input, effectiveFrom: from || "now" });
  });
  if (r.ok) done(["/ads/settings"]);
  return r;
}

/** Pilot: finance credits the ad wallet after a bank transfer (design 5.8). Idempotent on the bank reference. */
export async function creditWalletAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const businessId = uuid.parse(s(fd, "businessId"));
    const rupees = z.coerce.number().positive("Enter the amount in rupees (ex-GST).").parse(s(fd, "rupees"));
    const ref = z.string().trim().min(3, "Enter the bank reference.").max(80).parse(s(fd, "bankRef"));
    const ctx = await actionContext();
    await audited(ctx, "billing.adjust", "ads.wallet_credit", { type: "business", id: businessId }, () => creditTopUp(businessId, rupeesToPaise(rupees), `manual:${ref}`), { rupees, bankRef: ref });
  });
  if (r.ok) done(["/ads/wallets"]);
  return r;
}
