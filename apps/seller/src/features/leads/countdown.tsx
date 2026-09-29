"use client";
import { useSyncExternalStore } from "react";
import { Clock } from "lucide-react";
import { cn } from "@cnote/ui";

function subscribe(cb: () => void) {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
}
const nowSeconds = () => Math.floor(Date.now() / 1000);

function format(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Live countdown to `respondBy` (ADR-002: 2h window before the slot cascades to the next seller). */
export function Countdown({ respondBy }: { respondBy: string }) {
  const now = useSyncExternalStore(subscribe, nowSeconds, () => null);
  const target = Math.floor(new Date(respondBy).getTime() / 1000);
  const left = now === null ? null : target - now;
  const closed = left !== null && left <= 0;
  const urgent = left !== null && left > 0 && left < 15 * 60;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", closed ? "text-muted" : urgent ? "text-danger" : "text-ink")}>
      <Clock className="size-4" aria-hidden />
      {left === null ? (
        "Respond within 2 hours"
      ) : closed ? (
        "Response window closed"
      ) : (
        <>
          <span className="sr-only">Time left to respond: </span>
          <span className="tabular-nums">{format(left)}</span> left to respond
        </>
      )}
    </span>
  );
}
