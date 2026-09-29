import type { CSSProperties } from "react";
import { FONTS, RADII, type Theme } from "../document/schema";
import { hexToRgb } from "../document/contrast";
import type { RenderData } from "./types";

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function themeVars(theme: Theme): CSSProperties {
  return {
    "--sf-primary": theme.primary,
    "--sf-on-primary": theme.onPrimary,
    "--sf-bg": theme.background,
    "--sf-surface": theme.surface,
    "--sf-text": theme.text,
    "--sf-muted": theme.muted,
    "--sf-accent": theme.accent,
    "--sf-line": rgba(theme.text, 0.16),
    "--sf-r": `${RADII[theme.radius]}px`,
    "--sf-font": FONTS[theme.font].stack,
  } as CSSProperties;
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
/** Paise → "₹1,250" / "₹5.20"; always paired with a unit by callers. */
export const formatRupees = (paise: number) => `₹${inr.format(paise / 100)}`;

/** Same tiers as @cnote/ui TrustBadge (DESIGN.md): the label reflects the real verification tier only. */
export function trustLabel(t: RenderData["trust"]): { label: string; verified: boolean } {
  if (!t.badgeActive || t.tier < 1) return { label: "Unverified", verified: false };
  return { label: (["Phone verified", "GST verified", "KYC verified", "Audited"] as const)[Math.min(t.tier, 3)]!, verified: true };
}

export const headingId = (sectionId: string) => `sf-h-${sectionId}`;
