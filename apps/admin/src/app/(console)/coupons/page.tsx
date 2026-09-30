import { hasPrivilege } from "@cnote/admin";
import { listCoupons, listRedemptions } from "@cnote/promotions";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, type BadgeTone } from "@cnote/ui";
import { Mono, Table, Td, Th } from "@/components/table";
import { CouponCreateForm, CouponRowActions, VoidRedemptionButton } from "@/features/promotions/review-forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Coupons" };
const TONE: Record<string, BadgeTone> = { draft: "neutral", active: "success", paused: "warning", expired: "neutral", exhausted: "neutral" };
const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default async function CouponsPage({ searchParams }: PageProps<"/coupons">) {
  const sp = await searchParams;
  const { staff } = await requireStaff("/coupons", "coupons.read");
  const canManage = hasPrivilege(staff, "coupons.manage");
  const coupons = await safe("coupons.list", () => listCoupons());
  const open = one(sp.open);
  const redemptions = open ? await safe("coupons.redemptions", () => listRedemptions(open)) : null;
  const value = (c: NonNullable<typeof coupons>[number]) => (c.kind === "percent" ? `${(c.percentBps ?? 0) / 100}%${c.maxDiscountPaise ? ` (max ${inr(c.maxDiscountPaise)})` : ""}` : c.kind === "extra_credits" ? `${c.extraCredits} credits` : inr(c.valuePaise ?? 0));
  return (
    <>
      <PageHeader title="Coupons" description="Codes for plans and credits. First billing period only, one per checkout, never stackable, one per business and GSTIN. Customers see one generic message for any invalid code." />
      {canManage ? (
        <Card><CardHeader><CardTitle>Create a coupon</CardTitle></CardHeader><CardBody><CouponCreateForm isSuperAdmin={staff.roles.includes("super_admin")} /></CardBody></Card>
      ) : null}
      {coupons === null ? <Alert tone="warning">Coupons are currently unavailable.</Alert> : coupons.length === 0 ? <EmptyState title="No coupons" description="Create one above." /> : (
        <Table>
          <thead><tr><Th>Code</Th><Th>Name</Th><Th>Value</Th><Th>Status</Th><Th>Used</Th><Th>Valid (IST)</Th><Th>Rules</Th><Th /></tr></thead>
          <tbody>{coupons.map((c) => (
            <tr key={c.id}>
              <Td><Mono>{c.code}</Mono></Td>
              <Td>{c.name}{c.requiresSecondApprover ? <Badge tone="warning" className="ml-2">2nd approver</Badge> : null}</Td>
              <Td>{c.kind.replace("_", " ")}: {value(c)}</Td>
              <Td><Badge tone={TONE[c.status] ?? "neutral"}>{c.status}</Badge></Td>
              <Td><a className="text-brand-700 hover:underline" href={`/coupons?open=${c.id}`}>{c.redeemedCount}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}</a></Td>
              <Td className="whitespace-nowrap text-xs">{fmtDate(c.validFrom)}<br />to {fmtDate(c.validTo)}</Td>
              <Td className="text-xs">{c.planCodes.length ? c.planCodes.join(", ") : "all paid plans"} · tier {c.minTier}+ · {c.perBusinessLimit}/business{c.firstPurchaseOnly ? " · first purchase" : ""}</Td>
              <Td>{canManage ? <CouponRowActions id={c.id} status={c.status} /> : null}</Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
      {open ? (
        <section aria-labelledby="red-h" className="space-y-3">
          <h2 id="red-h" className="text-sm font-semibold uppercase tracking-wide text-muted">Redemptions</h2>
          {redemptions === null ? <Alert tone="warning">Unavailable.</Alert> : redemptions.length === 0 ? <EmptyState title="No redemptions yet" description="Redemptions appear when a paid checkout uses the code." /> : (
            <Table>
              <thead><tr><Th>Business</Th><Th>Plan</Th><Th>Discount</Th><Th>Credits</Th><Th>Status</Th><Th>When</Th><Th /></tr></thead>
              <tbody>{redemptions.map((r) => (
                <tr key={r.id}><Td><Mono>{shortId(r.businessId)}</Mono></Td><Td>{r.planCode ?? "n/a"}</Td><Td>{inr(r.discountPaise)}</Td><Td>{r.creditsGranted}</Td><Td>{r.status}</Td><Td className="whitespace-nowrap text-xs">{fmtDate(r.createdAt)}</Td><Td>{canManage && r.status !== "voided" && r.creditsGranted === 0 ? <VoidRedemptionButton id={r.id} /> : null}</Td></tr>
              ))}</tbody>
            </Table>
          )}
        </section>
      ) : null}
    </>
  );
}
