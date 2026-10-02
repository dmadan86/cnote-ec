"use client";

import { buttonClasses, cn } from "@cnote/ui";
import { ChevronDown, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { SITE_NAME } from "@/features/shell/site";
import { ConsentRecord } from "./consent-record";
import { CookieTable } from "./cookie-table";
import { CATEGORIES, type StorageCategory } from "./registry";
import { Switch } from "./switch";
import { REJECT_ALL, type ConsentChoices, type ConsentState } from "./state";

const FOOTER_BUTTON = buttonClasses("outline-brand", "md", "min-h-11 min-w-[7rem] flex-1");

/** One accordion category: expander button, "Always active" or a switch, and the cookie table when expanded. */
function CategoryRow({
  category,
  checked,
  onChange,
  gpcNote,
}: {
  category: StorageCategory;
  checked?: boolean;
  onChange?: (next: boolean) => void;
  gpcNote?: boolean;
}) {
  const t = useTranslations("consent");
  const [open, setOpen] = useState(false);
  const uid = useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  const noteId = `${uid}-gpc`;
  const panelId = `${uid}-panel`;
  const title = t(`${category}Title`);
  return (
    <section className="border-b border-line py-4 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-ink">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((v) => !v)}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              <ChevronDown aria-hidden="true" className={cn("size-5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
              <span id={titleId}>{title}</span>
            </button>
          </h3>
          <p id={descId} className="text-sm text-muted">
            {t(`${category}Desc`)}
          </p>
          {gpcNote ? (
            <p id={noteId} className="mt-2 text-sm font-medium text-ink">
              {t("gpcNote")}
            </p>
          ) : null}
        </div>
        <div className="flex min-h-11 shrink-0 items-center">
          {category === "necessary" ? (
            <span className="text-sm font-semibold text-ink">{t("alwaysActive")}</span>
          ) : (
            <Switch checked={!!checked} onChange={onChange ?? (() => undefined)} labelledBy={titleId} describedBy={gpcNote ? `${descId} ${noteId}` : descId} onLabel={t("on")} offLabel={t("off")} />
          )}
        </div>
      </div>
      <div id={panelId} hidden={!open} className="mt-3">
        {open ? <CookieTable category={category} label={title} /> : null}
      </div>
    </section>
  );
}

function DialogBody({
  initial,
  gpc,
  onAcceptAll,
  onRejectAll,
  onSave,
  onClose,
  headingRef,
}: {
  initial: ConsentState | null;
  gpc: boolean;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onSave: (choices: ConsentChoices) => void;
  onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const t = useTranslations("consent");
  // Nothing pre-ticked: with no stored choice both optional categories start off.
  const [draft, setDraft] = useState<ConsentChoices>(initial ? { analytics: initial.analytics, marketing: initial.marketing } : REJECT_ALL);
  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
        <h2 id="consent-dialog-title" ref={headingRef} tabIndex={-1} className="text-xl font-bold text-ink outline-none">
          {t("dialogTitle")}
        </h2>
        <button type="button" onClick={onClose} aria-label={t("close")} className="-mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6">
        <p className="text-sm text-muted">{t("dialogIntro", { site: SITE_NAME })}</p>
        <div className="mt-2">
          {CATEGORIES.map((c) =>
            c === "necessary" ? (
              <CategoryRow key={c} category={c} />
            ) : (
              <CategoryRow key={c} category={c} checked={draft[c]} onChange={(v) => setDraft((d) => ({ ...d, [c]: v }))} gpcNote={c === "marketing" && gpc} />
            ),
          )}
        </div>
        {initial ? <ConsentRecord className="mt-4 border-t border-line pt-4" /> : null}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line bg-surface px-4 py-3 sm:px-6">
        <button type="button" className={FOOTER_BUTTON} onClick={onAcceptAll}>
          {t("acceptAll")}
        </button>
        <button type="button" className={FOOTER_BUTTON} onClick={onRejectAll}>
          {t("rejectAll")}
        </button>
        <button type="button" className={FOOTER_BUTTON} onClick={() => onSave(draft)}>
          {t("saveChoices")}
        </button>
      </div>
    </>
  );
}

/**
 * Second layer: a native <dialog> opened with showModal() (focus trap, inert page, Esc closes, focus returns to the
 * opener via the browser plus the manager). The element stays mounted so the close/return works; its content only
 * mounts while open, so static pages ship no cookie table markup.
 */
export function PreferencesDialog({
  open,
  onClose,
  initial,
  gpc,
  onAcceptAll,
  onRejectAll,
  onSave,
}: {
  open: boolean;
  /** Called after the dialog closed for any reason (Esc, X, choice). */
  onClose: () => void;
  initial: ConsentState | null;
  gpc: boolean;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onSave: (choices: ConsentChoices) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      headingRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // Background must not scroll behind the modal.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.classList.add("overflow-hidden");
    return () => root.classList.remove("overflow-hidden");
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="consent-dialog-title"
      onClose={onClose}
      className="m-auto max-h-[92dvh] w-[calc(100vw-1rem)] max-w-2xl flex-col overflow-hidden rounded-card border border-line bg-surface p-0 text-ink shadow-xl open:flex backdrop:bg-black/50"
    >
      {open ? <DialogBody initial={initial} gpc={gpc} onAcceptAll={onAcceptAll} onRejectAll={onRejectAll} onSave={onSave} onClose={onClose} headingRef={headingRef} /> : null}
    </dialog>
  );
}
