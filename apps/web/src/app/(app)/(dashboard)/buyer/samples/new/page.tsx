import { getPublicListing } from "@cnote/catalogue";
import { getConversation } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { getRequestLocale } from "@/lib/request-locale";
import { sampleConfig, samplesEnabled } from "@/lib/samples";
import { RequestSampleForm } from "@/features/samples/forms";
import { fill, sampleLabels } from "@/features/samples/labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("samples") };
}

const UUID = /^[0-9a-f-]{36}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Full-page request form: the sign-in return target of the product-page dialog, and the entry from a matched conversation / quote. */
export default async function NewSamplePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const listing = first(sp.listing);
  const conversation = first(sp.conversation);
  const quote = first(sp.quote);
  const qs = new URLSearchParams();
  if (listing) qs.set("listing", listing);
  if (conversation) qs.set("conversation", conversation);
  if (quote) qs.set("quote", quote);
  const s = await requireBusiness(`/buyer/samples/new${qs.size ? `?${qs}` : ""}`);
  const locale = await getRequestLocale();
  const l = await sampleLabels(locale);
  if (!samplesEnabled()) return <Container className="py-8"><Alert tone="info">{l.notAvailable}</Alert></Container>;

  let subject = "";
  let maxQty = sampleConfig().defaultMaxQty;
  if (listing && UUID.test(listing)) {
    const lv = await getPublicListing(listing);
    if (!lv || !lv.trade?.sampleAvailable) notFound();
    subject = lv.title;
    maxQty = lv.trade.sampleMaxQty ?? maxQty;
  } else if (conversation && UUID.test(conversation)) {
    const c = await getConversation(actorOf(s), conversation);
    if (!c || c.role !== "buyer") notFound();
    subject = c.enquiryTitle;
  } else notFound();

  return (
    <Container className="max-w-xl py-8">
      <PageHeader title={fill(l.dialogTitle, { title: subject })} description={l.intro} />
      <div className="mt-6">
        <RequestSampleForm
          labels={l}
          listingId={listing && UUID.test(listing) ? listing : undefined}
          conversationId={!listing && conversation && UUID.test(conversation) ? conversation : undefined}
          quoteId={quote && UUID.test(quote) ? quote : undefined}
          maxQty={maxQty}
          idPrefix="new"
        />
      </div>
    </Container>
  );
}
