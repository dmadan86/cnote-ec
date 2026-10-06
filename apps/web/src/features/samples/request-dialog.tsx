"use client";
// "Request a sample" on the product page: a button that opens a native modal dialog (focus is trapped and Esc closes it by the platform)
// holding the request form. The page around it stays static; the form's server action signs the buyer in first if needed.
import { Button } from "@cnote/ui";
import { X } from "lucide-react";
import { useId, useRef } from "react";
import { RequestSampleForm } from "./forms";
import type { SampleLabels } from "./labels";

export function RequestSampleDialog({
  labels: l, listingId, title, offerLines, maxQty, defaultQty,
}: { labels: SampleLabels; listingId: string; title: string; offerLines: string[]; maxQty: number; defaultQty: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  return (
    <>
      <Button type="button" variant="outline" size="md" onClick={() => ref.current?.showModal()} data-testid="request-sample">
        {l.requestSample}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby={headingId}
        className="m-auto max-h-[90dvh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-card border border-line bg-surface p-0 text-ink backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 id={headingId} className="text-lg font-bold">{l.dialogTitle.replace("{title}", title)}</h2>
            <button type="button" onClick={() => ref.current?.close()} aria-label={l.dialogClose} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600">
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <ul className="flex flex-col gap-1 text-sm text-muted">{offerLines.map((o) => <li key={o}>{o}</li>)}</ul>
          <p className="text-xs text-muted">{l.signInNote}</p>
          <RequestSampleForm labels={l} listingId={listingId} maxQty={maxQty} defaultQty={defaultQty} idPrefix="pdp" />
        </div>
      </dialog>
    </>
  );
}
