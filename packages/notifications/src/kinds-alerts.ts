// Buyer retention alerts (docs/design/buyer-retention.md): price drop and back in stock on wishlist items, the followed-supplier
// digest and saved-search digests. All four observe BuyerAlertTriggered (emitted by @cnote/alerts only for people who opted in to
// that alert type), use the "alerts" category (per-channel preferences apply) and carry a one-click unsubscribe link.
// Copy is language-neutral where it can be: only the listing title / search name and numbers come from the event.
import type { DomainEvent } from "@cnote/core";
import { alertUnsubscribeUrl, getAlertSettings, type AlertType } from "@cnote/alerts";
import { HREF, inr, kind, RECIPIENT_NAME, v } from "./kind-helpers";
import type { NotificationKind } from "./types";

type Payload = DomainEvent<"BuyerAlertTriggered">["payload"];

const UNSUB = v("unsubscribeUrl", "One-click link that switches this alert type off", "https://example.com/unsubscribe/alerts?t=…");

function alertKind(o: {
  key: string; name: string; description: string; type: Payload["alertType"];
  variables: ReturnType<typeof v>[]; subject: string; body: string; hi: [string, string];
  vars: (p: Payload) => Record<string, unknown>;
}): NotificationKind {
  const email = (greeting: string, body: string, cta: string) => `${greeting} {{recipientName}},\n\n${body}\n\n${cta}: {{href}}`;
  return kind<"BuyerAlertTriggered">({
    key: o.key,
    name: o.name,
    description: o.description,
    category: "alerts",
    app: "web",
    event: "BuyerAlertTriggered",
    variables: [...o.variables, UNSUB, RECIPIENT_NAME, HREF],
    defaults: { in_app: { subject: o.subject, body: o.body }, email: { subject: o.subject, body: email("Hi", o.body, "See it here") } },
    localized: { hi: { in_app: { subject: o.hi[0], body: o.hi[1] }, email: { subject: o.hi[0], body: email("नमस्ते", o.hi[1], "यहाँ देखें") } } },
    async resolve(e: DomainEvent<"BuyerAlertTriggered">) {
      const p = e.payload;
      if (p.alertType !== o.type) return [];
      // an unsubscribe takes effect at once, even for alerts already queued
      if (p.alertType !== "saved_search") {
        const s = await getAlertSettings(p.personId);
        const on = p.alertType === "price_drop" ? s.priceDrop : p.alertType === "back_in_stock" ? s.backInStock : s.followedDigest;
        if (!on) return [];
      }
      return [{ personId: p.personId, vars: { ...o.vars(p), unsubscribeUrl: alertUnsubscribeUrl(p.personId, p.alertType as AlertType) }, href: p.href }];
    },
  });
}

const title = (p: Payload) => p.label.replace(/\s+/g, " ").trim().slice(0, 120);

export const ALERT_KINDS: NotificationKind[] = [
  alertKind({
    key: "alert.price_drop", name: "Price drop on a saved item", description: "A product on the buyer's wishlist got cheaper (opt-in).", type: "price_drop",
    variables: [v("label", "Product title", "Corrugated box 5-ply"), v("fromPrice", "Previous price", "₹120"), v("toPrice", "New price", "₹99")],
    subject: "Price drop: {{label}}", body: "{{label}} is now {{toPrice}}, down from {{fromPrice}}.",
    hi: ["कीमत घटी: {{label}}", "{{label}} अब {{toPrice}} का है, पहले {{fromPrice}} था।"],
    vars: (p) => ({ label: title(p), fromPrice: p.fromPricePaise === null ? "" : inr(p.fromPricePaise), toPrice: p.toPricePaise === null ? "" : inr(p.toPricePaise) }),
  }),
  alertKind({
    key: "alert.back_in_stock", name: "Saved item available again", description: "A saved product was published again (opt-in).", type: "back_in_stock",
    variables: [v("label", "Product title", "Corrugated box 5-ply")],
    subject: "Back in stock: {{label}}", body: "{{label}}, which you saved, is available again.",
    hi: ["फिर उपलब्ध: {{label}}", "आपके सहेजे गए {{label}} दोबारा उपलब्ध है।"],
    vars: (p) => ({ label: title(p) }),
  }),
  alertKind({
    key: "alert.followed_digest", name: "New from suppliers you follow", description: "Weekly digest of new listings from followed suppliers (opt-in).", type: "followed_digest",
    variables: [v("count", "Number of new listings", "3")],
    subject: "New from suppliers you follow", body: "{{count}} new listing(s) from suppliers you follow, in categories you care about.",
    hi: ["आपके फ़ॉलो किए सप्लायरों से नया", "आपके फ़ॉलो किए सप्लायरों की ओर से {{count}} नई लिस्टिंग।"],
    vars: (p) => ({ count: p.count }),
  }),
  alertKind({
    key: "alert.saved_search", name: "New matches for a saved search", description: "New listings matching a saved search (opt-in, daily or weekly).", type: "saved_search",
    variables: [v("label", "Saved search name", "cotton yarn"), v("count", "Number of new listings", "4")],
    subject: "New matches: {{label}}", body: "{{count}} new listing(s) match your saved search \"{{label}}\".",
    hi: ["नए नतीजे: {{label}}", "आपकी सहेजी गई खोज \"{{label}}\" से {{count}} नई लिस्टिंग मेल खाती हैं।"],
    vars: (p) => ({ label: title(p), count: p.count }),
  }),
];
