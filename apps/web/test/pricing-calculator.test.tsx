import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../messages/en.pricing2.json";
import hi from "../messages/hi.pricing2.json";
import { formatPaise } from "@/features/billing/format-paise";
import { PricingCalculator, type CalculatorPlan } from "@/features/billing/pricing-calculator";
import { PlanCards } from "@/features/billing/plan-cards";

const PLANS: CalculatorPlan[] = [
  { code: "free", name: "Free", monthlyPricePaise: 0, monthlyCredits: 10, annualDiscountBps: 2000 },
  { code: "starter", name: "Starter", monthlyPricePaise: 99_900, monthlyCredits: 60, annualDiscountBps: 2000 },
  { code: "pro", name: "Pro", monthlyPricePaise: 299_900, monthlyCredits: 250, annualDiscountBps: 2000 },
];
const render = (messages: object, locale = "en", props: Partial<Parameters<typeof PricingCalculator>[0]> = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <PricingCalculator plans={PLANS} {...props} />
    </NextIntlClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("formatPaise", () => {
  it("formats whole rupees without decimals and keeps paise", () => {
    expect(formatPaise(99_900)).toBe("₹999");
    expect(formatPaise(117_882)).toBe("₹1,178.82");
    expect(formatPaise(0)).toBe("₹0");
    expect(formatPaise(1_131_667)).toBe("₹11,316.67");
  });
});

describe("PricingCalculator (public /pricing island)", () => {
  it("recommends the cheapest covering plan for 20 leads and shows GST-inclusive cost, cost per lead and credit expiry", () => {
    const html = render(en);
    const t = text(html);
    expect(t).toContain("₹1,178.82 a month including GST (₹999 + ₹179.82 GST).");
    expect(t).toContain("About ₹58.94 per lead you accept. The plan covers 20 of your 20 leads each month.");
    expect(t).toContain("40 spare credits a month roll over.");
    expect(t).toContain("stay usable for 90 days");
    expect(t).toContain("Nothing renews on its own");
  });

  it("is accessible by construction: labelled controls, a fieldset with legend for billing, and a polite live region", () => {
    const html = render(en);
    expect(html).toMatch(/<label[^>]*for="([^"]+-leads)"[^>]*>Leads you expect to accept each month<\/label>/);
    expect(html).toMatch(/<label[^>]*for="([^"]+-plan)"[^>]*>Plan<\/label>/);
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Billing<\/legend>/);
    expect(html).toContain('type="radio"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // the hint is wired to the input
    expect(html).toMatch(/aria-describedby="[^"]+-leads-hint"/);
  });

  it("has no billing choice on the free plan, and says what it adds", () => {
    const t = text(render(en, "en", { initialLeads: 5 }));
    expect(t).toContain("The Free plan costs nothing and adds 10 lead credits every month.");
    expect(t).not.toContain("Annual (save");
  });

  it("reports a shortfall when leads exceed the biggest plan", () => {
    const t = text(render(en, "en", { initialLeads: 400 }));
    expect(t).toContain("150 leads a month are more than this plan covers");
  });

  it("renders in Hindi from the hi catalogue", () => {
    const t = text(render(hi, "hi"));
    expect(t).toContain("अपनी लागत का अनुमान लगाएं");
    expect(t).toContain("₹1,178.82");
    expect(t).toContain("90");
  });
});

describe("PlanCards annual line", () => {
  it("shows the annual price line only for paid plans", () => {
    const plans = PLANS.map((p) => ({ ...p, features: [], annualPricePaise: Math.floor((p.monthlyPricePaise * 12 * 8000) / 10_000) }));
    const html = renderToStaticMarkup(<PlanCards plans={plans} annualLines={{ starter: "Annual: ₹9,590.40 a year + GST (save 20%)" }} />);
    expect(html).toContain("Annual: ₹9,590.40 a year + GST (save 20%)");
    expect(html.match(/Annual:/g)).toHaveLength(1);
  });
});
