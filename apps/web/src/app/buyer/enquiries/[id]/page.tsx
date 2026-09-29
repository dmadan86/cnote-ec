import { getBuyerEnquiry, listCandidatesForBuyer } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardTitle, Container, IntentScore, Money, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MatchedSellers } from "@/features/enquiry/matched-sellers";
import { PickSellersForm } from "@/features/enquiry/pick-sellers-form";
import { EnquiryStatusBadge } from "@/features/enquiry/status";

export const metadata: Metadata = { title: "Requirement" };

export default async function EnquiryDetailPage(props: PageProps<"/buyer/enquiries/[id]">) {
  const { id } = await props.params;
  const s = await requireBusiness(`/buyer/enquiries/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const e = await getBuyerEnquiry(s.business.id, id);
  if (!e) notFound();

  const cap = e.sellerCap ?? 3;
  const active = e.matches.filter((m) => m.status === "offered" || m.status === "accepted").length;
  const canPick = !!e.buyerPicks && ["scoring", "matched", "unmatched"].includes(e.status) && active < cap;
  const candidates = canPick ? await listCandidatesForBuyer(actorOf(s), e.id) : [];

  return (
    <Container className="max-w-4xl py-8">
      <PageHeader title={e.title} description={`Posted ${new Date(e.createdAt).toLocaleDateString("en-IN")}`} actions={<EnquiryStatusBadge enquiry={e} />} />

      <div className="mt-6 flex flex-col gap-6">
        {e.status === "review" ? <Alert tone="warning">This requirement is held for a quick human check. We will match sellers once it is approved.</Alert> : null}
        {e.status === "rejected" ? <Alert tone="danger">This requirement was not accepted, and any credits sellers spent on it have been returned.</Alert> : null}
        {e.status === "unmatched" && !canPick ? <Alert tone="warning">No sellers matched yet. Post again with more detail or a category.</Alert> : null}

        <Card>
          <CardBody className="flex flex-col gap-4">
            <p className="whitespace-pre-wrap text-sm text-ink">{e.requirement}</p>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {e.category ? <Row k="Category" v={e.category.name} /> : null}
              {e.quantity ? <Row k="Quantity" v={`${e.quantity} ${e.quantityUnit ?? ""}`} /> : null}
              {e.targetPricePaise ? <Row k="Target price" v={<Money paise={e.targetPricePaise} unit={e.quantityUnit} />} /> : null}
              {e.deliveryCity || e.deliveryPincode ? <Row k="Deliver to" v={[e.deliveryCity, e.deliveryPincode].filter(Boolean).join(" - ")} /> : null}
              {e.neededBy ? <Row k="Needed by" v={e.neededBy} /> : null}
            </dl>
          </CardBody>
        </Card>

        {e.intentScore !== null ? (
          <Card>
            <CardBody className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <CardTitle>Intent score</CardTitle>
                <IntentScore score={e.intentScore} />
              </div>
              {e.intentReasons.length ? (
                <ul className="list-disc pl-5 text-sm text-ink">
                  {e.intentReasons.map((r) => (<li key={r}>{r}</li>))}
                </ul>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {e.matches.length ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-ink">Sellers ({active} of {cap} active)</h2>
            <MatchedSellers matches={e.matches} />
          </section>
        ) : null}

        {canPick ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-ink">Pick your sellers</h2>
            <PickSellersForm enquiryId={e.id} candidates={candidates} max={cap - active} />
          </section>
        ) : null}
      </div>
    </Container>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-ink">{v}</dd>
    </div>
  );
}
