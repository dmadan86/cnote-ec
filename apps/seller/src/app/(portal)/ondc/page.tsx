import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, buttonClasses, type BadgeTone } from "@cnote/ui";
import { getSellerState, isEnabled, listSellerListingOptIns, TERMS_VERSION, type IneligibleReason } from "@/lib/ondc";
import { requireSeller } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { ChannelForm, OptInButton } from "./forms";

export const metadata: Metadata = { title: "ONDC" };

const REASON: Record<IneligibleReason, string> = {
  not_opted_in: "Not added",
  not_published: "Not live yet: publish the listing first",
  not_approved: "Waiting for review",
  seller_unverified: "Complete verification to sell on ONDC",
  no_price: "Add a price to sell on ONDC",
};

export default async function OndcPage() {
  const session = await requireSeller("/ondc");
  const id = session.business.id;
  const [state, rows] = await Promise.all([load(() => getSellerState(id)), load(() => listSellerListingOptIns(id))]);
  const live = isEnabled();
  return (
    <div className="space-y-6">
      <PageHeader title="ONDC" description="Offer your products on the Open Network for Digital Commerce. You choose which listings to add, and every order comes to you to accept or reject." actions={<Link href="/ondc/orders" className={buttonClasses("outline", "md", "min-h-11")}>ONDC orders</Link>} />
      {!live ? <Alert tone="info">ONDC is not live yet. You can connect and choose listings now; nothing is shown to buyers on the network until we go live.</Alert> : null}
      {!state.ok ? <Alert tone="danger">{state.error}</Alert> : (
        <Card>
          <CardHeader><CardTitle>Channel</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <p className="flex items-center gap-2 text-sm">Status: <Badge tone={state.data.enabled ? "success" : "neutral"}>{state.data.enabled ? "Connected" : "Not connected"}</Badge></p>
            {state.data.enabled ? <p className="text-xs text-muted">Terms {state.data.termsVersion} accepted {state.data.acceptedAt ? formatDateTime(state.data.acceptedAt) : ""}. {state.data.publishedItems} listing(s) ready for the network.</p> : null}
            <ChannelForm connected={state.data.enabled} termsVersion={TERMS_VERSION} />
          </CardBody>
        </Card>
      )}
      <section aria-labelledby="ondc-listings" className="space-y-3">
        <h2 id="ondc-listings" className="text-lg font-semibold">Your listings</h2>
        {!rows.ok ? <Alert tone="danger">{rows.error}</Alert> : rows.data.length === 0 ? <EmptyState title="No listings yet" description="Create and publish a listing first, then add it to ONDC here." /> : (
          <ul className="grid gap-2">
            {rows.data.map((r) => {
              const tone: BadgeTone = r.optedIn && !r.reason ? "success" : r.optedIn ? "warning" : "neutral";
              return (
                <li key={r.listingId}>
                  <Card><CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">{r.title}</p>
                      <p className="mt-0.5"><Badge tone={tone}>{r.optedIn && !r.reason ? "Shown on ONDC" : r.reason ? REASON[r.reason] : "Not added"}</Badge></p>
                    </div>
                    <OptInButton listingId={r.listingId} optedIn={r.optedIn} />
                  </CardBody></Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
