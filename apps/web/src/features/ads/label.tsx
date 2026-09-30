/** The ONE way an ad is labelled: visible text (never colour alone), neutral ink on white with a solid border, AA contrast, plus a screen-reader phrase. */
export function SponsoredLabel({ label, srLabel, className = "" }: { label: string; srLabel: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-md border border-ink bg-white px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ink ${className}`}>
      <span aria-hidden>{label}</span>
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}
