"use client";
// Client islands for the gated high-intent CTAs. The surrounding page stays static; the dialog opens only on click.
// Signed-in buyers (verified phone) skip the dialog: the server action completes the unlock immediately.
import { buttonClasses, type ButtonVariant, type ButtonSize } from "@cnote/ui";
import { useUnlock } from "@cnote/next-kit/client";
import { getHumanToken, humanSlot } from "./human";
import type { Trigger, Unlock, UnlockResult } from "@cnote/leadgen";
import { useRouter } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import { captureAttribution, getVisitorId } from "./visitor";

const HEADINGS: Record<Unlock, (t: string) => string> = {
  enquiry: (t) => `Get the best price for ${t}`,
  seller_contact: (t) => `Contact the supplier of ${t}`,
  quotes: (t) => `Request a quote for ${t}`,
  save: () => "Verify your mobile number to save this",
  catalogue: () => "Verify your mobile number to download",
};

export interface UnlockButtonProps {
  trigger: Trigger;
  unlock: Unlock;
  listingId: string;
  listingTitle: string;
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  icon?: ReactNode;
}

export function UnlockButton({ trigger, unlock, listingId, listingTitle, label, variant = "accent", size = "lg", className, icon }: UnlockButtonProps) {
  const router = useRouter();
  const [vid, setVid] = useState("");
  const onUnlocked = useCallback((r: UnlockResult) => router.push(r.next), [router]);
  const { start, dialog, pending, error } = useUnlock({ visitorId: vid, onUnlocked, humanSlot, getHumanToken });
  return (
    <>
      <button
        type="button"
        className={buttonClasses(variant, size, className)}
        disabled={pending}
        aria-haspopup="dialog"
        onClick={() => {
          const visitorId = getVisitorId(); // read at click time: cookies are not available during static render
          setVid(visitorId);
          void start({ visitorId, trigger, unlock, listingId, attribution: captureAttribution() }, HEADINGS[unlock](listingTitle));
        }}
      >
        {icon}
        {label}
      </button>
      {error ? <p role="alert" className="w-full text-sm text-danger">{error}</p> : null}
      {dialog}
    </>
  );
}
