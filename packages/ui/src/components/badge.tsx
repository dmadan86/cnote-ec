import { BadgeCheck, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "../cn";

const tones = {
  neutral: "bg-canvas text-muted border-line",
  brand: "bg-brand-50 text-brand-700 border-brand-100",
  accent: "bg-accent-50 text-accent-700 border-accent-100",
  success: "bg-green-50 text-success border-green-100",
  warning: "bg-amber-50 text-warning border-amber-100",
  danger: "bg-red-50 text-danger border-red-100",
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", tones[tone], className)}
      {...rest}
    />
  );
}

const TIER_LABEL = ["Phone verified", "GST verified", "KYC verified", "Audited"] as const;

/**
 * Verification badge. Reflects the real verification tier (ADR-003) — never payment or plan.
 * Renders nothing meaningful as "Verified" unless `badgeActive` (trust score above threshold).
 */
export function TrustBadge({ tier, badgeActive, className }: { tier: number; badgeActive: boolean; className?: string }) {
  if (!badgeActive || tier < 1) {
    return (
      <Badge tone="neutral" className={className} title="Not yet verified beyond phone">
        <ShieldQuestion className="size-3.5" aria-hidden /> Unverified
      </Badge>
    );
  }
  const Icon = tier >= 2 ? ShieldCheck : BadgeCheck;
  return (
    <Badge tone="accent" className={className} title={TIER_LABEL[Math.min(tier, 3)]}>
      <Icon className="size-3.5" aria-hidden /> {TIER_LABEL[Math.min(tier, 3)]}
    </Badge>
  );
}

/** Intent score 0–100 shown to sellers on every lead (ADR-002). */
export function IntentScore({ score, className }: { score: number; className?: string }) {
  const tone: BadgeTone = score >= 70 ? "success" : score >= 40 ? "warning" : "danger";
  return (
    <Badge tone={tone} className={className} title="Buyer intent score (0–100)">
      Intent {score}
    </Badge>
  );
}
