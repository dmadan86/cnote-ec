import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { CANCEL_REASONS } from "@cnote/billing/pricing";
import en from "../messages/en.billingAnnual.json";
import { formatPaise } from "../src/features/billing/format-paise";
import { PricingCalculator, type CalculatorPlan } from "../src/features/billing/pricing-calculator";

const PLANS: CalculatorPlan[] = [
  { code: "free", name: "Free", monthlyPricePaise: 0, monthlyCredits: 10, annualDiscountBps: 2000 },
  { code: "starter", name: "Starter", monthlyPricePaise: 99_900, monthlyCredits: 60, annualDiscountBps: 2000 },
  { code: "pro", name: "Pro", monthlyPricePaise: 299_900, monthlyCredits: 250, annualDiscountBps: 2000 },
];
const render = (props: Partial<Parameters<typeof PricingCalculator>[0]> = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <PricingCalculator plans={PLANS} {...props} />
    </NextIntlClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("seller PricingCalculator", () => {
  it("shows the GST-inclusive monthly cost, cost per lead and credit expiry for the recommended plan", () => {
    const t = text(render());
    expect(t).toContain("₹1,178.82 a month including GST (₹999 + ₹179.82 GST).");
    expect(t).toContain("About ₹58.94 per lead you accept.");
    expect(t).toContain("stay usable for 90 days");
  });
  it("uses the GST rate it is given", () => {
    expect(text(render({ gstRateBps: 500 }))).toContain("₹1,048.95 a month including GST (₹999 + ₹49.95 GST).");
  });
  it("labels every control and announces results in a polite live region", () => {
    const html = render();
    expect(html).toMatch(/<label[^>]*for="[^"]+-leads"/);
    expect(html).toMatch(/<label[^>]*for="[^"]+-plan"/);
    expect(html).toContain("<legend");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
  it("formats paise for messages", () => {
    expect(formatPaise(95_904_0)).toBe("₹9,590.40");
  });
});

describe("billingAnnual message keys", () => {
  const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
  const flat = (o: Record<string, unknown>, p = ""): Set<string> =>
    new Set(Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [p + k] : [...flat(v as Record<string, unknown>, `${p}${k}.`)])));
  const keys = flat((en as unknown as { billingAnnual: Record<string, unknown> }).billingAnnual);
  const used = (file: string, fn: string, prefix: string) =>
    [...src(file).matchAll(new RegExp(`\\b${fn}\\("([\\w.]+)"`, "g"))].map((m) => `${prefix}${m[1]}`);

  it("every key the cancel flow, calculator, billing page and checkout read exists", () => {
    const wanted = [
      ...used("features/billing/cancel-form.tsx", "t", "cancel."),
      ...used("app/(portal)/billing/cancel/page.tsx", "t", "cancel."),
      ...used("features/billing/pricing-calculator.tsx", "t", "calc."),
      ...used("app/(portal)/billing/page.tsx", "ta", ""),
      ...used("app/(portal)/billing/checkout/page.tsx", "ta", ""),
    ];
    expect(wanted.length).toBeGreaterThan(25);
    for (const k of wanted) expect(keys.has(k), k).toBe(true);
  });
  it("has a message for every refund status the seller can see, none claiming more than is true", () => {
    for (const st of ["completed", "initiated", "processing", "attention"]) expect(keys.has(`refunds.${st}`), st).toBe(true);
    const en2 = (en as unknown as { billingAnnual: { refunds: Record<string, string> } }).billingAnnual.refunds;
    expect(en2.initiated).toBe("Refund of {amount} initiated");
    expect(en2.processing).toContain("we'll retry automatically");
  });
  it("has a label for every cancel reason the server accepts", () => {
    for (const r of CANCEL_REASONS) expect(keys.has(`cancel.reason.${r}`), r).toBe(true);
  });
  it("the cancel page shows refund, end date and credits kept, and asks for no retention step", () => {
    const page = src("app/(portal)/billing/cancel/page.tsx");
    for (const k of ["undo.button", "undo.hint", "undo.pending", "undo.locked", "status.endsOn", "cancelled.stays"]) expect(keys.has(k), k).toBe(true);
    for (const k of ["endsValue", "refundValue", "creditsValue", "lot"]) expect(page).toContain(`t("${k}"`);
    const form = src("features/billing/cancel-form.tsx");
    expect(form.match(/<SubmitButton/g)).toHaveLength(1); // one confirm button
    expect(form).not.toMatch(/required/); // the reason is optional
    expect(form.match(/<Link /g)).toHaveLength(1); // the only other control is the way back
  });
});
