import { useTranslations } from "next-intl";
import type { ConsentPurpose } from "@cnote/identity";

/** Purposes shown as checkboxes; titles and bodies live in the `settings.consents.<key>` catalogue entries. */
export const CONSENT_COPY: { purpose: Exclude<ConsentPurpose, "voice_retention">; key: "matching" | "sharing" | "marketing" }[] = [
  { purpose: "matching", key: "matching" },
  { purpose: "counterparty_sharing", key: "sharing" },
  { purpose: "marketing", key: "marketing" },
];

/** Consent checkboxes. Nothing is pre-ticked unless the seller already granted it (DPDP: no pre-ticked consent). */
export function ConsentFields({ granted }: { granted: Partial<Record<ConsentPurpose, boolean>> }) {
  const t = useTranslations("settings.consents");
  return (
    <div className="space-y-3">
      {CONSENT_COPY.map((c) => (
        <label key={c.purpose} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-3">
          <input type="checkbox" name={c.purpose} defaultChecked={Boolean(granted[c.purpose])} className="mt-1 size-5 shrink-0 accent-brand-600" />
          <span>
            <span className="block text-sm font-medium text-ink">{t(`${c.key}.title`)}</span>
            <span className="block text-sm text-muted">{t(`${c.key}.body`)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
