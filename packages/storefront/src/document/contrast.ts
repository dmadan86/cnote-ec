// WCAG 2.x contrast maths (pure, client-safe). The theme validator uses this so a storefront can never
// ship text a buyer cannot read (WCAG 1.4.3 needs 4.5:1 for body text).

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two #rrggbb colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const AA_TEXT = 4.5;
export const AA_UI = 3;

export interface ThemeColors {
  primary: string;
  onPrimary: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
}

export interface ContrastIssue {
  path: string;
  message: string;
  ratio: number;
  required: number;
}

/** Every foreground/background pair the renderer can produce. Empty array = the theme is AA-safe. */
export function themeContrastIssues(t: ThemeColors): ContrastIssue[] {
  const pairs: { path: keyof ThemeColors; fg: string; bg: string; bgLabel: string; required: number; what: string }[] = [
    { path: "text", fg: t.text, bg: t.background, bgLabel: "background", required: AA_TEXT, what: "Text" },
    { path: "text", fg: t.text, bg: t.surface, bgLabel: "surface", required: AA_TEXT, what: "Text" },
    { path: "muted", fg: t.muted, bg: t.background, bgLabel: "background", required: AA_TEXT, what: "Secondary text" },
    { path: "muted", fg: t.muted, bg: t.surface, bgLabel: "surface", required: AA_TEXT, what: "Secondary text" },
    { path: "primary", fg: t.primary, bg: t.background, bgLabel: "background", required: AA_TEXT, what: "Brand colour (links)" },
    { path: "primary", fg: t.primary, bg: t.surface, bgLabel: "surface", required: AA_TEXT, what: "Brand colour (links)" },
    { path: "onPrimary", fg: t.onPrimary, bg: t.primary, bgLabel: "brand colour", required: AA_TEXT, what: "Button text" },
    { path: "accent", fg: t.accent, bg: t.background, bgLabel: "background", required: AA_UI, what: "Accent (borders, icons)" },
  ];
  const out: ContrastIssue[] = [];
  for (const p of pairs) {
    const ratio = contrastRatio(p.fg, p.bg);
    if (ratio + 1e-9 < p.required) {
      out.push({
        path: `theme.${p.path}`,
        ratio: Math.round(ratio * 100) / 100,
        required: p.required,
        message: `${p.what} on ${p.bgLabel} has contrast ${ratio.toFixed(2)}:1; needs at least ${p.required}:1.`,
      });
    }
  }
  return out;
}
