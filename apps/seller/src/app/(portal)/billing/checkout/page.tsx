import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { billing } from "@/lib/services";
import { ConfirmPayForm } from "@/features/billing/checkout-forms";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("billing.checkout"))("metaTitle") };
}
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** Order summary before the hosted payment page: list price, coupon, GST split, "due today" (ADR-005 transparent pricing). */
export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const t = await getTranslations("billing.checkout");
  const plan = one(sp.plan);
  const pack = one(sp.pack);
  const interval = one(sp.interval) === "annual" ? "annual" : "monthly";
  const ta = await getTranslations("billingAnnual");
  const session = await requireSeller(plan ? `/billing/checkout?plan=${encodeURIComponent(plan)}${interval === "annual" ? "&interval=annual" : ""}` : pack ? `/billing/checkout?pack=${encodeURIComponent(pack)}` : "/billing");
  const coupon = one(sp.coupon)?.trim().toUpperCase() || undefined;
  if (!plan && !pack) notFound();
  const actor = { businessId: session.business.id };
  const q = await load(() => billing.quoteCheckout(actor, plan ? { purpose: "subscription", planCode: plan, couponCode: coupon, interval } : { purpose: "credit_pack", packId: pack!, couponCode: coupon }));
  // A bad coupon must not block the purchase: re-quote without it and show the reason.
  const base = q.ok || !coupon ? null : await load(() => billing.quoteCheckout(actor, plan ? { purpose: "subscription", planCode: plan, interval } : { purpose: "credit_pack", packId: pack! }));
  const quote = q.ok ? q.data : base?.ok ? base.data : null;
  const couponError = !q.ok && coupon ? q.error : null;
  if (!quote) return (
    <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{q.ok ? t("unavailable") : q.error}</Alert><Link href="/billing" className="text-sm text-brand-700 underline">{t("backToBilling")}</Link></div>
  );
  const applied = q.ok ? coupon : undefined;
  const intra = quote.igstPaise === 0;
  const row = (label: string, paise: number, strong = false) => (
    <div className={`flex items-center justify-between py-1.5 text-sm ${strong ? "border-t border-line pt-3 text-base font-bold text-ink" : "text-ink"}`}>
      <span>{label}</span><Money paise={paise} />
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <Card>
        <CardHeader><CardTitle>{quote.description}</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <div>
            {row(t("price"), quote.listPaise)}
            {quote.discountPaise > 0 ? row(t("coupon", { code: applied ?? "" }), -quote.discountPaise) : null}
            {intra ? (<>{row(t("cgst", { rate: quote.gstRateBps / 200 }), quote.cgstPaise)}{row(t("sgst", { rate: quote.gstRateBps / 200 }), quote.sgstPaise)}</>) : row(t("igst", { rate: quote.gstRateBps / 100 }), quote.igstPaise)}
            {row(t("dueToday"), quote.totalPaise, true)}
            {quote.creditsBonus > 0 ? <p className="text-xs text-success">{t("bonusCredits", { count: quote.creditsBonus })}</p> : null}
            {plan ? <p className="mt-2 text-xs text-muted">{interval === "annual" ? ta("intervalAnnual") : ta("intervalMonthly")}</p> : null}
            <p className="mt-2 text-xs text-muted">{t("placeOfSupply", { code: quote.placeOfSupply })}</p>
          </div>
          <form method="get" className="flex items-end gap-2">
            {plan ? <input type="hidden" name="plan" value={plan} /> : <input type="hidden" name="pack" value={pack} />}
            {plan && interval === "annual" ? <input type="hidden" name="interval" value="annual" /> : null}
            <label className="flex-1 text-xs text-muted">{t("discountCode")}
              <input name="coupon" defaultValue={applied ?? coupon} autoComplete="off" className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm uppercase" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-line px-4 text-sm font-semibold">{t("apply")}</button>
          </form>
          {couponError ? <Alert tone="warning">{couponError}</Alert> : null}
          <ConfirmPayForm planCode={plan} packId={pack} couponCode={applied} interval={interval} />
          <Link href="/billing" className="block text-center text-sm text-muted underline">{t("cancel")}</Link>
        </CardBody>
      </Card>
    </div>
  );
}
