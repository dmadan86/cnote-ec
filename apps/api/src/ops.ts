// Transport-neutral operations shared by REST routes and MCP tools. Every function takes the
// authenticated principal and only ever acts as its { personId, businessId } — ownership is then
// enforced again inside the domain modules (ADR-006).
import { getActiveSubscription, getBalance } from "@cnote/billing";
import * as bulk from "@cnote/bulk";
import {
  archiveListing, createListing, getCategoryBySlug, getListing, listCategories, listSellerListings, publishListing, setListingVariants, updateListing, updateListingStock,
  type CategoryView, type ListingInput, type ListingView, type StockUpdate, type VariantInput,
} from "@cnote/catalogue";
import { DomainError, rateLimit } from "@cnote/core";
import { estimateForListing } from "@cnote/logistics";
import type { ApiPrincipal } from "@cnote/developer";
import {
  acceptLead, createEnquiry, declineLead, getBuyerEnquiry, getConversation, getSellerLead, listBuyerEnquiries, listSellerLeads,
  awardLines, listAwardedLines, reportDeal, sendMessage, sendQuote, type EnquiryInput, type EnquiryView, type LeadView,
} from "@cnote/enquiry";
import { getPersonBusinesses, getPersonSummaries, getTrustProfiles } from "@cnote/identity";
import { getRatingSummary, listApprovedReviews, submitReview, type ReviewInput } from "@cnote/reviews";
import { searchListings } from "@cnote/search";
import { addItem, getList, listLists, removeItem } from "@cnote/wishlist";

type P = ApiPrincipal;
export const CURRENCY = "INR" as const;

export interface Page<T> { items: T[]; nextCursor: string | null }

/** Offset cursors over modules that return whole arrays. */
export function paginate<T>(all: T[], cursor: string | undefined, limit: number): Page<T> {
  let offset = 0;
  if (cursor) {
    const decoded = Buffer.from(cursor, "base64url").toString();
    offset = /^\d{1,9}$/.test(decoded) ? Number(decoded) : -1;
    if (offset < 0) throw new DomainError("validation", "Invalid cursor");
  }
  const items = all.slice(offset, offset + limit);
  const next = offset + limit;
  return { items, nextCursor: next < all.length ? Buffer.from(String(next)).toString("base64url") : null };
}

function actor(p: P): { personId: string; businessId: string } {
  if (!p.businessId) throw new DomainError("forbidden", "This API key is not bound to a business. Create the key for a business in your account settings.");
  return { personId: p.personId, businessId: p.businessId };
}

// --- mappers: add currency, keep seller-only fields out of public payloads ---
/** Stock + variants are always present on the wire (defaults for rows from before the feature). */
const stockOut = (l: ListingView) => ({
  availability: l.availability ?? ("in_stock" as const),
  availableQty: l.availableQty ?? null,
  stockUpdatedAt: l.stockUpdatedAt ?? null,
  variantAxes: l.variantAxes ?? [],
  variants: l.variants ?? [],
});
export function publicListing(l: ListingView) {
  const { status: _s, moderationStatus: _m, moderationReason: _r, images: _i, ...rest } = l;
  return { ...rest, ...stockOut(l), currency: CURRENCY };
}
export function sellerListing(l: ListingView) {
  const { images: _i, ...rest } = l;
  return { ...rest, ...stockOut(l), currency: CURRENCY };
}
const enquiryOut = (e: EnquiryView) => ({ ...e, currency: CURRENCY });
const leadOut = (l: LeadView) => ({ ...l, enquiry: { ...l.enquiry, currency: CURRENCY } });

// --- catalogue ---
const visibleCategory = (c: CategoryView) => {
  const { leadCap: _l, prohibited: _p, ...rest } = c;
  return rest;
};
export async function categories() {
  return (await listCategories()).filter((c) => !c.prohibited).map(visibleCategory);
}
export async function category(slug: string) {
  const c = await getCategoryBySlug(slug);
  if (!c || c.prohibited) throw new DomainError("not_found", "Category not found");
  return visibleCategory(c);
}
/** "size:m,size:l,colour:red" -> { size: ["m","l"], colour: ["red"] } (OR within an axis, AND across axes). Malformed pairs are ignored. */
export function parseVariantFilter(raw: string | undefined): Record<string, string[]> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string[]> = {};
  for (const part of raw.split(",")) {
    const i = part.indexOf(":");
    const axis = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (i <= 0 || !value || !/^[a-z][a-z0-9_]{0,29}$/.test(axis)) continue;
    (out[axis] ??= []).push(value);
  }
  return Object.keys(out).length ? out : undefined;
}
export async function search(input: { q: string; category?: string; limit?: number; inStock?: boolean; variant?: string }) {
  const variantOptions = parseVariantFilter(input.variant);
  const filters = { ...(input.inStock ? { inStockOnly: true } : {}), ...(variantOptions ? { variantOptions } : {}) };
  const { hits, facets } = await searchListings({ q: input.q, categorySlug: input.category, limit: input.limit, ...(Object.keys(filters).length ? { filters } : {}) });
  return { items: hits.map((h) => ({ listing: publicListing(h.listing), seller: h.seller, score: h.score, sponsored: false as const })), ...(facets ? { facets } : {}) };
}
export async function listing(id: string) {
  const l = await getListing(id);
  // Only published + approved listings are public (ADR-002 visibility).
  if (!l || l.status !== "published" || l.moderationStatus !== "approved") throw new DomainError("not_found", "Listing not found");
  return publicListing(l);
}
/** Freight ESTIMATE for a public listing (docs/design/freight-estimator.md); an extra per-key limit because live carrier lookups cost money. */
export async function listingFreightEstimate(p: P, id: string, quantity: number, pincode: string) {
  if (!(await rateLimit(`api:freight:${p.keyId}`, 60, 60))) throw new DomainError("rate_limited", "Too many freight estimates. Try again in a minute.");
  return estimateForListing(id, quantity, pincode);
}
export async function seller(id: string) {
  const profile = (await getTrustProfiles([id])).get(id);
  if (!profile) throw new DomainError("not_found", "Seller not found");
  return profile;
}
export async function me(p: P) {
  const business = p.businessId ? ((await getTrustProfiles([p.businessId])).get(p.businessId) ?? null) : null;
  const [person, businesses] = await Promise.all([getPersonSummaries([p.personId]), getPersonBusinesses(p.personId)]);
  const me = person.get(p.personId);
  return {
    personId: p.personId, keyId: p.keyId, scopes: [...p.scopes], businessId: p.businessId, business,
    person: { id: p.personId, name: me?.name ?? null, email: me?.email ?? null },
    businesses: businesses.map((b) => ({ businessId: b.businessId, name: b.name, role: b.role, isSeller: b.isSeller, isBuyer: b.isBuyer, verificationTier: b.verificationTier, badgeActive: b.badgeActive })),
  };
}

// --- seller listings ---
async function resolveCategoryId(input: { categoryId?: string; categorySlug?: string }): Promise<string | undefined> {
  if (input.categoryId) return input.categoryId;
  if (!input.categorySlug) return undefined;
  const c = await getCategoryBySlug(input.categorySlug);
  if (!c) throw new DomainError("validation", `Unknown category slug: ${input.categorySlug}`);
  return c.id;
}
export async function myListings(p: P, cursor: string | undefined, limit: number) {
  const page = paginate(await listSellerListings(actor(p).businessId), cursor, limit);
  return { ...page, items: page.items.map(sellerListing) };
}
export async function newListing(p: P, input: Omit<ListingInput, "categoryId"> & { categoryId?: string; categorySlug?: string }) {
  const a = actor(p);
  const { categorySlug: _s, categoryId: _c, ...rest } = input;
  const categoryId = await resolveCategoryId(input);
  if (!categoryId) throw new DomainError("validation", "categoryId or categorySlug is required");
  return sellerListing(await createListing(a.businessId, { ...rest, categoryId }));
}
export async function patchListing(p: P, id: string, input: Partial<Omit<ListingInput, "categoryId">> & { categoryId?: string; categorySlug?: string }) {
  const a = actor(p);
  const { categorySlug: _s, categoryId: _c, ...rest } = input;
  const categoryId = await resolveCategoryId(input);
  return sellerListing(await updateListing(a.businessId, id, { ...rest, ...(categoryId ? { categoryId } : {}) }));
}
/** Stock fast path (no review): listing-level and/or per-variant availability, quantity and lead time. */
export async function patchStock(p: P, id: string, update: StockUpdate) {
  return sellerListing(await updateListingStock(actor(p).businessId, id, update));
}
/** Replaces the listing's variant set. Structure is reviewed like any content change once the listing is (re)published. */
export async function putVariants(p: P, id: string, variants: VariantInput[]) {
  await setListingVariants(actor(p).businessId, id, variants);
  return sellerListing((await getListing(id))!);
}
export async function publish(p: P, id: string) {
  return sellerListing(await publishListing(actor(p).businessId, id));
}
export async function archive(p: P, id: string) {
  await archiveListing(actor(p).businessId, id);
  return { ok: true as const };
}

// --- leads ---
export async function leads(p: P, cursor: string | undefined, limit: number) {
  const page = paginate(await listSellerLeads(actor(p).businessId), cursor, limit);
  return { ...page, items: page.items.map(leadOut) };
}
export async function acceptLeadOp(p: P, matchId: string) {
  const a = actor(p);
  if (!(await getSellerLead(a.businessId, matchId))) throw new DomainError("not_found", "Lead not found");
  return leadOut(await acceptLead(a, matchId));
}
export async function declineLeadOp(p: P, matchId: string, reason?: string) {
  const a = actor(p);
  if (!(await getSellerLead(a.businessId, matchId))) throw new DomainError("not_found", "Lead not found");
  await declineLead(a, matchId, reason);
  return { ok: true as const };
}
export async function balance(p: P) {
  const a = actor(p);
  const [credits, sub] = await Promise.all([getBalance(a.businessId), getActiveSubscription(a.businessId)]);
  return { credits, subscription: sub ? { planCode: sub.planCode, status: sub.status, periodEnd: sub.periodEnd } : null };
}

// --- enquiries & conversations ---
export async function newEnquiry(p: P, input: EnquiryInput, ip?: string | null, userAgent?: string | null) {
  return enquiryOut(await createEnquiry(actor(p), input, { ip: ip ?? null, userAgent: userAgent ?? null }));
}
export async function myEnquiries(p: P, cursor: string | undefined, limit: number) {
  const page = paginate(await listBuyerEnquiries(actor(p).businessId), cursor, limit);
  return { ...page, items: page.items.map(enquiryOut) };
}
export async function enquiry(p: P, id: string) {
  const e = await getBuyerEnquiry(actor(p).businessId, id);
  if (!e) throw new DomainError("not_found", "Enquiry not found");
  return enquiryOut(e);
}
export async function conversation(p: P, id: string) {
  const c = await getConversation(actor(p), id);
  if (!c) throw new DomainError("not_found", "Conversation not found");
  return { ...c, quotes: c.quotes.map((q) => ({ ...q, currency: CURRENCY })) };
}
export async function awardEnquiryLines(p: P, enquiryId: string, awards: { enquiryLineId: string; quoteId: string }[]) {
  return awardLines(actor(p), enquiryId, awards);
}
export async function awardedLines(p: P, enquiryId: string) {
  return { items: await listAwardedLines(actor(p), enquiryId) };
}
export async function message(p: P, conversationId: string, body: string) {
  await sendMessage(actor(p), conversationId, body);
  return { ok: true as const };
}
export async function quote(p: P, conversationId: string, q: Parameters<typeof sendQuote>[2]) {
  await sendQuote(actor(p), conversationId, q);
  return { ok: true as const };
}
export async function dealReport(p: P, matchId: string, outcome: "won" | "lost" | "pending", valuePaise?: number | null) {
  await reportDeal(actor(p), matchId, outcome, valuePaise);
  return { ok: true as const };
}

// --- wishlist ---
export const wishlists = (p: P) => listLists(p.personId);
export async function wishlist(p: P, id: string) {
  const w = await getList(p.personId, id);
  return { ...w, items: w.items.map((i) => ({ ...i, currency: CURRENCY, listing: i.listing ? publicListing(i.listing) : null })) };
}
export async function wishlistAdd(p: P, listId: string, listingId: string) {
  // The module verifies list ownership; also refuse non-public listings so keys can't probe drafts.
  await listing(listingId);
  return addItem(p.personId, listingId, listId);
}
export const wishlistRemove = (p: P, listId: string, listingId: string) => removeItem(p.personId, listId, listingId);

// --- reviews ---
export async function reviews(listingId: string, opts: { cursor?: string; limit?: number; sort?: "recent" | "helpful" | "rating_high" | "rating_low" }) {
  await listing(listingId);
  const [page, summary] = await Promise.all([listApprovedReviews(listingId, opts), getRatingSummary(listingId)]);
  return { ...page, summary };
}
export async function review(p: P, listingId: string, input: ReviewInput) {
  await listing(listingId);
  return submitReview({ personId: p.personId, businessId: p.businessId }, listingId, input);
}

export type { EnquiryInput };

// --- bulk import / export (seller keys) ---
export const bulkImport = (p: P, file: { bytes: Uint8Array; filename: string }, o: { mode: "create" | "upsert"; submitForReview: boolean }) => bulk.createImportJob(actor(p), file, o);
export const bulkJob = (p: P, id: string) => bulk.getJob(actor(p), id);
export const bulkConfirm = (p: P, id: string, skipInvalid: boolean) => bulk.confirmImportJob(actor(p), id, { skipInvalid });
export const bulkCancel = (p: P, id: string) => bulk.cancelJob(actor(p), id);
export const bulkExport = (p: P, o: { format: "xlsx" | "csv"; includeImages: boolean }) => bulk.createExportJob(actor(p), o);
export const bulkDownload = (p: P, id: string, which: "result" | "errors" | "source") => bulk.getDownload(actor(p), id, which, { preferSignedUrl: true });
export const bulkAssertSeller = (p: P) => void actor(p);

// --- samples (docs/design/samples.md) ---
// @cnote/samples is imported lazily: the API boots without loading it, and while SAMPLES_ENABLED is off every sample route answers 404
// (like the ONDC endpoints) instead of advertising a feature that is not live.
async function samplesModule() {
  const s = await import("@cnote/samples");
  if (!s.samplesEnabled()) throw new DomainError("not_found", "Not found");
  return s;
}
type SampleViewT = import("@cnote/samples").SampleView;
const sampleOut = (v: SampleViewT) => ({ ...v, currency: CURRENCY });

export async function requestSampleOp(p: P, input: import("@cnote/samples").RequestSampleInput) {
  const s = await samplesModule();
  return sampleOut(await s.requestSample(actor(p), input));
}
export async function listSamplesOp(p: P, role: "buyer" | "seller", filter: "open" | "done" | undefined, cursor: string | undefined, limit: number) {
  const s = await samplesModule();
  const a = actor(p);
  const all = role === "buyer" ? await s.listBuyerSamples(a, { filter, limit: 200 }) : await s.listSellerSamples(a, { filter, limit: 200 });
  return paginate(all, cursor, limit);
}
export async function getSampleOp(p: P, id: string) {
  const s = await samplesModule();
  const v = await s.getSample(actor(p), id);
  if (!v) throw new DomainError("not_found", "Sample request not found");
  return sampleOut(v);
}
export type SampleActionName = "cancel" | "accept" | "decline" | "dispatch" | "delivered" | "payment" | "evaluate" | "acceptQuote" | "link";
export async function sampleAction(p: P, action: SampleActionName, id: string, input?: unknown) {
  const s = await samplesModule();
  const a = actor(p);
  const i = (input ?? {}) as never;
  const run: Record<SampleActionName, () => Promise<SampleViewT>> = {
    cancel: () => s.cancelSample(a, id),
    accept: () => s.acceptSample(a, id, i),
    decline: () => s.declineSample(a, id, i),
    dispatch: () => s.dispatchSample(a, id, i),
    delivered: () => s.markSampleDelivered(a, id),
    payment: () => s.recordSamplePayment(a, id, (input as { note?: string | null } | undefined)?.note),
    evaluate: () => s.evaluateSample(a, id, i),
    acceptQuote: () => s.acceptLinkedQuote(a, id),
    link: () => s.linkBulkEnquiry(a, id, (input as { enquiryId: string }).enquiryId),
  };
  return sampleOut(await run[action]());
}
export async function sampleBulkPrefillOp(p: P, id: string) {
  const s = await samplesModule();
  return s.getBulkPrefill(actor(p), id);
}
export async function sellerSampleStatsOp(sellerBusinessId: string) {
  const s = await samplesModule();
  const st = (await s.getSellerSampleStats([sellerBusinessId])).get(sellerBusinessId);
  if (!st) throw new DomainError("not_found", "Seller not found");
  return st;
}
