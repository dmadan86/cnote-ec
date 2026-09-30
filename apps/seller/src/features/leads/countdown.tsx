"use client";
import { useSyncExternalStore } from "react";
import { Clock } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@cnote/ui";

function subscribe(cb: () => void) {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
}
const nowSeconds = () => Math.floor(Date.now() / 1000);

type T = ReturnType<typeof useTranslations<"leads">>;

function format(total: number, t: T): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? t("hoursMinutes", { h, m: String(m).padStart(2, "0") }) : t("minutesSeconds", { m, s: String(s).padStart(2, "0") });
}

/** Live countdown to `respondBy` (ADR-002: 2h window before the slot cascades to the next seller). */
export function Countdown({ respondBy }: { respondBy: string }) {
  const t = useTranslations("leads");
  const now = useSyncExternalStore(subscribe, nowSeconds, () => null);
  const target = Math.floor(new Date(respondBy).getTime() / 1000);
  const left = now === null ? null : target - now;
  const closed = left !== null && left <= 0;
  const urgent = left !== null && left > 0 && left < 15 * 60;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", closed ? "text-muted" : urgent ? "text-danger" : "text-ink")}>
      <Clock className="size-4" aria-hidden />
      {left === null ? (
        t("respondWithin")
      ) : closed ? (
        t("windowClosed")
      ) : (
        <>
          <span className="sr-only">{t("timeLeftSr")}</span>
          {t.rich("timeLeft", { value: format(left, t), time: (c) => <span className="tabular-nums">{c}</span> })}
        </>
      )}
    </span>
  );
}
