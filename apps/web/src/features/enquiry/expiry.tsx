"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export interface Remaining {
  key: "timeDaysHours" | "timeHoursMinutes" | "timeMinutes";
  params: Record<string, number>;
}

/** Time left until `expiresAt` as a catalogue key + params, or null once it has passed. Pure, so it is unit-testable. */
export function remaining(expiresAt: string, now: number): Remaining | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (!(ms > 0)) return null;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  if (days >= 1) return { key: "timeDaysHours", params: { days, hours: Math.floor((minutes % 1440) / 60) } };
  if (minutes >= 60) return { key: "timeHoursMinutes", params: { hours: Math.floor(minutes / 60), minutes: minutes % 60 } };
  return { key: "timeMinutes", params: { minutes } };
}

/**
 * Live "Expires in 3d 4h" text. The server renders a first value; the client refreshes it every minute, so the text
 * node opts out of hydration warnings (the two clocks can differ by a minute). Colour is never the only signal: the
 * word "Expired" replaces the countdown when time is up.
 */
export function ExpiryCountdown({ expiresAt, className }: { expiresAt: string | null; className?: string }) {
  const t = useTranslations("rfq2.board");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!expiresAt) return <span className={className}>{t("noDeadline")}</span>;
  const r = remaining(expiresAt, now);
  if (!r) return <span className={className}>{t("expired")}</span>;
  return (
    <span className={className} suppressHydrationWarning>
      {t("expiresIn", { time: t(r.key, r.params) })}
    </span>
  );
}
