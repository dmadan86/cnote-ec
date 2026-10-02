"use client";
// Contact options once a buyer has unlocked a supplier: Call, WhatsApp, Email and "Send enquiry".
// The surrounding page is static and renders `children` (the existing unlock button). After hydration, a SIGNED-IN buyer
// asks GET /api/contact/<listing> (private, no-store); only when the supplier has accepted their enquiry does the answer
// carry details, and only then does this island replace the unlock button. The number is never in static HTML.
import { buttonClasses } from "@cnote/ui";
import { Mail, MessageCircle, MessageSquare, Phone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type ReactNode } from "react";
import { LocaleLink as Link } from "@/i18n/link";
import { SITE_NAME } from "@/features/shell/site";
import { useUserState } from "@/features/user-state/store";
import { mailtoHref, telHref, whatsappHref } from "./links";

type Contact =
  | { unlocked: false }
  | { unlocked: true; sellerName: string; enquiryId: string; conversationId: string | null; phone: string | null; whatsapp: string | null; email: string | null };

type Channel = "call" | "whatsapp" | "email" | "enquiry";

function logChannel(listingId: string, channel: Channel) {
  // Metrics only (SupplierContacted); never blocks the action and never carries the number.
  void fetch(`/api/contact/${listingId}`, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel }),
  }).catch(() => undefined);
}

export function SupplierContact({ listingId, listingTitle, children }: { listingId: string; listingTitle: string; children: ReactNode }) {
  const t = useTranslations("convenience");
  const u = useUserState();
  const headingId = useId();
  // The answer is kept with the listing it belongs to; it is only used while signed in (no setState in the effect body).
  const [answer, setAnswer] = useState<{ listingId: string; contact: Contact } | null>(null);

  useEffect(() => {
    if (u.status !== "ready" || !u.signedIn) return;
    const ctl = new AbortController();
    fetch(`/api/contact/${listingId}`, { signal: ctl.signal, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<Contact>) : { unlocked: false as const }))
      .then((contact) => setAnswer({ listingId, contact }))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [listingId, u.status, u.signedIn]);

  const contact = u.signedIn && answer?.listingId === listingId ? answer.contact : null;
  if (!contact || !contact.unlocked) return <>{children}</>;

  const message = t("contact.whatsappMessage", { title: listingTitle, site: SITE_NAME });
  const tel = telHref(contact.phone);
  const wa = whatsappHref(contact.phone, message);
  const mail = mailtoHref(contact.email, t("contact.emailSubject", { title: listingTitle }), message);
  const chatHref = contact.conversationId ? `/conversations/${contact.conversationId}` : `/buyer/enquiries/${contact.enquiryId}`;
  const btn = buttonClasses("outline", "md", "min-h-11");

  return (
    <div role="group" aria-labelledby={headingId} className="flex w-full flex-col gap-2" data-testid="supplier-contact">
      <p id={headingId} className="text-sm font-semibold text-ink">
        {t("contact.heading", { seller: contact.sellerName })}
      </p>
      <ul className="flex flex-wrap gap-2">
        {tel ? (
          <li>
            <a href={tel} className={btn} onClick={() => logChannel(listingId, "call")}>
              <Phone className="size-4" aria-hidden /> {t("contact.call")}
              <span className="sr-only"> {t("contact.callSr", { seller: contact.sellerName })}</span>
            </a>
          </li>
        ) : null}
        {wa ? (
          <li>
            <a href={wa} target="_blank" rel="noopener noreferrer" className={btn} onClick={() => logChannel(listingId, "whatsapp")}>
              <MessageCircle className="size-4" aria-hidden /> {t("contact.whatsapp")}
              <span className="sr-only"> {t("contact.whatsappSr", { seller: contact.sellerName })}</span>
            </a>
          </li>
        ) : null}
        {mail ? (
          <li>
            <a href={mail} className={btn} onClick={() => logChannel(listingId, "email")}>
              <Mail className="size-4" aria-hidden /> {t("contact.email")}
              <span className="sr-only"> {t("contact.emailSr", { seller: contact.sellerName })}</span>
            </a>
          </li>
        ) : null}
        <li>
          <Link href={chatHref} className={buttonClasses("accent", "md", "min-h-11")} onClick={() => logChannel(listingId, "enquiry")}>
            <MessageSquare className="size-4" aria-hidden /> {t("contact.sendEnquiry")}
          </Link>
        </li>
      </ul>
      {!tel && !mail ? <p className="text-xs text-muted">{t("contact.noDirect", { seller: contact.sellerName })}</p> : null}
    </div>
  );
}
