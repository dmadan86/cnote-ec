import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DECLINE_REASONS, REJECT_REASONS, type SampleView } from "@cnote/samples";
import en from "../messages/en.samples.json";
import hi from "../messages/hi.samples.json";
import errEn from "../messages/en.errors.json";
import errHi from "../messages/hi.errors.json";

vi.mock("@/features/samples/actions", () => ({ sampleAction: async () => ({ ok: true, data: undefined }) }));
vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => ({ raw: () => "" }) }));
vi.mock("@/lib/samples", () => ({}));

const { EvaluateForm, RequestSampleForm } = await import("@/features/samples/forms");
const { SampleProgress, SampleStatusBadge } = await import("@/features/samples/view");

const l = en.samples as never;
const sample = (over: Partial<SampleView>): SampleView => ({
  id: "s1", role: "buyer", status: "requested", subject: "Kraft carton", listingId: null, enquiryId: null, matchId: null, quoteId: null, quantity: 2, unit: "piece", buyerNote: null,
  buyer: { businessId: "b", name: "B", verificationTier: 0 }, seller: { businessId: "s", name: "S" }, shipTo: null,
  payment: { amountPaise: 0, adjustableAgainstBulk: false, note: null, receivedAt: null, free: true }, respondBy: "2026-10-08T10:00:00.000Z", overdue: false, respondedAt: null,
  declineReason: null, declineNote: null, expectedDispatchBy: null, courier: null, trackingRef: null, dispatchedAt: null, deliveredAt: null, deliveredBy: null, evaluation: null,
  bulkEnquiryId: null, createdAt: "2026-10-06T10:00:00.000Z", timeline: [{ status: "requested", actor: "buyer", note: null, at: "2026-10-06T10:00:00.000Z" }],
  can: { cancel: true, respond: false, dispatch: false, markDelivered: false, recordPayment: false, evaluate: false, requestBulk: false, acceptLinkedQuote: false }, ...over,
});

describe("samples catalogue", () => {
  it("has a label for every status, decline and reject reason, and every error key in en and hi", () => {
    for (const s of ["requested", "accepted", "declined", "dispatched", "delivered", "approved", "rejected", "expired", "cancelled"]) expect((en.samples as Record<string, string>)[`status_${s}`], s).toBeTruthy();
    for (const r of DECLINE_REASONS) expect((en.samples as Record<string, string>)[`decline_${r}`], r).toBeTruthy();
    for (const r of REJECT_REASONS) expect((hi.samples as Record<string, string>)[`reject_${r}`], r).toBeTruthy();
    const keys = ["notEnabled", "notOffered", "ownProduct", "tierRequired", "tooManyOpen", "duplicate", "quantityTooHigh", "rateLimited", "expired", "invalidTransition", "reasonsRequired", "photoType", "tooManyPhotos"];
    for (const k of keys) {
      expect((errEn.errors.samples as Record<string, string>)[k], k).toBeTruthy();
      expect((errHi.errors.samples as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});

describe("SampleProgress", () => {
  it("marks the current step with aria-current and spells out done / now / next", () => {
    const html = renderToStaticMarkup(<SampleProgress sample={sample({ status: "dispatched" })} labels={l} locale="en" />);
    expect(html).toContain('aria-label="Sample progress"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain(">Done<");
    expect(html).toContain(">Now<");
    expect(html).toContain(">Next<");
  });
  it("an ended request says so instead of showing a live tracker", () => {
    const html = renderToStaticMarkup(<SampleProgress sample={sample({ status: "expired" })} labels={l} locale="en" />);
    expect(html).toContain("This request ended: Expired");
    expect(html).not.toContain('aria-current="step"');
  });
  it("status chip always carries the word", () => {
    expect(renderToStaticMarkup(<SampleStatusBadge status="approved" labels={l} />)).toContain("Approved");
  });
});

describe("forms", () => {
  it("request form: labelled controls, ship-to group, hidden listing and the 48h note", () => {
    const html = renderToStaticMarkup(<RequestSampleForm labels={l} listingId="l1" maxQty={10} />);
    for (const t of ["Quantity (units)", "Recipient name", "Address", "City", "Pincode"]) expect(html).toContain(t);
    expect(html).toContain('name="listingId" value="l1"');
    expect(html).toContain("<legend");
    expect(html).toContain('max="10"');
    expect(html).toContain("48 hours");
  });
  it("evaluation form: approve is the default, rejection reasons appear only for a rejection, photos are optional and described", () => {
    const html = renderToStaticMarkup(<EvaluateForm sampleId="s1" labels={l} />);
    expect(html).toMatch(/name="verdict" checked="" value="approve"/);
    expect(html).not.toContain('name="reasons"');
    expect(html).toContain('type="file"');
    expect(html).toContain("aria-describedby");
    expect(html).toContain("Up to 5 JPEG, PNG or WebP photos");
  });
});
