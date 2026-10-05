// DPDP notices to the data principal (packages/compliance): the 48-hour inactivity erasure notice (DPDP Rules 2025 r.8 / Third Schedule)
// and a security notice whenever a nominee is added, changed or revoked (DPDP s.14). Both use the "security" category (always delivered,
// no marketing consent, no unsubscribe footer): a legal notice must reach the person. Copy lives in the DB template (admin template studio);
// these defaults seed version 1 (en + hi). The nominee's details are never in the event, so never in a notification.
import type { DomainEvent } from "@cnote/core";
import { HREF, kind, RECIPIENT_NAME, v } from "./kind-helpers";
import type { NotificationKind } from "./types";

const email = (greeting: string, body: string, cta: string) => `${greeting} {{recipientName}},\n\n${body}\n\n${cta}: {{href}}`;
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

export const DPDP_KINDS: NotificationKind[] = [
  kind<"InactivityErasureNoticeSent">({
    key: "account.inactivity_erasure_notice",
    name: "Account will be erased for inactivity",
    description: "Sent at least 48 hours (default 7 days) before an inactive personal account is erased (DPDP Rules 2025). Signing in cancels it.",
    category: "security",
    app: "web",
    event: "InactivityErasureNoticeSent",
    variables: [v("eraseOn", "Date from which the account may be erased", "14 October 2026"), RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your account will be erased on {{eraseOn}}", body: "You have not used your account for a long time. Sign in before {{eraseOn}} to keep it; otherwise your personal data will be erased." },
      email: {
        subject: "Your account will be erased on {{eraseOn}} unless you sign in",
        body: email("Hi", "You have not signed in to your account for a long time. As required by data protection rules, we erase personal data that is no longer being used.\n\nYour account and the personal data in it will be erased on or after {{eraseOn}}. To keep it, simply sign in before then, or contact us. You do not need to do anything if you want it erased.", "Sign in to keep your account"),
      },
    },
    localized: {
      hi: {
        in_app: { subject: "आपका खाता {{eraseOn}} को मिटा दिया जाएगा", body: "आपने काफ़ी समय से अपना खाता इस्तेमाल नहीं किया है। उसे रखने के लिए {{eraseOn}} से पहले साइन इन करें; वरना आपका व्यक्तिगत डेटा मिटा दिया जाएगा।" },
        email: {
          subject: "साइन इन न करने पर आपका खाता {{eraseOn}} को मिटा दिया जाएगा",
          body: email("नमस्ते", "आपने काफ़ी समय से अपने खाते में साइन इन नहीं किया है। डेटा संरक्षण नियमों के अनुसार हम वह व्यक्तिगत डेटा मिटा देते हैं जिसका उपयोग नहीं हो रहा।\n\nआपका खाता और उसमें मौजूद व्यक्तिगत डेटा {{eraseOn}} को या उसके बाद मिटा दिया जाएगा। उसे रखने के लिए बस उससे पहले साइन इन करें या हमसे संपर्क करें। अगर आप चाहते हैं कि वह मिट जाए, तो आपको कुछ करने की ज़रूरत नहीं है।", "खाता रखने के लिए साइन इन करें"),
        },
      },
    },
    async resolve(e: DomainEvent<"InactivityErasureNoticeSent">) {
      return [{ personId: e.payload.personId, vars: { eraseOn: date(e.payload.eraseAfter) }, href: "/signin" }];
    },
  }),
  kind<"DataNomineeChanged">({
    key: "account.nominee_changed",
    name: "Nominee changed on your account",
    description: "A nominee (a person who may exercise your data rights if you die or cannot act) was added, changed or removed.",
    category: "security",
    app: "web",
    event: "DataNomineeChanged",
    variables: [RECIPIENT_NAME, HREF],
    defaults: {
      in_app: { subject: "Your nominee details changed", body: "A nominee on your account was added, changed or removed. If this was not you, change your password and contact our Grievance Officer." },
      email: {
        subject: "Your nominee details changed",
        body: email("Hi", "A nominee on your account (the person who may exercise your data rights if you die or cannot act) was added, changed or removed.\n\nIf this was not you, change your password now and contact our Grievance Officer.", "Review your nominees"),
      },
    },
    localized: {
      hi: {
        in_app: { subject: "आपके नामांकित व्यक्ति का विवरण बदला", body: "आपके खाते में एक नामांकित व्यक्ति जोड़ा, बदला या हटाया गया। अगर यह आपने नहीं किया, तो पासवर्ड बदलें और हमारे शिकायत अधिकारी से संपर्क करें।" },
        email: {
          subject: "आपके नामांकित व्यक्ति का विवरण बदला",
          body: email("नमस्ते", "आपके खाते में एक नामांकित व्यक्ति (जो आपकी मृत्यु या अक्षमता की स्थिति में आपके डेटा अधिकारों का प्रयोग कर सकता है) जोड़ा, बदला या हटाया गया।\n\nअगर यह आपने नहीं किया, तो अभी पासवर्ड बदलें और हमारे शिकायत अधिकारी से संपर्क करें।", "अपने नामांकित व्यक्ति देखें"),
        },
      },
    },
    async resolve(e: DomainEvent<"DataNomineeChanged">) {
      return [{ personId: e.payload.personId, vars: {}, href: "/account/nominee" }];
    },
  }),
];
