import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/features/samples/actions", () => ({ sampleAction: async () => null }));
const { AcceptForm, DeclineForm, DispatchForm, IntentButton } = await import("../src/features/samples/forms");

const messages = JSON.parse(readFileSync(join(__dirname, "..", "messages", "en.samples.json"), "utf8"));
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);

describe("seller sample forms", () => {
  it("accept: price (prefilled), adjustable checkbox and instructions are labelled; the amount is described as off-platform", () => {
    const html = wrap(<AcceptForm sampleId="s1" defaultRupees="150" />);
    expect(html).toContain('name="intent" value="accept"');
    expect(html).toContain('name="amountRupees"');
    expect(html).toContain('value="150"');
    expect(html).toContain('name="adjustable"');
    expect(html).toContain("outside cnote");
    expect(html).toContain("Accept and see the address");
  });
  it("decline offers every structured reason", () => {
    const html = wrap(<DeclineForm sampleId="s1" />);
    for (const r of ["Out of stock", "Quantity is too high for a sample", "Buyer needs a higher verification level"]) expect(html).toContain(r);
    expect(html).toContain("required");
  });
  it("dispatch needs a courier; tracking is optional", () => {
    const html = wrap(<DispatchForm sampleId="s1" />);
    expect(html).toContain('name="courier"');
    expect(html).toMatch(/required=""[^>]*name="courier"|name="courier"[^>]*required=""/);
    expect(html).not.toMatch(/name="trackingRef"[^>]*required/);
  });
  it("one-button intents carry the sample id", () => {
    const html = wrap(<IntentButton sampleId="s9" intent="delivered" label="Mark as delivered" />);
    expect(html).toContain('name="sampleId" value="s9"');
    expect(html).toContain("Mark as delivered");
  });
});
