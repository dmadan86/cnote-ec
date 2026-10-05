// Buyer approval chains and team changes (docs/design/buyer-approvals.md). Recipients come straight from the event payloads
// (approvers are resolved by @cnote/approvals when the level opens, including active delegates), so this registry needs no lookups.
// Approvals use the "leads" category (requirements and quotes), team changes use "security" (always on). English defaults here;
// Hindi seed copy beside them; staff edit both in the template studio.
import type { DomainEvent } from "@cnote/core";
import { cleanName, fan, HREF, inr, kind, RECIPIENT_NAME, v } from "./kind-helpers";
import type { NotificationCategory, NotificationKind } from "./types";

const web = "web" as const;
const email = (greeting: string, body: string, cta: string) => `${greeting} {{recipientName}},\n\n${body}\n\n${cta}: {{href}}`;
const approvalHref = (requestId: string) => `/buyer/approvals/${requestId}`;
const summary = (s: string) => cleanName(s, 120);

interface Copy { subject: string; body: string }
function mk<E extends "ApprovalRequested" | "ApprovalApproved" | "ApprovalRejected" | "ApprovalReminder" | "BuyerMemberRoleChanged" | "BuyerMemberRemoved" | "BusinessOwnershipTransferred">(o: {
  key: string; name: string; description: string; category: NotificationCategory; event: E; variables: ReturnType<typeof v>[];
  en: Copy; hi: Copy; resolve: NotificationKind<E>["resolve"]; cta?: [string, string];
}): NotificationKind {
  const [ctaEn, ctaHi] = o.cta ?? ["Open it here", "यहाँ खोलें"];
  return kind<E>({
    key: o.key,
    name: o.name,
    description: o.description,
    category: o.category,
    app: web,
    event: o.event,
    variables: [...o.variables, RECIPIENT_NAME, HREF],
    defaults: { in_app: o.en, email: { subject: o.en.subject, body: email("Hi", o.en.body, ctaEn) } },
    localized: { hi: { in_app: o.hi, email: { subject: o.hi.subject, body: email("नमस्ते", o.hi.body, ctaHi) } } },
    resolve: o.resolve,
  });
}

type Requested = DomainEvent<"ApprovalRequested">["payload"];
type Closed = DomainEvent<"ApprovalRejected">["payload"];

const SUBJECT = v("subject", "What needs approval", "RFQ: 500 kg cotton yarn");
const AMOUNT = v("amount", "Amount, formatted", "₹1,50,000");
const LEVEL = v("level", "Approval level now open", "2");
const MEMBER_ROLE = v("role", "The member's role", "approver");

export const APPROVAL_KINDS: NotificationKind[] = [
  mk({
    key: "approval.requested", name: "Approval needed", description: "A level of an approval chain opened and this person can decide it.", category: "leads", event: "ApprovalRequested",
    variables: [SUBJECT, AMOUNT, LEVEL],
    en: { subject: "Approval needed: {{subject}}", body: "A team member asked for approval of {{subject}} ({{amount}}). It is waiting for your decision." },
    hi: { subject: "मंज़ूरी चाहिए: {{subject}}", body: "आपकी टीम के एक सदस्य ने {{subject}} ({{amount}}) की मंज़ूरी माँगी है। आपके फ़ैसले का इंतज़ार है।" },
    cta: ["Review and decide", "देखें और फ़ैसला करें"],
    async resolve(e: DomainEvent<"ApprovalRequested">) {
      const p: Requested = e.payload;
      return fan(p.approverPersonIds.filter((id) => id !== p.requesterPersonId), {
        businessId: p.businessId, app: web, vars: { subject: summary(p.subjectSummary), amount: inr(p.amountPaise), level: p.level }, href: approvalHref(p.requestId), group: p.requestId,
      });
    },
  }),
  mk({
    key: "approval.reminder", name: "Approval still waiting", description: "An approval has waited past its SLA for this approver.", category: "leads", event: "ApprovalReminder",
    variables: [SUBJECT, LEVEL],
    en: { subject: "Reminder: {{subject}} is waiting for you", body: "{{subject}} still needs your decision. The person who asked cannot proceed until you approve or reject it." },
    hi: { subject: "याद दिलाना: {{subject}} को आपका इंतज़ार है", body: "{{subject}} पर अब भी आपका फ़ैसला बाकी है। आप मंज़ूर या अस्वीकार करें, तब तक माँगने वाला आगे नहीं बढ़ सकता।" },
    cta: ["Review and decide", "देखें और फ़ैसला करें"],
    async resolve(e: DomainEvent<"ApprovalReminder">) {
      const p = e.payload;
      return fan(p.approverPersonIds, { businessId: p.businessId, app: web, vars: { subject: summary(p.subjectSummary), level: p.level }, href: approvalHref(p.requestId), group: p.requestId });
    },
  }),
  mk({
    key: "approval.approved", name: "Your request was approved", description: "The whole approval chain approved a request this person made.", category: "leads", event: "ApprovalApproved",
    variables: [SUBJECT, AMOUNT],
    en: { subject: "Approved: {{subject}}", body: "Your request for {{subject}} ({{amount}}) was approved and is going ahead." },
    hi: { subject: "मंज़ूर: {{subject}}", body: "{{subject}} ({{amount}}) के लिए आपका अनुरोध मंज़ूर हो गया है और आगे बढ़ रहा है।" },
    cta: ["See the details", "विवरण देखें"],
    async resolve(e: DomainEvent<"ApprovalApproved">) {
      const p = e.payload;
      return fan([p.requesterPersonId], { businessId: p.businessId, app: web, vars: { subject: summary(p.subjectSummary), amount: inr(p.amountPaise) }, href: approvalHref(p.requestId) });
    },
  }),
  mk({
    key: "approval.rejected", name: "Your request was rejected", description: "An approver rejected a request this person made.", category: "leads", event: "ApprovalRejected",
    variables: [SUBJECT, AMOUNT],
    en: { subject: "Rejected: {{subject}}", body: "Your request for {{subject}} ({{amount}}) was rejected. Open it to read the reason." },
    hi: { subject: "अस्वीकृत: {{subject}}", body: "{{subject}} ({{amount}}) के लिए आपका अनुरोध अस्वीकार कर दिया गया। कारण पढ़ने के लिए खोलें।" },
    cta: ["Read the reason", "कारण पढ़ें"],
    async resolve(e: DomainEvent<"ApprovalRejected">) {
      const p: Closed = e.payload;
      if (p.cause !== "rejected") return [];
      return fan([p.requesterPersonId], { businessId: p.businessId, app: web, vars: { subject: summary(p.subjectSummary), amount: inr(p.amountPaise) }, href: approvalHref(p.requestId) });
    },
  }),
  mk({
    key: "approval.expired", name: "Your request expired", description: "Nobody decided a request within the allowed days, so it was closed.", category: "leads", event: "ApprovalRejected",
    variables: [SUBJECT, AMOUNT],
    en: { subject: "Expired: {{subject}}", body: "Nobody decided {{subject}} ({{amount}}) in time, so the request was closed. You can ask again." },
    hi: { subject: "समय समाप्त: {{subject}}", body: "{{subject}} ({{amount}}) पर समय रहते किसी ने फ़ैसला नहीं किया, इसलिए अनुरोध बंद हो गया। आप दोबारा माँग सकते हैं।" },
    cta: ["See the details", "विवरण देखें"],
    async resolve(e: DomainEvent<"ApprovalRejected">) {
      const p: Closed = e.payload;
      if (p.cause !== "expired") return [];
      return fan([p.requesterPersonId], { businessId: p.businessId, app: web, vars: { subject: summary(p.subjectSummary), amount: inr(p.amountPaise) }, href: approvalHref(p.requestId) });
    },
  }),
  mk({
    key: "team.role_changed", name: "Your team role changed", description: "An owner or admin changed this person's role in a business.", category: "security", event: "BuyerMemberRoleChanged",
    variables: [MEMBER_ROLE],
    en: { subject: "Your role on the team changed", body: "Your role in your company's team is now: {{role}}." },
    hi: { subject: "टीम में आपकी भूमिका बदली", body: "आपकी कंपनी की टीम में आपकी भूमिका अब यह है: {{role}}।" },
    cta: ["See your team", "अपनी टीम देखें"],
    async resolve(e: DomainEvent<"BuyerMemberRoleChanged">) {
      const p = e.payload;
      if (p.personId === p.changedByPersonId) return [];
      return fan([p.personId], { businessId: p.businessId, app: web, vars: { role: p.to }, href: "/account/team" });
    },
  }),
  mk({
    key: "team.removed", name: "You were removed from a team", description: "An owner or admin removed this person from a business team.", category: "security", event: "BuyerMemberRemoved",
    variables: [],
    en: { subject: "You were removed from a company team", body: "You no longer have access to a company's buying team. If this is a mistake, contact the company's owner." },
    hi: { subject: "आपको कंपनी की टीम से हटा दिया गया", body: "अब आपके पास किसी कंपनी की खरीद टीम की पहुँच नहीं है। अगर यह गलती है तो कंपनी के मालिक से संपर्क करें।" },
    cta: ["Open your account", "अपना खाता खोलें"],
    async resolve(e: DomainEvent<"BuyerMemberRemoved">) {
      const p = e.payload;
      if (p.personId === p.removedByPersonId) return [];
      return fan([p.personId], { businessId: p.businessId, app: web, vars: {}, href: "/account" });
    },
  }),
  mk({
    key: "team.ownership_transferred", name: "You are now the owner", description: "Ownership of a business was transferred to this person.", category: "security", event: "BusinessOwnershipTransferred",
    variables: [],
    en: { subject: "You are now the owner of the company account", body: "Ownership of your company's account was transferred to you. You can now manage the team, approval rules and spend limits." },
    hi: { subject: "अब आप कंपनी खाते के मालिक हैं", body: "आपकी कंपनी के खाते का स्वामित्व आपको सौंप दिया गया है। अब आप टीम, मंज़ूरी के नियम और खर्च सीमाएँ सँभाल सकते हैं।" },
    cta: ["Open your team", "अपनी टीम खोलें"],
    async resolve(e: DomainEvent<"BusinessOwnershipTransferred">) {
      const p = e.payload;
      return fan([p.toPersonId], { businessId: p.businessId, app: web, vars: {}, href: "/account/team" });
    },
  }),
];
