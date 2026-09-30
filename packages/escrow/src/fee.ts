// Per-order escrow fee (ADR-012): 1-2% target, capped, charged to the SELLER at release, and only on escrowed orders.
// GST (18%) is charged on the fee and posted to gst_output. The buyer pays exactly the order value.
import { splitGst } from "@cnote/billing";
import { DomainError } from "@cnote/core";
import { feeBps as cfgBps, feeCapPaise as cfgCap, gstRateBps } from "./config";

export interface FeeBreakdown {
  /** Fee before GST, capped. */
  feePaise: number;
  gstPaise: number;
  /** What the seller receives: amount - fee - gst. */
  netPaise: number;
}

const whole = (n: number, what: string): void => {
  if (!Number.isSafeInteger(n) || n < 0) throw new DomainError("validation", `${what} must be a non-negative whole number of paise.`);
};

/** Fee on an amount, rounded half-up to the paisa and capped. */
export function computeFee(amountPaise: number, bps: number = cfgBps(), capPaise: number = cfgCap()): number {
  whole(amountPaise, "Amount");
  return Math.min(capPaise, Math.floor((amountPaise * bps + 5000) / 10_000));
}

export function feeBreakdown(amountPaise: number, opts: { bps?: number; capPaise?: number; gstBps?: number } = {}): FeeBreakdown {
  const feePaise = computeFee(amountPaise, opts.bps, opts.capPaise);
  const gstPaise = splitGst(feePaise, opts.gstBps ?? gstRateBps(), true).gstPaise;
  const netPaise = amountPaise - feePaise - gstPaise;
  if (netPaise < 0) throw new DomainError("validation", "Escrow fee exceeds the amount; check ESCROW_FEE_BPS.");
  return { feePaise, gstPaise, netPaise };
}
