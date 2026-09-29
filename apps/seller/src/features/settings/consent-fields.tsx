import type { ConsentPurpose } from "@cnote/identity";

export const CONSENT_COPY: { purpose: Exclude<ConsentPurpose, "voice_retention">; title: string; body: string }[] = [
  {
    purpose: "matching",
    title: "Match me to buyer leads",
    body: "We use your business details and listings to match you with buyer enquiries. Without this we cannot send you leads.",
  },
  {
    purpose: "counterparty_sharing",
    title: "Share my contact with matched buyers",
    body: "When you accept a lead, the buyer sees your business name, city and phone so you can talk. Without this you cannot accept leads.",
  },
  {
    purpose: "marketing",
    title: "Send me tips and offers (optional)",
    body: "Occasional product updates and selling tips. Not needed to use the service.",
  },
];

/** Consent checkboxes. Nothing is pre-ticked unless the seller already granted it (DPDP: no pre-ticked consent). */
export function ConsentFields({ granted }: { granted: Partial<Record<ConsentPurpose, boolean>> }) {
  return (
    <div className="space-y-3">
      {CONSENT_COPY.map((c) => (
        <label key={c.purpose} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-3">
          <input type="checkbox" name={c.purpose} defaultChecked={Boolean(granted[c.purpose])} className="mt-1 size-5 shrink-0 accent-brand-600" />
          <span>
            <span className="block text-sm font-medium text-ink">{c.title}</span>
            <span className="block text-sm text-muted">{c.body}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
