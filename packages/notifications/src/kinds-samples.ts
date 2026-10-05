// Sample workflow notification kinds (docs/design/samples.md). Each observes one Sample* domain event; every event carries both business ids, so
// recipients resolve without any lookup in the samples module. All are TRANSACTIONAL: they map onto the "leads" category (supplier side and
// buyer side alike), so per-category preferences apply and none needs marketing consent. Copy never names the counterparty's contact details.
// Seed copy: English written here, Hindi team-written below (staff edit the live text in the template studio). Other locales fall back to English.
import type { DomainEvent, DomainEventType } from "@cnote/core";
import { cleanName, fan, kind, membersOf, RECIPIENT_NAME, HREF, v } from "./kind-helpers";
import type { Directory } from "./recipients";
import type { NotificationApp, NotificationKind, Recipient } from "./types";

type Side = "buyer" | "seller";
const APP: Record<Side, NotificationApp> = { buyer: "web", seller: "seller" };
const href = (side: Side, id: string) => (side === "buyer" ? `/buyer/samples/${id}` : `/samples/${id}`);

interface Spec<E extends DomainEventType> {
  key: string;
  name: string;
  description: string;
  event: E;
  side: Side;
  variables?: ReturnType<typeof v>[];
  subject: string;
  body: string;
  hi: [subject: string, body: string];
  /** extra template variables for this event; return null to send nothing */
  vars?(e: DomainEvent<E>, dir: Directory): Promise<Record<string, unknown> | null>;
  /** event-specific gate */
  when?(e: DomainEvent<E>): boolean;
}

function mk<E extends DomainEventType>(s: Spec<E>): NotificationKind {
  const email = (greeting: string, body: string, cta: string) => `${greeting} {{recipientName}},\n\n${body}\n\n${cta}: {{href}}`;
  return kind<E>({
    key: s.key,
    name: s.name,
    description: s.description,
    category: "leads",
    app: APP[s.side],
    event: s.event,
    variables: [...(s.variables ?? []), RECIPIENT_NAME, HREF],
    defaults: { in_app: { subject: s.subject, body: s.body }, email: { subject: s.subject, body: email("Hi", s.body, "Open") } },
    localized: { hi: { in_app: { subject: s.hi[0], body: s.hi[1] }, email: { subject: s.hi[0], body: email("नमस्ते", s.hi[1], "खोलें") } } },
    async resolve(e: DomainEvent<E>, dir): Promise<Recipient[]> {
      if (s.when && !s.when(e)) return [];
      const p = e.payload as unknown as { sampleId: string; buyerBusinessId: string; sellerBusinessId: string };
      const extra = s.vars ? await s.vars(e, dir) : {};
      if (extra === null) return [];
      const businessId = s.side === "buyer" ? p.buyerBusinessId : p.sellerBusinessId;
      return fan(await membersOf(dir, businessId), { businessId, vars: extra, href: href(s.side, p.sampleId) });
    },
  });
}

const name = async (dir: Directory, businessId: string, fallback: string) => cleanName(await dir.businessName(businessId)) || fallback;

export const SAMPLE_KINDS: NotificationKind[] = [
  mk({
    key: "samples.requested", name: "New sample request", description: "A buyer asked a supplier for a sample (the supplier has 48 hours to answer).",
    event: "SampleRequested", side: "seller",
    variables: [v("buyer", "Buyer business name", "Asha Traders"), v("quantity", "Units asked for", "5"), v("hours", "Hours left to answer", "48")],
    subject: "New sample request", body: "{{buyer}} asked for {{quantity}} unit(s) as a sample. Please accept or decline within {{hours}} hours.",
    hi: ["नया सैंपल अनुरोध", "{{buyer}} ने सैंपल के रूप में {{quantity}} यूनिट मांगी हैं। कृपया {{hours}} घंटे के भीतर स्वीकार या अस्वीकार करें।"],
    vars: async (e, dir) => ({
      buyer: await name(dir, e.payload.buyerBusinessId, "A buyer"),
      quantity: e.payload.quantity,
      hours: Math.max(1, Math.round((new Date(e.payload.respondBy).getTime() - new Date(e.occurredAt).getTime()) / 3_600_000)),
    }),
  }),
  mk({
    key: "samples.accepted", name: "Sample request accepted", description: "The supplier agreed to send the sample.",
    event: "SampleAccepted", side: "buyer", variables: [v("supplier", "Supplier business name", "Sharma Packaging")],
    subject: "Your sample request was accepted", body: "{{supplier}} will send your sample. You will be told when it is dispatched.",
    hi: ["आपका सैंपल अनुरोध स्वीकार हुआ", "{{supplier}} आपका सैंपल भेजेगा। भेजे जाने पर आपको सूचना मिलेगी।"],
    vars: async (e, dir) => ({ supplier: await name(dir, e.payload.sellerBusinessId, "The supplier") }),
  }),
  mk({
    key: "samples.declined", name: "Sample request declined", description: "The supplier declined; the reason is on the request.",
    event: "SampleDeclined", side: "buyer", variables: [v("supplier", "Supplier business name", "Sharma Packaging")],
    subject: "Your sample request was declined", body: "{{supplier}} cannot send this sample. Open the request to see why, or ask another supplier.",
    hi: ["आपका सैंपल अनुरोध अस्वीकार हुआ", "{{supplier}} यह सैंपल नहीं भेज सकता। कारण देखने के लिए अनुरोध खोलें, या किसी और आपूर्तिकर्ता से पूछें।"],
    vars: async (e, dir) => ({ supplier: await name(dir, e.payload.sellerBusinessId, "The supplier") }),
  }),
  mk({
    key: "samples.dispatched", name: "Sample dispatched", description: "The supplier sent the sample.",
    event: "SampleDispatched", side: "buyer", variables: [v("courier", "Courier or carrier", "Delhivery"), v("tracking", "Tracking number (may be empty)", "DL123456")],
    subject: "Your sample is on its way", body: "Sent via {{courier}}. Tracking: {{tracking}}. Mark it received when it arrives, then tell us if it is what you need.",
    hi: ["आपका सैंपल रवाना हो गया", "{{courier}} से भेजा गया। ट्रैकिंग: {{tracking}}। पहुँचने पर 'मिल गया' चिह्नित करें, फिर बताएँ कि यह आपकी ज़रूरत के अनुसार है या नहीं।"],
    vars: async (e) => ({ courier: cleanName(e.payload.courier, 40), tracking: cleanName(e.payload.trackingRef, 40) || "-" }),
  }),
  mk({
    key: "samples.evaluate", name: "Evaluate your sample", description: "The sample arrived; the buyer is asked for a verdict.",
    event: "SampleDelivered", side: "buyer",
    subject: "Your sample arrived: is it what you need?", body: "Approve it or tell the supplier what is wrong, with photos if you like. An approved sample becomes the quality reference for your bulk order.",
    hi: ["आपका सैंपल पहुँच गया: क्या यह आपकी ज़रूरत के अनुसार है?", "इसे स्वीकृत करें या आपूर्तिकर्ता को बताएँ कि क्या गलत है, चाहें तो फ़ोटो के साथ। स्वीकृत सैंपल आपके थोक ऑर्डर का गुणवत्ता मानक बन जाता है।"],
  }),
  mk({
    key: "samples.received", name: "Sample received by the buyer", description: "The buyer confirmed the sample arrived.",
    event: "SampleDelivered", side: "seller", when: (e) => e.payload.deliveredBy === "buyer",
    subject: "Sample received", body: "The buyer confirmed your sample arrived. You will see their verdict here.",
    hi: ["सैंपल प्राप्त हुआ", "खरीदार ने पुष्टि की कि आपका सैंपल पहुँच गया। उनका निर्णय यहीं दिखेगा।"],
  }),
  mk({
    key: "samples.approved", name: "Sample approved", description: "The buyer approved the sample: it is now the quality reference for the bulk order.",
    event: "SampleEvaluated", side: "seller", when: (e) => e.payload.approved,
    subject: "Sample approved", body: "The buyer approved your sample. It is now their quality reference, so expect a bulk quote request.",
    hi: ["सैंपल स्वीकृत", "खरीदार ने आपका सैंपल स्वीकृत किया। अब यही उनका गुणवत्ता मानक है, इसलिए थोक कोटेशन अनुरोध की उम्मीद रखें।"],
  }),
  mk({
    key: "samples.rejected", name: "Sample rejected", description: "The buyer rejected the sample with structured reasons.",
    event: "SampleEvaluated", side: "seller", when: (e) => !e.payload.approved,
    subject: "Sample not approved", body: "The buyer did not approve your sample. Open the request to see their reasons and photos.",
    hi: ["सैंपल स्वीकृत नहीं हुआ", "खरीदार ने आपका सैंपल स्वीकृत नहीं किया। उनके कारण और फ़ोटो देखने के लिए अनुरोध खोलें।"],
  }),
  mk({
    key: "samples.expired_seller", name: "Sample request expired", description: "A request passed its response deadline without an answer.",
    event: "SampleExpired", side: "seller",
    subject: "A sample request expired", body: "You did not answer a sample request in time, so it expired. Missed requests lower your response record.",
    hi: ["एक सैंपल अनुरोध की अवधि समाप्त", "आपने समय पर सैंपल अनुरोध का उत्तर नहीं दिया, इसलिए वह समाप्त हो गया। छूटे अनुरोध आपके उत्तर-रिकॉर्ड को कम करते हैं।"],
  }),
  mk({
    key: "samples.expired_buyer", name: "Sample request expired (buyer)", description: "The supplier did not answer in time.",
    event: "SampleExpired", side: "buyer",
    subject: "Your sample request expired", body: "The supplier did not answer in time. You can ask another supplier for a sample.",
    hi: ["आपका सैंपल अनुरोध समाप्त हो गया", "आपूर्तिकर्ता ने समय पर उत्तर नहीं दिया। आप किसी और आपूर्तिकर्ता से सैंपल मांग सकते हैं।"],
  }),
  mk({
    key: "samples.cancelled", name: "Sample request cancelled", description: "The buyer withdrew a request.",
    event: "SampleCancelled", side: "seller",
    subject: "A sample request was cancelled", body: "The buyer cancelled their sample request. Nothing more to do.",
    hi: ["एक सैंपल अनुरोध रद्द हुआ", "खरीदार ने अपना सैंपल अनुरोध रद्द कर दिया। अब कुछ करने की आवश्यकता नहीं।"],
  }),
  mk({
    key: "samples.bulk_requested", name: "Bulk quote requested after a sample", description: "A buyer asked for a bulk quote that refers to an approved sample.",
    event: "SampleBulkQuoteRequested", side: "seller",
    subject: "Bulk quote request with an approved sample", body: "A buyer who approved your sample asked for a bulk quote. Bulk supply should match the approved sample.",
    hi: ["स्वीकृत सैंपल के साथ थोक कोटेशन अनुरोध", "जिस खरीदार ने आपका सैंपल स्वीकृत किया, उसने थोक कोटेशन मांगा है। थोक आपूर्ति स्वीकृत सैंपल जैसी होनी चाहिए।"],
  }),
];
