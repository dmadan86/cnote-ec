"use client";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { PINCODE_COOKIE } from "@/features/shell/site";
import { stateFromPincode } from "./geo";

const noopSubscribe = () => () => undefined;
function readPin(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${PINCODE_COOKIE}=(\\d{6})`));
  return m ? m[1]! : null;
}

/**
 * Opt-in "Only suppliers who deliver to <pincode>". Never on by default and never applied silently: it is a checkbox whose
 * value is the pincode, submitted with the rest of the filters (`deliver=560001` in the URL, shown as a removable chip), so a
 * link fully determines the results. The pincode offered comes from the "Deliver to" cookie, read on the client because these
 * pages are cached and shared; once applied, the pincode in the URL wins. We have no delivery-area data, so the filter matches
 * suppliers located in the pincode's state, and says so.
 */
export function DeliverToggle({ id, current }: { id: string; /** pincode already applied via the URL, or null */ current: string | null }) {
  const t = useTranslations("filters");
  const cookiePin = useSyncExternalStore(noopSubscribe, readPin, () => null);
  const pin = current ?? cookiePin;
  const state = stateFromPincode(pin);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex min-h-11 items-start gap-2.5 py-1 text-sm text-ink lg:min-h-8">
        <input id={id} type="checkbox" name="deliver" value={pin ?? ""} defaultChecked={current !== null} disabled={!pin} aria-describedby={`${id}-note`} className="mt-0.5 size-4 shrink-0 accent-brand-600" />
        <span>{pin ? t("deliverLabel", { pincode: pin }) : t("deliverLabelAny")}</span>
      </label>
      <p id={`${id}-note`} className="pl-6 text-xs text-muted">
        {!pin ? t("deliverNeedsPin") : state ? t("deliverNote", { state }) : t("deliverNoState", { pincode: pin })}
      </p>
    </div>
  );
}
