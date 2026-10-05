// Rate-contract kinds (docs/design/rate-contracts.md): proposals and amendments, answers, activation, call-offs, consumption warnings at
// 80% / 100%, and expiry reminders at 30 / 7 days. Same contract as kinds-payables.ts: each kind observes one domain event, resolves
// recipients per PERSON and carries English defaults with Hindi in `localized`; staff edit the live text in the template studio. All are
// TRANSACTIONAL ("messages"), so none needs marketing consent. Copy never names the counterparty (ADR-010). An expiry reminder never
// says the contract will renew: it asks the buyer to start a renewal, which both sides must accept again (ADR-005 spirit).
import type { DomainEvent } from "@cnote/core";
import { fan, inr, membersOf } from "./kind-helpers";
import { mk, niceDate } from "./kinds-payables";
import type { Directory } from "./recipients";
import type { NotificationApp, NotificationKind, Recipient } from "./types";
import { v } from "./kind-helpers";

type Side = "buyer" | "seller";
const APP: Record<Side, NotificationApp> = { buyer: "web", seller: "seller" };
const href = (side: Side, contractId: string) => (side === "buyer" ? `/buyer/contracts/${contractId}` : `/contracts/${contractId}`);

interface Parties { contractId: string; buyerBusinessId: string; sellerBusinessId: string }

async function to(dir: Directory, side: Side, p: Parties, vars: Record<string, unknown>, link = href(side, p.contractId)): Promise<Recipient[]> {
  const businessId = side === "buyer" ? p.buyerBusinessId : p.sellerBusinessId;
  return fan(await membersOf(dir, businessId), { businessId, app: APP[side], vars, href: link });
}
const both = async (dir: Directory, p: Parties, vars: Record<string, unknown>): Promise<Recipient[]> => [...(await to(dir, "buyer", p, vars)), ...(await to(dir, "seller", p, vars))];
/** The side that did NOT act. */
const otherThan = (p: Parties, actingBusinessId: string): Side => (actingBusinessId === p.buyerBusinessId ? "seller" : "buyer");

const NUMBER = v("contractNumber", "Rate contract number", "RC/26-27/000003");
const DATE = v("validTo", "Last day the contract is valid", "31 Mar 2027");

export const CONTRACT_KINDS: NotificationKind[] = [
  mk({
    key: "contract.proposed", name: "Rate contract proposed", description: "A buyer sent a rate contract for the supplier to accept, change or decline.",
    category: "messages", app: "seller", event: "RateContractProposed", variables: [NUMBER], cta: "Review the contract",
    subject: "Rate contract {{contractNumber}} proposed", body: "A buyer proposed rate contract {{contractNumber}}. Review the prices and dates, then accept, change or decline it.",
    hi: ["रेट कॉन्ट्रैक्ट {{contractNumber}} का प्रस्ताव", "एक खरीदार ने रेट कॉन्ट्रैक्ट {{contractNumber}} का प्रस्ताव भेजा है। कीमतें और तारीखें देखें, फिर स्वीकार करें, बदलाव सुझाएँ या अस्वीकार करें।"],
    resolve: async (e: DomainEvent<"RateContractProposed">, dir) => (e.payload.revision !== 1 ? [] : to(dir, otherThan(e.payload, e.payload.proposedByBusinessId), e.payload, { contractNumber: e.payload.number })),
  }),
  mk({
    key: "contract.amended", name: "Rate contract change proposed", description: "The other party proposed a new revision of a rate contract that you must accept before it applies.",
    category: "messages", app: "web", event: "RateContractProposed", variables: [NUMBER, v("revision", "Revision number", "2")], cta: "Review the change",
    subject: "Change proposed to rate contract {{contractNumber}}", body: "Revision {{revision}} of rate contract {{contractNumber}} is waiting for your answer. Until you accept it the current terms stay in force.",
    hi: ["रेट कॉन्ट्रैक्ट {{contractNumber}} में बदलाव का प्रस्ताव", "रेट कॉन्ट्रैक्ट {{contractNumber}} का संस्करण {{revision}} आपके उत्तर की प्रतीक्षा में है। आपके स्वीकार करने तक मौजूदा शर्तें लागू रहेंगी।"],
    resolve: async (e: DomainEvent<"RateContractProposed">, dir) => (e.payload.revision > 1
      ? to(dir, otherThan(e.payload, e.payload.proposedByBusinessId), e.payload, { contractNumber: e.payload.number, revision: e.payload.revision }) : []),
  }),
  mk({
    key: "contract.activated", name: "Rate contract in force", description: "Both parties accepted a revision of a rate contract; its prices now apply.",
    category: "messages", app: "web", event: "RateContractActivated", variables: [NUMBER, v("validFrom", "First day the contract is valid", "1 Apr 2026"), DATE], cta: "Open the contract",
    subject: "Rate contract {{contractNumber}} is in force", body: "Both sides accepted rate contract {{contractNumber}}. Its prices apply from {{validFrom}} to {{validTo}}.",
    hi: ["रेट कॉन्ट्रैक्ट {{contractNumber}} लागू", "दोनों पक्षों ने रेट कॉन्ट्रैक्ट {{contractNumber}} स्वीकार कर लिया। इसकी कीमतें {{validFrom}} से {{validTo}} तक लागू हैं।"],
    resolve: async (e: DomainEvent<"RateContractActivated">, dir) => both(dir, e.payload, { contractNumber: e.payload.number, validFrom: niceDate(e.payload.validFrom), validTo: niceDate(e.payload.validTo) }),
  }),
  mk({
    key: "contract.rejected", name: "Rate contract revision declined", description: "The other party declined a proposed revision of a rate contract.",
    category: "messages", app: "web", event: "RateContractRejected", variables: [NUMBER, v("reason", "The reason given", "Price too low")], cta: "Open the contract",
    subject: "Rate contract {{contractNumber}} declined", body: "Your proposed revision of rate contract {{contractNumber}} was declined. Reason: {{reason}}. You can propose a changed revision.",
    hi: ["रेट कॉन्ट्रैक्ट {{contractNumber}} अस्वीकृत", "रेट कॉन्ट्रैक्ट {{contractNumber}} का आपका प्रस्तावित संस्करण अस्वीकार कर दिया गया। कारण: {{reason}}। आप बदलाव के साथ नया संस्करण भेज सकते हैं।"],
    resolve: async (e: DomainEvent<"RateContractRejected">, dir) => {
      const reason = (e.payload.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "no reason given";
      return to(dir, otherThan(e.payload, e.payload.rejectedByBusinessId), e.payload, { contractNumber: e.payload.number, reason });
    },
  }),
  mk({
    key: "contract.terminated", name: "Rate contract ended", description: "The other party ended a rate contract; orders already placed are not affected.",
    category: "messages", app: "web", event: "RateContractTerminated", variables: [NUMBER], cta: "Open the contract",
    subject: "Rate contract {{contractNumber}} ended", body: "Rate contract {{contractNumber}} was ended by the other party. Orders already placed under it are not affected. Open the contract to see why.",
    hi: ["रेट कॉन्ट्रैक्ट {{contractNumber}} समाप्त", "रेट कॉन्ट्रैक्ट {{contractNumber}} को दूसरे पक्ष ने समाप्त कर दिया। इसके तहत दिए जा चुके ऑर्डर प्रभावित नहीं होंगे। कारण देखने के लिए कॉन्ट्रैक्ट खोलें।"],
    resolve: async (e: DomainEvent<"RateContractTerminated">, dir) => to(dir, otherThan(e.payload, e.payload.terminatedByBusinessId), e.payload, { contractNumber: e.payload.number }),
  }),
  mk({
    key: "contract.expired", name: "Rate contract expired", description: "A rate contract reached its end date. It does not renew by itself.",
    category: "messages", app: "web", event: "RateContractExpired", variables: [NUMBER, DATE], cta: "Open the contract",
    subject: "Rate contract {{contractNumber}} expired", body: "Rate contract {{contractNumber}} ended on {{validTo}} and does not renew by itself. The buyer can start a renewal, which both sides must accept.",
    hi: ["रेट कॉन्ट्रैक्ट {{contractNumber}} समाप्त हो गया", "रेट कॉन्ट्रैक्ट {{contractNumber}} {{validTo}} को समाप्त हुआ और अपने-आप नवीनीकृत नहीं होता। खरीदार नवीनीकरण शुरू कर सकता है, जिसे दोनों पक्षों को स्वीकार करना होगा।"],
    resolve: async (e: DomainEvent<"RateContractExpired">, dir) => both(dir, e.payload, { contractNumber: e.payload.number, validTo: niceDate(e.payload.validTo) }),
  }),
  mk({
    key: "contract.call_off", name: "Call-off order received", description: "A buyer placed an order against an active rate contract at the agreed prices.",
    category: "messages", app: "seller", event: "RateContractCallOffPlaced", variables: [NUMBER, v("callOffNo", "Call-off number within the contract", "3"), v("amount", "Order value before tax", "₹29,500")], cta: "Open the order",
    subject: "Call-off {{callOffNo}} on {{contractNumber}}", body: "A buyer placed call-off {{callOffNo}} of {{amount}} (before tax) on rate contract {{contractNumber}} at the agreed prices. Confirm the order and the purchase order.",
    hi: ["{{contractNumber}} पर कॉल-ऑफ {{callOffNo}}", "एक खरीदार ने रेट कॉन्ट्रैक्ट {{contractNumber}} पर तय कीमतों पर {{amount}} (कर से पहले) का कॉल-ऑफ {{callOffNo}} दिया है। ऑर्डर और क्रय आदेश की पुष्टि करें।"],
    resolve: async (e: DomainEvent<"RateContractCallOffPlaced">, dir) =>
      to(dir, "seller", e.payload, { contractNumber: e.payload.number, callOffNo: e.payload.callOffNo, amount: inr(e.payload.taxablePaise) }, `/orders/${e.payload.orderId}`),
  }),
  usage("contract.usage_80", 80, "80% of a rate contract limit used", "80% of {{what}} on rate contract {{contractNumber}} is used. Plan an amendment before the limit is reached.",
    ["रेट कॉन्ट्रैक्ट की 80% सीमा उपयोग हो चुकी", "रेट कॉन्ट्रैक्ट {{contractNumber}} पर {{what}} का 80% उपयोग हो चुका है। सीमा पूरी होने से पहले संशोधन की योजना बनाएँ।"]),
  usage("contract.usage_100", 100, "Rate contract limit reached", "The limit for {{what}} on rate contract {{contractNumber}} is fully used. Further call-offs for it are blocked until both sides accept an amendment.",
    ["रेट कॉन्ट्रैक्ट की सीमा पूरी हुई", "रेट कॉन्ट्रैक्ट {{contractNumber}} पर {{what}} की सीमा पूरी हो चुकी है। दोनों पक्षों के संशोधन स्वीकार करने तक इसके लिए और कॉल-ऑफ नहीं हो सकते।"]),
  expiry("contract.expiry_30", 30, "Rate contract {{contractNumber}} ends in 30 days", "Rate contract {{contractNumber}} ends on {{validTo}}. It will not renew by itself: the buyer can start a renewal, or the two sides can agree an extension.",
    ["रेट कॉन्ट्रैक्ट {{contractNumber}} 30 दिन में समाप्त", "रेट कॉन्ट्रैक्ट {{contractNumber}} {{validTo}} को समाप्त होगा। यह अपने-आप नवीनीकृत नहीं होगा: खरीदार नवीनीकरण शुरू कर सकता है, या दोनों पक्ष अवधि बढ़ाने पर सहमत हो सकते हैं।"]),
  expiry("contract.expiry_7", 7, "Rate contract {{contractNumber}} ends in 7 days", "Rate contract {{contractNumber}} ends on {{validTo}}, one week from now. After that no call-offs are possible unless both sides accept a renewal or extension.",
    ["रेट कॉन्ट्रैक्ट {{contractNumber}} 7 दिन में समाप्त", "रेट कॉन्ट्रैक्ट {{contractNumber}} {{validTo}} को, यानी एक सप्ताह में समाप्त होगा। इसके बाद कोई कॉल-ऑफ नहीं हो सकेगा, जब तक दोनों पक्ष नवीनीकरण या अवधि विस्तार स्वीकार न करें।"]),
];

function usage(key: string, threshold: 80 | 100, subject: string, body: string, hi: readonly [string, string]): NotificationKind {
  return mk({
    key, name: `Rate contract ${threshold}% used`, description: `Consumption of a quantity cap or the value cap of a rate contract reached ${threshold}%.`,
    category: "messages", app: "web", event: "RateContractConsumptionWarning", variables: [NUMBER, v("what", "What the limit is for", "Corrugated box 12x10")], cta: "Open the contract",
    subject, body, hi,
    resolve: async (e: DomainEvent<"RateContractConsumptionWarning">, dir) =>
      e.payload.threshold !== threshold ? [] : both(dir, e.payload, { contractNumber: e.payload.number, what: e.payload.scope === "value" ? "the total value" : (e.payload.itemDescription ?? "an item").slice(0, 120) }),
  });
}

function expiry(key: string, days: 30 | 7, subject: string, body: string, hi: readonly [string, string]): NotificationKind {
  return mk({
    key, name: `Rate contract ends in ${days} days`, description: `Reminder ${days} days before a rate contract ends. It never renews by itself.`,
    category: "messages", app: "web", event: "RateContractExpiryReminder", variables: [NUMBER, DATE], cta: "Open the contract",
    subject, body, hi,
    resolve: async (e: DomainEvent<"RateContractExpiryReminder">, dir) => (e.payload.daysLeft !== days ? [] : both(dir, e.payload, { contractNumber: e.payload.number, validTo: niceDate(e.payload.validTo) })),
  });
}
