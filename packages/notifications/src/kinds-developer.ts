// Developer API keys (packages/developer): the owner is emailed once when a key is 7 days from expiry and once more on the day it
// expires. Observes ApiKeyExpiring (emitted by the developer worker with an idempotent per-threshold marker). Copy lives in the DB
// template (editable in the admin template studio); these defaults only seed version 1 (en + hi). The secret is never in the event.
import type { DomainEvent } from "@cnote/core";
import { HREF, kind, RECIPIENT_NAME, v } from "./kind-helpers";
import type { NotificationKind } from "./types";

const VARS = [v("keyName", "Name the owner gave the key", "CI deploy"), v("keyPrefix", "Public key prefix", "ck_live_3fA9"), v("expiresOn", "Expiry date (UTC)", "12 Oct 2026"), RECIPIENT_NAME, HREF];

const expiresOn = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function keyKind(o: { key: string; name: string; threshold: "7d" | "expiry_day"; en: [string, string]; hi: [string, string] }): NotificationKind {
  const email = (greeting: string, body: string, cta: string) => `${greeting} {{recipientName}},\n\n${body}\n\n${cta}: {{href}}`;
  return kind<"ApiKeyExpiring">({
    key: o.key,
    name: o.name,
    description: o.threshold === "7d" ? "An API key expires within 7 days (sent once per key)." : "An API key expires within 24 hours (sent once per key).",
    category: "security",
    app: "web",
    event: "ApiKeyExpiring",
    variables: VARS,
    defaults: {
      in_app: { subject: o.en[0], body: o.en[1] },
      email: { subject: o.en[0], body: email("Hi", o.en[1], "Manage your API keys") },
    },
    localized: { hi: { in_app: { subject: o.hi[0], body: o.hi[1] }, email: { subject: o.hi[0], body: email("नमस्ते", o.hi[1], "अपनी API कुंजियाँ प्रबंधित करें") } } },
    async resolve(e: DomainEvent<"ApiKeyExpiring">) {
      const p = e.payload;
      if (p.threshold !== o.threshold) return [];
      return [{ personId: p.personId, vars: { keyName: p.name.replace(/\s+/g, " ").trim().slice(0, 80), keyPrefix: p.prefix, expiresOn: expiresOn(p.expiresAt) }, href: "/account/developers" }];
    },
  });
}

export const DEVELOPER_KINDS: NotificationKind[] = [
  keyKind({
    key: "developer.api_key_expiring", name: "API key expires soon", threshold: "7d",
    en: ["Your API key {{keyPrefix}} expires on {{expiresOn}}", "Your API key \"{{keyName}}\" ({{keyPrefix}}) expires on {{expiresOn}}. Create a replacement and update your integrations before then, or requests using it will start failing."],
    hi: ["आपकी API कुंजी {{keyPrefix}} {{expiresOn}} को समाप्त हो रही है", "आपकी API कुंजी \"{{keyName}}\" ({{keyPrefix}}) {{expiresOn}} को समाप्त हो रही है। उससे पहले नई कुंजी बनाकर अपने इंटीग्रेशन अपडेट करें, वरना इसके अनुरोध विफल होने लगेंगे।"],
  }),
  keyKind({
    key: "developer.api_key_expires_today", name: "API key expires today", threshold: "expiry_day",
    en: ["Your API key {{keyPrefix}} expires today", "Your API key \"{{keyName}}\" ({{keyPrefix}}) expires today ({{expiresOn}}). Requests using it will be rejected after that. Create a replacement now."],
    hi: ["आपकी API कुंजी {{keyPrefix}} आज समाप्त हो रही है", "आपकी API कुंजी \"{{keyName}}\" ({{keyPrefix}}) आज ({{expiresOn}}) समाप्त हो रही है। इसके बाद इसके अनुरोध अस्वीकार हो जाएँगे। अभी नई कुंजी बनाएँ।"],
  }),
];
