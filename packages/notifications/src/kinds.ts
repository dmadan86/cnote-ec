// Observer registry: each NotificationKind observes one domain event (ADR-007 event log), resolves
// recipients (per PERSON) and carries default template content. Content is edited by staff in the
// DB (@cnote/templates); the defaults here only seed the first version and act as a last-resort
// fallback. Never build message strings in the sending path.
import type { DomainEvent, DomainEventType } from "@cnote/core";
import { BADGE_THRESHOLD } from "@cnote/identity";
import { defineTemplates, type TemplateDefinition } from "@cnote/templates";
import { cleanName, envInt, fan, HREF, inr, kind, membersOf, RECIPIENT_NAME, v } from "./kind-helpers";
import { ALERT_KINDS } from "./kinds-alerts";
import { DEVELOPER_KINDS } from "./kinds-developer";
import { DPDP_KINDS } from "./kinds-dpdp";
import { APPROVAL_KINDS } from "./kinds-approvals";
import { PAYABLE_KINDS } from "./kinds-payables";
import { PHASE23_KINDS } from "./kinds-phase23";
import type { NotificationCategory, NotificationKind } from "./types";

export const KINDS: NotificationKind[] = [
  kind({
    key: "lead.matched",
    name: "New lead matched",
    description: "A buyer requirement was matched exclusively to this seller (2h to respond).",
    category: "leads",
    app: "seller",
    event: "LeadMatched",
    variables: [v("enquiryTitle", "Buyer requirement title", "500 kg cotton yarn"), v("intentScore", "Buyer intent score, 0-100", "82"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "New lead: {{enquiryTitle}} — intent {{intentScore}}", body: "This lead is matched exclusively to you. Respond within 2 hours to accept it." },
      email: {
        subject: "New lead: {{enquiryTitle}}",
        body: "Hi {{recipientName}},\n\nYou have a new exclusive lead: {{enquiryTitle}} (intent score {{intentScore}}).\nRespond within 2 hours or it moves to the next seller.\n\nView the lead: {{href}}",
      },
    },
    async resolve(e: DomainEvent<"LeadMatched">, dir) {
      const [enq, people] = await Promise.all([dir.enquiry(e.payload.enquiryId), membersOf(dir, e.payload.sellerBusinessId)]);
      return fan(people, {
        businessId: e.payload.sellerBusinessId,
        vars: { enquiryTitle: enq?.title ?? "a new requirement", intentScore: enq?.intentScore ?? "n/a" },
        href: "/leads",
      });
    },
  }),
  kind({
    key: "lead.accepted",
    name: "Seller accepted your requirement",
    description: "A seller accepted the buyer's requirement and a conversation is open.",
    category: "leads",
    app: "web",
    event: "LeadAccepted",
    variables: [v("sellerName", "Accepting seller", "Sharma Textiles"), v("enquiryTitle", "Buyer requirement title", "500 kg cotton yarn"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "{{sellerName}} accepted your requirement", body: "{{sellerName}} can supply \"{{enquiryTitle}}\". Open the conversation to discuss details and get a quote." },
      email: {
        subject: "{{sellerName}} accepted your requirement",
        body: "Hi {{recipientName}},\n\n{{sellerName}} accepted your requirement \"{{enquiryTitle}}\".\n\nOpen the conversation: {{href}}",
      },
    },
    async resolve(e: DomainEvent<"LeadAccepted">, dir) {
      const [enq, sellerName] = await Promise.all([dir.enquiry(e.payload.enquiryId), dir.businessName(e.payload.sellerBusinessId)]);
      if (!enq) return [];
      return fan(await membersOf(dir, enq.buyerBusinessId), {
        businessId: enq.buyerBusinessId,
        vars: { sellerName: sellerName ?? "A seller", enquiryTitle: enq.title },
        href: `/buyer/enquiries/${e.payload.enquiryId}`,
      });
    },
  }),
  kind({
    key: "message.received",
    name: "New message",
    description: "The other party sent a message in a conversation.",
    category: "messages",
    app: "web",
    event: "MessageSent",
    variables: [v("senderName", "Business that sent the message", "Sharma Textiles"), v("enquiryTitle", "Requirement the conversation is about", "500 kg cotton yarn"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "New message from {{senderName}}", body: "About \"{{enquiryTitle}}\"." },
      email: { subject: "New message from {{senderName}}", body: "Hi {{recipientName}},\n\n{{senderName}} sent you a message about \"{{enquiryTitle}}\".\n\nRead and reply: {{href}}" },
    },
    // Security audit: one email per conversation per window, later messages fold into a digest; a daily cap per recipient.
    emailThrottle: () => ({ windowSeconds: envInt("NOTIFY_MESSAGE_EMAIL_WINDOW_SECONDS", 900), dailyCap: envInt("NOTIFY_MESSAGE_EMAIL_DAILY_CAP", 20), digestKind: "message.digest" }),
    async resolve(e: DomainEvent<"MessageSent">, dir) {
      const c = await dir.conversation(e.payload.conversationId);
      if (!c) return [];
      const sender = e.payload.senderPersonId;
      const sellerSide = await membersOf(dir, c.sellerBusinessId);
      // senderName is sender-controlled and lands in the email subject: sanitised (CR/LF stripped, length capped)
      if (sellerSide.includes(sender)) {
        const buyerSide = await membersOf(dir, c.buyerBusinessId);
        return fan(buyerSide.filter((p) => p !== sender), {
          businessId: c.buyerBusinessId, app: "web", group: e.payload.conversationId,
          vars: { senderName: cleanName(c.sellerName), enquiryTitle: cleanName(c.enquiryTitle, 120) }, href: `/conversations/${e.payload.conversationId}`,
        });
      }
      return fan(sellerSide.filter((p) => p !== sender), {
        businessId: c.sellerBusinessId, app: "seller", group: e.payload.conversationId,
        vars: { senderName: cleanName(c.buyerName), enquiryTitle: cleanName(c.enquiryTitle, 120) }, href: `/conversations/${e.payload.conversationId}`,
      });
    },
  }),
  kind({
    key: "message.digest",
    name: "New messages (digest)",
    description: "Several messages in one conversation folded into a single email (flood control). Sent by the pipeline, never by an event directly.",
    category: "messages",
    app: "web",
    event: "MessageSent",
    variables: [v("senderName", "Business that sent the messages", "Sharma Textiles"), v("enquiryTitle", "Requirement the conversation is about", "500 kg cotton yarn"), v("count", "Number of new messages folded in", "4"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "{{count}} new messages from {{senderName}}", body: "About \"{{enquiryTitle}}\"." },
      email: { subject: "{{count}} new messages from {{senderName}}", body: "Hi {{recipientName}},\n\n{{senderName}} sent you {{count}} more messages about \"{{enquiryTitle}}\".\n\nRead and reply: {{href}}" },
    },
    async resolve() {
      return [];
    },
  }),
  kind({
    key: "quote.received",
    name: "New quote",
    description: "A seller sent the buyer a quote.",
    category: "messages",
    app: "web",
    event: "QuoteSent",
    variables: [v("sellerName", "Quoting seller", "Sharma Textiles"), v("price", "Unit price", "₹120"), v("quantity", "Quantity quoted", "500"), v("enquiryTitle", "Requirement", "500 kg cotton yarn"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "{{sellerName}} sent you a quote", body: "{{price}} per unit for {{quantity}} units — \"{{enquiryTitle}}\"." },
      email: { subject: "{{sellerName}} sent you a quote", body: "Hi {{recipientName}},\n\n{{sellerName}} quoted {{price}} per unit for {{quantity}} units against \"{{enquiryTitle}}\".\n\nReview the quote: {{href}}" },
    },
    async resolve(e: DomainEvent<"QuoteSent">, dir) {
      const c = await dir.conversation(e.payload.conversationId);
      if (!c) return [];
      return fan(await membersOf(dir, c.buyerBusinessId), {
        businessId: c.buyerBusinessId,
        vars: { sellerName: c.sellerName, price: inr(e.payload.pricePaise), quantity: e.payload.quantity, enquiryTitle: c.enquiryTitle },
        href: `/conversations/${e.payload.conversationId}`,
      });
    },
  }),
  kind({
    key: "deal.confirm_requested",
    name: "Seller says the deal closed",
    description: "A seller reported the deal as won. Only the buyer's own answer records it, so the buyer is asked to confirm (security audit M7).",
    category: "leads",
    app: "web",
    event: "DealClaimedBySeller",
    variables: [v("sellerName", "Seller who reported the deal", "Sharma Textiles"), v("enquiryTitle", "Requirement", "500 kg cotton yarn"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "{{sellerName}} says your deal closed", body: "Did \"{{enquiryTitle}}\" close with {{sellerName}}? Please confirm or correct it." },
      email: { subject: "Did your deal with {{sellerName}} close?", body: "Hi {{recipientName}},\n\n{{sellerName}} says your deal for \"{{enquiryTitle}}\" closed. Nothing is recorded until you answer.\n\nConfirm or correct it: {{href}}" },
    },
    async resolve(e: DomainEvent<"DealClaimedBySeller">, dir) {
      if (!e.payload.conversationId) return [];
      const c = await dir.conversation(e.payload.conversationId);
      if (!c) return [];
      return fan(await membersOf(dir, e.payload.buyerBusinessId), {
        businessId: e.payload.buyerBusinessId,
        vars: { sellerName: c.sellerName, enquiryTitle: c.enquiryTitle },
        href: `/conversations/${e.payload.conversationId}`,
      });
    },
  }),
  kind({
    key: "enquiry.under_review",
    name: "Requirement under review",
    description: "The buyer's requirement was held for a quick human check before matching.",
    category: "leads",
    app: "web",
    event: "EnquiryScored",
    variables: [v("enquiryTitle", "Requirement", "500 kg cotton yarn"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your requirement is under review", body: "\"{{enquiryTitle}}\" is being checked by our team. We will send it to sellers as soon as it is cleared." },
      email: { subject: "Your requirement is under review", body: "Hi {{recipientName}},\n\nYour requirement \"{{enquiryTitle}}\" is being checked by our team. We will send it to sellers as soon as it is cleared.\n\nStatus: {{href}}" },
    },
    async resolve(e: DomainEvent<"EnquiryScored">, dir) {
      if (!e.payload.needsReview) return [];
      const enq = await dir.enquiry(e.payload.enquiryId);
      if (!enq) return [];
      return fan([enq.buyerPersonId], { businessId: enq.buyerBusinessId, vars: { enquiryTitle: enq.title }, href: `/buyer/enquiries/${e.payload.enquiryId}` });
    },
  }),
  kind({
    key: "listing.rejected",
    name: "Listing not approved",
    description: "A listing was rejected in moderation.",
    category: "listings",
    app: "seller",
    event: "ListingModerated",
    variables: [v("listingTitle", "Listing title", "Cotton yarn 40s"), v("reason", "Moderation reason", "Blurry photos"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Listing not approved: {{listingTitle}}", body: "Reason: {{reason}}. Edit the listing and resubmit." },
      email: { subject: "Your listing was not approved", body: "Hi {{recipientName}},\n\n\"{{listingTitle}}\" was not approved. Reason: {{reason}}.\n\nEdit and resubmit: {{href}}" },
    },
    async resolve(e: DomainEvent<"ListingModerated">, dir) {
      if (e.payload.status !== "rejected") return [];
      const [title, people] = await Promise.all([dir.listingTitle(e.payload.listingId), membersOf(dir, e.payload.sellerBusinessId)]);
      return fan(people, {
        businessId: e.payload.sellerBusinessId,
        vars: { listingTitle: title ?? "Your listing", reason: e.payload.reason ?? "See the listing for details" },
        href: `/listings/${e.payload.listingId}/edit`,
      });
    },
  }),
  kind({
    key: "listing.image_rejected",
    name: "Product image not approved",
    description: "A product image was rejected in moderation.",
    category: "listings",
    app: "seller",
    event: "ListingImageModerated",
    variables: [v("listingTitle", "Listing title", "Cotton yarn 40s"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "An image on {{listingTitle}} was not approved", body: "Upload a clearer image so buyers can see your product." },
      email: { subject: "A product image was not approved", body: "Hi {{recipientName}},\n\nAn image on \"{{listingTitle}}\" was not approved.\n\nUpdate images: {{href}}" },
    },
    async resolve(e: DomainEvent<"ListingImageModerated">, dir) {
      if (e.payload.status !== "rejected") return [];
      const [title, people] = await Promise.all([dir.listingTitle(e.payload.listingId), membersOf(dir, e.payload.sellerBusinessId)]);
      return fan(people, { businessId: e.payload.sellerBusinessId, vars: { listingTitle: title ?? "your listing" }, href: `/listings/${e.payload.listingId}/edit` });
    },
  }),
  kind({
    key: "domain.claim_superseded",
    name: "Domain claim ended",
    description: "A pending (not yet DNS-verified) custom-domain claim was dropped because another party verified the domain first, or it expired.",
    category: "listings",
    app: "seller",
    event: "DomainClaimSuperseded",
    variables: [v("hostname", "Domain name", "www.example.com"), v("reason", "Why the claim ended", "another party verified ownership first"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Domain claim ended: {{hostname}}", body: "Your pending claim on {{hostname}} ended because {{reason}}. If the domain is yours, add it again and publish the DNS records, or contact support." },
      email: { subject: "Your claim on {{hostname}} ended", body: "Hi {{recipientName}},\n\nYour pending claim on {{hostname}} ended because {{reason}}.\n\nIf the domain is yours, add it again and publish the DNS records, or contact support so we can help you prove ownership: {{href}}" },
    },
    async resolve(e: DomainEvent<"DomainClaimSuperseded">, dir) {
      const people = await membersOf(dir, e.payload.sellerBusinessId);
      return fan(people, {
        businessId: e.payload.sellerBusinessId,
        vars: { hostname: e.payload.hostname, reason: e.payload.reason === "expired" ? "it was not verified within the allowed time" : "another party verified ownership of the domain first" },
        href: "/storefront/domains",
      });
    },
  }),
  kind({
    key: "review.moderated",
    name: "Your review was reviewed",
    description: "Tells a review author whether their review was published.",
    category: "reviews",
    app: "web",
    event: "ReviewModerated",
    variables: [v("listingTitle", "Product", "Cotton yarn 40s"), v("outcome", "approved / not approved", "approved"), v("note", "Moderator's note (may be empty)", ""), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your review of {{listingTitle}} was {{outcome}}", body: "{{note}}" },
      email: { subject: "Your review was {{outcome}}", body: "Hi {{recipientName}},\n\nYour review of \"{{listingTitle}}\" was {{outcome}}. {{note}}\n\nSee it: {{href}}" },
    },
    async resolve(e: DomainEvent<"ReviewModerated">, dir) {
      const [r, title] = await Promise.all([dir.review(e.payload.reviewId), dir.listingTitle(e.payload.listingId)]);
      if (!r) return [];
      return fan([r.authorPersonId], {
        vars: { listingTitle: title ?? "the product", outcome: e.payload.status === "approved" ? "approved" : "not approved", note: r.moderationNote ?? "" },
        href: `/products/${e.payload.listingId}`,
      });
    },
  }),
  kind({
    key: "review.received",
    name: "New review on your product",
    description: "A buyer's review was approved and is now public.",
    category: "reviews",
    app: "seller",
    event: "ReviewModerated",
    variables: [v("listingTitle", "Product", "Cotton yarn 40s"), v("rating", "Stars out of 5", "4"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "New {{rating}}-star review on {{listingTitle}}", body: "Reply to it to show buyers you are responsive." },
      email: { subject: "New {{rating}}-star review on {{listingTitle}}", body: "Hi {{recipientName}},\n\n\"{{listingTitle}}\" received a {{rating}}-star review.\n\nRead and reply: {{href}}" },
    },
    async resolve(e: DomainEvent<"ReviewModerated">, dir) {
      if (e.payload.status !== "approved") return [];
      const [title, people] = await Promise.all([dir.listingTitle(e.payload.listingId), membersOf(dir, e.payload.sellerBusinessId)]);
      return fan(people, { businessId: e.payload.sellerBusinessId, vars: { listingTitle: title ?? "your product", rating: e.payload.rating }, href: "/reviews" });
    },
  }),
  kind({
    key: "comment.moderated",
    name: "Your question or reply was reviewed",
    description: "Tells a comment author whether it was published.",
    category: "reviews",
    app: "web",
    event: "CommentModerated",
    variables: [v("listingTitle", "Product", "Cotton yarn 40s"), v("outcome", "approved / not approved", "approved"), v("note", "Moderator's note (may be empty)", ""), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your comment on {{listingTitle}} was {{outcome}}", body: "{{note}}" },
      email: { subject: "Your comment was {{outcome}}", body: "Hi {{recipientName}},\n\nYour comment on \"{{listingTitle}}\" was {{outcome}}. {{note}}\n\nSee it: {{href}}" },
    },
    async resolve(e: DomainEvent<"CommentModerated">, dir) {
      const [c, title] = await Promise.all([dir.comment(e.payload.commentId), dir.listingTitle(e.payload.listingId)]);
      if (!c) return [];
      return fan([c.authorPersonId], {
        vars: { listingTitle: title ?? "the product", outcome: e.payload.status === "approved" ? "approved" : "not approved", note: c.moderationNote ?? "" },
        href: `/products/${e.payload.listingId}`,
      });
    },
  }),
  kind({
    key: "qa.question_asked",
    name: "New question on your product",
    description: "A buyer asked a question about one of the seller's products.",
    category: "reviews",
    app: "seller",
    event: "ProductQuestionAsked",
    variables: [v("listingTitle", "Product", "Cotton yarn 40s"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "New question about {{listingTitle}}", body: "Answer it to show buyers you are responsive. Your answer is public once approved." },
      email: { subject: "A buyer asked about {{listingTitle}}", body: "Hi {{recipientName}},\n\nA buyer asked a question about \"{{listingTitle}}\".\n\nAnswer it: {{href}}" },
    },
    async resolve(e: DomainEvent<"ProductQuestionAsked">, dir) {
      if (e.payload.status !== "approved") return []; // held for staff: the seller hears about it once it is approved
      const [title, people] = await Promise.all([dir.listingTitle(e.payload.listingId), membersOf(dir, e.payload.sellerBusinessId)]);
      return fan(people, { businessId: e.payload.sellerBusinessId, vars: { listingTitle: title ?? "your product" }, href: "/questions" });
    },
  }),
  kind({
    key: "qa.question_released",
    name: "A held question on your product was approved",
    description: "Staff approved a question that had been held for review, so the seller can now answer it.",
    category: "reviews",
    app: "seller",
    event: "ProductQaModerated",
    variables: [v("listingTitle", "Product", "Cotton yarn 40s"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "New question about {{listingTitle}}", body: "Answer it to show buyers you are responsive. Your answer is public once approved." },
      email: { subject: "A buyer asked about {{listingTitle}}", body: "Hi {{recipientName}},\n\nA buyer asked a question about \"{{listingTitle}}\".\n\nAnswer it: {{href}}" },
    },
    async resolve(e: DomainEvent<"ProductQaModerated">, dir) {
      if (e.payload.kind !== "question" || e.payload.status !== "approved") return [];
      const [title, people] = await Promise.all([dir.listingTitle(e.payload.listingId), membersOf(dir, e.payload.sellerBusinessId)]);
      return fan(people, { businessId: e.payload.sellerBusinessId, vars: { listingTitle: title ?? "your product" }, href: "/questions" });
    },
  }),
  kind({
    key: "qa.answered",
    name: "The seller answered your question",
    description: "Tells a buyer their product question was answered and is now public.",
    category: "reviews",
    app: "web",
    event: "ProductQuestionAnswered",
    variables: [v("listingTitle", "Product", "Cotton yarn 40s"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your question about {{listingTitle}} was answered", body: "See the seller's answer on the product page." },
      email: { subject: "Your question about {{listingTitle}} was answered", body: "Hi {{recipientName}},\n\nThe seller answered your question about \"{{listingTitle}}\".\n\nRead the answer: {{href}}" },
    },
    async resolve(e: DomainEvent<"ProductQuestionAnswered">, dir) {
      if (e.payload.status !== "approved") return []; // an answer held for staff is announced when it is approved
      const title = await dir.listingTitle(e.payload.listingId);
      return fan([e.payload.askerPersonId], { vars: { listingTitle: title ?? "the product" }, href: `/products/${e.payload.listingId}#questions` });
    },
  }),
  kind({
    key: "qa.answer_released",
    name: "A held answer to your question was approved",
    description: "Staff approved an answer that had been held for review, so the buyer's question is now answered.",
    category: "reviews",
    app: "web",
    event: "ProductQaModerated",
    variables: [v("listingTitle", "Product", "Cotton yarn 40s"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your question about {{listingTitle}} was answered", body: "See the seller's answer on the product page." },
      email: { subject: "Your question about {{listingTitle}} was answered", body: "Hi {{recipientName}},\n\nThe seller answered your question about \"{{listingTitle}}\".\n\nRead the answer: {{href}}" },
    },
    async resolve(e: DomainEvent<"ProductQaModerated">, dir) {
      if (e.payload.kind !== "answer" || e.payload.status !== "approved") return [];
      const title = await dir.listingTitle(e.payload.listingId);
      return fan([e.payload.askerPersonId], { vars: { listingTitle: title ?? "the product" }, href: `/products/${e.payload.listingId}#questions` });
    },
  }),
  kind({
    key: "billing.credits_granted",
    name: "Lead credits added",
    description: "Credits were added to the seller's balance.",
    category: "billing",
    app: "seller",
    event: "CreditsGranted",
    variables: [v("amount", "Credits granted", "10"), v("reason", "Why they were granted", "signup bonus"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "{{amount}} lead credits added", body: "Reason: {{reason}}." },
      email: { subject: "{{amount}} lead credits added", body: "Hi {{recipientName}},\n\n{{amount}} lead credits were added to your account ({{reason}}).\n\nBilling: {{href}}" },
    },
    async resolve(e: DomainEvent<"CreditsGranted">, dir) {
      return fan(await membersOf(dir, e.payload.businessId, { ownersOnly: true }), {
        businessId: e.payload.businessId, vars: { amount: e.payload.amount, reason: e.payload.reason.replaceAll("_", " ") }, href: "/billing",
      });
    },
  }),
  kind({
    key: "billing.subscription_started",
    name: "Subscription started",
    description: "A plan subscription started.",
    category: "billing",
    app: "seller",
    event: "SubscriptionStarted",
    variables: [v("planCode", "Plan code", "growth"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your {{planCode}} plan is active", body: "Manage your plan any time from Billing." },
      email: { subject: "Your {{planCode}} plan is active", body: "Hi {{recipientName}},\n\nYour {{planCode}} plan is now active.\n\nBilling: {{href}}" },
    },
    async resolve(e: DomainEvent<"SubscriptionStarted">, dir) {
      return fan(await membersOf(dir, e.payload.businessId, { ownersOnly: true }), { businessId: e.payload.businessId, vars: { planCode: e.payload.planCode }, href: "/billing" });
    },
  }),
  kind({
    key: "billing.subscription_cancelled",
    name: "Subscription ended after cancellation",
    description: "A cancelled plan reached the end of its paid period and moved to Free.",
    category: "billing",
    app: "seller",
    event: "SubscriptionCancelled",
    variables: [v("planCode", "Plan code", "growth"), v("refund", "Refund line, empty when nothing is refunded", "₹12,000 is being refunded to your original payment method."), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your {{planCode}} plan has ended", body: "{{refund}} Credits you already have stay spendable until their own expiry. You can subscribe again any time from Billing." },
      email: { subject: "Your {{planCode}} plan has ended", body: "Hi {{recipientName}},\n\nYour cancelled {{planCode}} plan has ended and you are on the Free plan. {{refund}}\nCredits you already have stay spendable until their own expiry.\n\nBilling: {{href}}" },
    },
    async resolve(e: DomainEvent<"SubscriptionCancelled">, dir) {
      const refund = e.payload.refundPaise > 0 ? `${inr(e.payload.refundPaise)} was refunded when you cancelled.` : "";
      return fan(await membersOf(dir, e.payload.businessId, { ownersOnly: true }), { businessId: e.payload.businessId, vars: { planCode: e.payload.planCode, refund }, href: "/billing" });
    },
  }),
  kind({
    key: "billing.refund_completed",
    name: "Refund completed",
    description: "The payment provider confirmed a refund (for example after cancelling an annual plan) is back with the payer.",
    category: "billing",
    app: "seller",
    event: "RefundCompleted",
    variables: [v("amount", "Refunded amount", "₹9,430.55"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your refund of {{amount}} is complete", body: "The payment provider confirmed it. It can take a few days to show on your statement." },
      email: { subject: "Your refund of {{amount}} is complete", body: "Hi {{recipientName}},\n\nYour refund of {{amount}} is complete. The payment provider confirmed it; it can take a few days to show on your statement.\n\nBilling: {{href}}" },
    },
    async resolve(e: DomainEvent<"RefundCompleted">, dir) {
      return fan(await membersOf(dir, e.payload.businessId, { ownersOnly: true }), { businessId: e.payload.businessId, vars: { amount: inr(e.payload.amountPaise) }, href: "/billing" });
    },
  }),
  kind({
    key: "billing.renewal_due",
    name: "Plan ending: confirm renewal",
    description: "A paid plan ends soon and will not renew by itself (ADR-005). Asks the owner to confirm a renewal; nothing is charged unless they do.",
    category: "billing",
    app: "seller",
    event: "SubscriptionRenewalDue",
    variables: [v("planCode", "Plan code", "growth"), v("endsOn", "Date the paid period ends", "12 Nov 2026"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your {{planCode}} plan ends on {{endsOn}}", body: "It will not renew automatically and you will not be charged. Confirm a renewal from Billing if you want to keep it." },
      email: {
        subject: "Your {{planCode}} plan ends on {{endsOn}}",
        body: "Hi {{recipientName}},\n\nYour {{planCode}} plan ends on {{endsOn}}. It will NOT renew automatically and we will not charge you unless you confirm.\n\nTo keep the plan, confirm the renewal here: {{href}}\nIf you do nothing, you move to the Free plan and keep any credits you already have until their expiry.",
      },
    },
    async resolve(e: DomainEvent<"SubscriptionRenewalDue">, dir) {
      const endsOn = new Date(e.payload.periodEnd).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
      const href = `/billing/checkout?plan=${encodeURIComponent(e.payload.planCode)}${e.payload.billingInterval === "annual" ? "&interval=annual" : ""}`;
      return fan(await membersOf(dir, e.payload.businessId, { ownersOnly: true }), { businessId: e.payload.businessId, vars: { planCode: e.payload.planCode, endsOn }, href });
    },
  }),
  kind({
    key: "business.verified",
    name: "Business verified",
    description: "A verification tier was passed.",
    category: "listings",
    app: "seller",
    event: "BusinessVerified",
    variables: [v("tier", "Verification tier reached", "1"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Verification tier {{tier}} reached", body: "Buyers now see your updated verification badge." },
      email: { subject: "Your business is verified (tier {{tier}})", body: "Hi {{recipientName}},\n\nYour business reached verification tier {{tier}}.\n\nDetails: {{href}}" },
    },
    async resolve(e: DomainEvent<"BusinessVerified">, dir) {
      return fan(await membersOf(dir, e.payload.businessId, { ownersOnly: true }), { businessId: e.payload.businessId, vars: { tier: e.payload.tier }, href: "/verification" });
    },
  }),
  kind({
    key: "trust.badge_revoked",
    name: "Verified badge removed",
    description: "The trust score dropped below the badge threshold.",
    category: "listings",
    app: "seller",
    event: "TrustScoreChanged",
    variables: [v("score", "New trust score", "58"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your verified badge was removed", body: "Your trust score dropped to {{score}}. Respond to leads quickly to earn it back." },
      email: { subject: "Your verified badge was removed", body: "Hi {{recipientName}},\n\nYour trust score dropped to {{score}}, so the verified badge was removed. Respond to leads quickly to earn it back.\n\nDetails: {{href}}" },
    },
    async resolve(e: DomainEvent<"TrustScoreChanged">, dir) {
      const { from, to, badgeActive } = e.payload;
      if (badgeActive || !(from >= BADGE_THRESHOLD && to < BADGE_THRESHOLD)) return [];
      return fan(await membersOf(dir, e.payload.businessId, { ownersOnly: true }), { businessId: e.payload.businessId, vars: { score: to }, href: "/verification" });
    },
  }),
  kind({
    key: "lead.reachability_result",
    name: "Buyer reachability check result",
    description: "Outcome of the automated check with a buyer the seller reported as unreachable (decided within 24h).",
    category: "leads",
    app: "seller",
    event: "ReachabilityChecked",
    variables: [v("outcome", "What happened and what it means for the credit", "The buyer confirmed they still need this."), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Buyer check complete", body: "{{outcome}}" },
    },
    async resolve(e: DomainEvent<"ReachabilityChecked">, dir) {
      const { sellerBusinessId, status, matchId } = e.payload;
      if (!sellerBusinessId || !matchId) return [];
      const outcome =
        status === "responded"
          ? "The buyer confirmed they still need this. No refund was issued; please contact them again."
          : "We could not reach the buyer, so your lead credit was refunded.";
      return fan(await membersOf(dir, sellerBusinessId), { businessId: sellerBusinessId, vars: { outcome }, href: "/leads" });
    },
  }),
  // ai_ops: attachment malware scanning
  kind({
    key: "attachment.quarantined",
    name: "Attachment blocked by security scan",
    description: "An RFQ or quote attachment the uploader sent was flagged by the malware scanner and quarantined; the requirement or quote was not created.",
    category: "messages",
    app: "web",
    event: "AttachmentQuarantined",
    variables: [v("uploadKind", "What was being sent: \"requirement\" or \"quote\"", "requirement"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "An attachment was blocked", body: "A file you tried to attach to your {{uploadKind}} failed our virus scan, so it was not sent. Scan the file on your device, remove it and try again." },
      email: { subject: "An attachment was blocked by our security scan", body: "Hi {{recipientName}},\n\nA file you tried to attach to your {{uploadKind}} failed our virus scan, so nothing was sent and the file was not shared with anyone. Please scan the file on your device, remove it and try again.\n\nTry again: {{href}}" },
    },
    async resolve(e: DomainEvent<"AttachmentQuarantined">) {
      const quote = e.payload.kind === "quote";
      return fan([e.payload.uploadedByPersonId], {
        businessId: e.payload.uploadedByBusinessId, app: quote ? "seller" : "web",
        vars: { uploadKind: quote ? "quote" : "requirement" }, href: quote ? "/conversations" : "/buyer/enquiries",
      });
    },
  }),
  ...PHASE23_KINDS,
  ...ALERT_KINDS,
  ...DEVELOPER_KINDS, // polish: API key expiry notices
  ...DPDP_KINDS, // polish: DPDP inactivity erasure notice + nominee change
  ...APPROVAL_KINDS,
  ...PAYABLE_KINDS,
];

const KEY_INDEX = new Map(KINDS.map((k) => [k.key, k]));
export const getKind = (key: string) => KEY_INDEX.get(key);
export const kindsFor = (event: DomainEventType) => KINDS.filter((k) => k.event === event);
export const observedEvents = (): DomainEventType[] => [...new Set(KINDS.map((k) => k.event))];

const templateCategory = (c: NotificationCategory): TemplateDefinition["category"] => (c === "security" ? "security" : c === "marketing" ? "marketing" : c === "alerts" ? "alert" : "transactional");

export function templateDefinitions(): TemplateDefinition[] {
  return KINDS.map((k) => ({
    key: k.key,
    name: k.name,
    description: k.description,
    category: templateCategory(k.category),
    channels: k.defaults.email ? ["in_app", "email"] : ["in_app"],
    variables: k.variables,
    defaults: { in_app: k.defaults.in_app, ...(k.defaults.email ? { email: k.defaults.email } : {}) },
    ...(k.localized ? { localized: k.localized } : {}),
  }));
}

let registered = false;
/** Register template keys with @cnote/templates (idempotent; called on module import and by the worker). */
export function registerNotificationTemplates(): void {
  if (registered) return;
  defineTemplates(templateDefinitions());
  registered = true;
}
