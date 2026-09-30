"use client";
import { MapPin } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import { Button, Input } from "@cnote/ui";
import { Popover } from "./popover";
import { PINCODE_COOKIE } from "./site";

function writePincodeCookie(pin: string | null) {
  document.cookie = pin
    ? `${PINCODE_COOKIE}=${pin}; path=/; max-age=31536000; samesite=lax`
    : `${PINCODE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

const noopSubscribe = () => () => undefined;
function readCookiePin(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${PINCODE_COOKIE}=(\\d{6})`));
  return m ? m[1]! : null;
}

/** "Deliver to" picker. Stores a 6-digit pincode in a (non-httpOnly, non-sensitive) cookie. */
export function PincodePicker() {
  const t = useTranslations("shell");
  // The header is static/cached, so the pincode is read from the cookie on the client (null while hydrating).
  const cookiePin = useSyncExternalStore(noopSubscribe, readCookiePin, () => null);
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const initial = override === undefined ? cookiePin : override;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? initial ?? "";
  const setValue = (v: string) => setDraft(v);
  const [error, setError] = useState<string | null>(null);

  function save(pin: string | null, close: () => void) {
    if (pin !== null && !/^[1-9]\d{5}$/.test(pin)) {
      setError(t("pincodeInvalid"));
      return;
    }
    setError(null);
    writePincodeCookie(pin);
    setOverride(pin);
    setDraft(pin ? null : "");
    close();
  }

  return (
    <Popover
      align="right"
      chevron
      ariaLabel={t("pincodeAria", { pin: initial ?? t("india") })}
      buttonClassName="whitespace-nowrap text-left leading-tight"
      panelClassName="w-72 p-4"
      label={
        <span className="flex items-center gap-2">
          <MapPin className="size-4 text-brand-600" aria-hidden />
          <span className="flex flex-col text-[11px] leading-tight text-muted">
            {t("deliverTo")}
            <span className="text-sm font-semibold text-ink">{initial ?? t("india")}</span>
          </span>
        </span>
      }
    >
      {({ close }) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(value.trim() || null, close);
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="pincode-input" className="text-sm font-semibold text-ink">
            {t("pincodeLabel")}
          </label>
          <Input id="pincode-input" inputMode="numeric" autoComplete="postal-code" maxLength={6} placeholder={t("pincodePlaceholder")} value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} aria-invalid={error ? true : undefined} aria-describedby={error ? "pincode-error" : undefined} />
          {error ? (
            <p id="pincode-error" className="text-xs text-danger">
              {error}
            </p>
          ) : (
            <p className="text-xs text-muted">{t("pincodeHint")}</p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              {t("apply")}
            </Button>
            {initial ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => save(null, close)}>
                {t("clear")}
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </Popover>
  );
}
