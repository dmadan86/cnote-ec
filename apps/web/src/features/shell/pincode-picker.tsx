"use client";
import { MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@cnote/ui";
import { Popover } from "./popover";
import { PINCODE_COOKIE } from "./site";

function writePincodeCookie(pin: string | null) {
  document.cookie = pin
    ? `${PINCODE_COOKIE}=${pin}; path=/; max-age=31536000; samesite=lax`
    : `${PINCODE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** "Deliver to" picker. Stores a 6-digit pincode in a (non-httpOnly, non-sensitive) cookie. */
export function PincodePicker({ initial }: { initial: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);

  function save(pin: string | null, close: () => void) {
    if (pin !== null && !/^[1-9]\d{5}$/.test(pin)) {
      setError("Enter a valid 6-digit pincode.");
      return;
    }
    setError(null);
    writePincodeCookie(pin);
    if (!pin) setValue("");
    close();
    router.refresh();
  }

  return (
    <Popover
      align="right"
      chevron
      ariaLabel="Choose delivery pincode"
      buttonClassName="text-left leading-tight"
      panelClassName="w-72 p-4"
      label={
        <span className="flex items-center gap-2">
          <MapPin className="size-4 text-brand-600" aria-hidden />
          <span className="flex flex-col text-[11px] leading-tight text-muted">
            Deliver to
            <span className="text-sm font-semibold text-ink">{initial ?? "India"}</span>
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
            Delivery pincode
          </label>
          <Input id="pincode-input" inputMode="numeric" autoComplete="postal-code" maxLength={6} placeholder="e.g. 400069" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} aria-invalid={error ? true : undefined} aria-describedby={error ? "pincode-error" : undefined} />
          {error ? (
            <p id="pincode-error" className="text-xs text-danger">
              {error}
            </p>
          ) : (
            <p className="text-xs text-muted">We use this to show delivery options. It stays on your device.</p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Apply
            </Button>
            {initial ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => save(null, close)}>
                Clear
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </Popover>
  );
}
