"use client";
// Soft nudge: an inline, dismissible banner (never a modal, never on first pageview or page load). Placed on the
// product page; opens the same unlock dialog only when the visitor clicks it. Desktop-only exit intent.
import { useUnlock } from "@cnote/next-kit/client";
import { getHumanToken, humanSlot } from "./human";
import type { UnlockResult } from "@cnote/leadgen";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUserState } from "@/features/user-state/store";
import { useUnlockLabels } from "./labels";
import { recordDismissed, recordShown, recordVisit, shouldNudge, type NudgeKind } from "./rules";
import { isNewSession, loadStore, saveStore, trackView } from "./store";
import { captureAttribution, getVisitorId } from "./visitor";

export function LeadNudge({ listingId, listingTitle }: { listingId: string; listingTitle: string }) {
  const u = useUserState();
  const router = useRouter();
  const t = useTranslations("leadgen");
  const labels = useUnlockLabels();
  const [kind, setKind] = useState<NudgeKind | null>(null);
  const [vid, setVid] = useState("");
  const views = useRef(0);
  const onUnlocked = useCallback((r: UnlockResult) => router.push(r.next), [router]);
  const { start, dialog } = useUnlock({ visitorId: vid, onUnlocked, humanSlot, getHumanToken, labels });

  const evaluate = useCallback(
    (k: NudgeKind) => {
      if (u.status !== "ready") return;
      const now = Date.now();
      const store = loadStore();
      const desktop = matchMedia("(hover: hover) and (pointer: fine) and (min-width: 1024px)").matches;
      if (!shouldNudge({ kind: k, now, store, signedIn: u.signedIn, desktop, viewsInSession: views.current })) return;
      saveStore(recordShown(store, now));
      setKind(k);
    },
    [u.signedIn, u.status],
  );

  useEffect(() => {
    captureAttribution();
    if (isNewSession()) saveStore(recordVisit(loadStore(), Date.now()));
    views.current = trackView(listingId);
  }, [listingId]);

  useEffect(() => {
    if (u.status !== "ready" || u.signedIn) return;
    // Never on the first pageview of a session: the view counter must already exceed 1 for any rule to pass.
    evaluate("product_views");
    evaluate("return_visit");
    const onLeave = (e: MouseEvent) => {
      if (e.clientY <= 0 && !e.relatedTarget) evaluate("exit_intent");
    };
    document.addEventListener("mouseout", onLeave);
    return () => document.removeEventListener("mouseout", onLeave);
  }, [u.status, u.signedIn, evaluate]);

  if (!kind) return dialog;
  const dismiss = () => {
    saveStore(recordDismissed(loadStore(), kind, Date.now()));
    setKind(null);
  };
  return (
    <>
      <section aria-label={t("nudgeAria")} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4 text-sm">
        <p className="min-w-0 flex-1">{t("nudgeText")}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="min-h-11 rounded-full bg-accent-700 px-4 font-semibold text-white hover:bg-accent-800"
            onClick={() => {
              const visitorId = getVisitorId();
              setVid(visitorId);
              void start({ visitorId, trigger: kind, unlock: "enquiry", listingId, attribution: captureAttribution() }, t("headingEnquiry", { title: listingTitle }));
            }}
          >
            {t("getBestPrice")}
          </button>
          <button type="button" className="min-h-11 px-3 text-muted hover:underline" onClick={dismiss}>
            {t("notNow")}
          </button>
        </div>
      </section>
      {dialog}
    </>
  );
}
