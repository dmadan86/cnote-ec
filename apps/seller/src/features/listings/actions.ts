"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DomainError, rupeesToPaise } from "@cnote/core";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import type { ListingInput, ListingView, VersionView } from "@cnote/catalogue";
import { requireSeller } from "@/lib/auth";
import { ONB, readOnb, writeOnb } from "@/lib/cookies";
import { numOrNull, str } from "@/lib/form-data";
import { parseTierRows, parseTradeFields } from "./trade-form";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { catalogue } from "@/lib/services";
import { AVAILABILITIES, type Availability } from "@cnote/catalogue";

export type DraftResult = ActionResult<{ listingId: string }>;
export type SaveResult = ActionResult<{ listing: ListingView; intent: "save" | "publish"; version?: VersionView }>;
export type RowResult = ActionResult<null>;

type T = Awaited<ReturnType<typeof getTranslations>>;

const draftSchema = (t: T) =>
  z.object({
    text: z.string().min(10, t("actions.draftMin")).max(2000, t("actions.draftMax")),
    language: z.string().min(2).max(5),
  });

/** ADR-004: free text (Hindi/Hinglish/English) -> AI draft listing. Never auto-published (DESIGN principle 5). */
export async function draftListingAction(_prev: DraftResult | null, fd: FormData): Promise<DraftResult> {
  const mode = str(fd, "mode") === "onboarding" ? "onboarding" : "portal";
  const t = await getTranslations("listings");
  const session = await requireSeller(mode === "onboarding" ? "/onboarding" : "/listings/new");
  const result = await run(async () => {
    const input = draftSchema(t).parse({ text: str(fd, "text"), language: str(fd, "language") || "en" });
    const started = Date.now();
    const listing = await catalogue.draftListingFromText(session.business.id, input.text, input.language);
    logEvent("seller.listing_drafted", { businessId: session.business.id, listingId: listing.id, aiMs: Date.now() - started });
    return { listingId: listing.id };
  });
  if (result.ok) {
    revalidatePath("/listings");
    redirect(mode === "onboarding" ? "/onboarding" : `/listings/${result.data.listingId}/edit`);
  }
  return result;
}

const formSchema = (t: T) =>
  z.object({
    id: z.string().optional(),
    categoryId: z.string().min(1, t("actions.chooseCategory")),
    title: z.string().min(3, t("actions.titleMin")).max(140, t("actions.titleMax")),
    description: z.string().min(10, t("actions.descMin")).max(4000),
    priceRupees: z.number().min(0, t("actions.priceNegative")).nullable().refine((v) => v === null || Number.isFinite(v), t("actions.priceNumber")),
    priceUnit: z.string().max(20),
    moq: z.number().int(t("actions.moqWhole")).min(1, t("actions.moqMin")).nullable().refine((v) => v === null || Number.isFinite(v), t("actions.moqNumber")),
    moqUnit: z.string().max(20),
    hsn: z.string().regex(/^(\d{4}|\d{6}|\d{8})?$/, t("actions.hsnFormat")).optional(),
    language: z.string().min(2).max(5),
    imageUrls: z.array(z.url(t("actions.imageLink")).refine((u) => u.startsWith("https://"), t("actions.imageLink"))).max(5, t("actions.imageMax")),
  });

function issue(path: string, message: string): z.core.$ZodIssue {
  return { code: "custom", path: [path], message, input: undefined };
}

/** Create/update a listing; with intent=publish also validates + moderates via catalogue.publishListing (ADR-003/004). */
export async function saveListingAction(_prev: SaveResult | null, fd: FormData): Promise<SaveResult> {
  const t = await getTranslations("listings");
  const session = await requireSeller("/listings");
  const actor = actorOf(session);
  return run(async () => {
    const intent: "save" | "publish" = str(fd, "intent") === "publish" ? "publish" : "save";
    const parsed = formSchema(t).parse({
      id: str(fd, "id") || undefined,
      categoryId: str(fd, "categoryId"),
      title: str(fd, "title"),
      description: str(fd, "description"),
      priceRupees: numOrNull(fd, "priceRupees"),
      priceUnit: str(fd, "priceUnit"),
      moq: numOrNull(fd, "moq"),
      moqUnit: str(fd, "moqUnit"),
      hsn: str(fd, "hsn"),
      language: str(fd, "language") || "en",
      imageUrls: str(fd, "imageUrls").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
    });

    const category = (await catalogue.listCategories()).find((c) => c.id === parsed.categoryId);
    if (!category) throw new DomainError("validation", t("actions.chooseCategory"));
    if (category.prohibited) throw new DomainError("validation", t("actions.prohibited"));

    const issues: z.core.$ZodIssue[] = [];
    if (parsed.priceRupees !== null && !parsed.priceUnit) issues.push(issue("priceUnit", t("actions.priceUnitNeeded")));
    if (parsed.moq !== null && !parsed.moqUnit) issues.push(issue("moqUnit", t("actions.moqUnitNeeded")));
    const attributes: Record<string, string | number> = {};
    for (const f of category.attributeSchema.fields) {
      const raw = str(fd, `attr.${f.key}`);
      if (raw === "") {
        if (f.required && intent === "publish") issues.push(issue(`attr.${f.key}`, t("actions.attrNeeded", { label: f.label })));
        continue;
      }
      if (f.type === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) issues.push(issue(`attr.${f.key}`, t("actions.attrNumber")));
        else attributes[f.key] = n;
      } else attributes[f.key] = raw;
    }
    const tierRows = parseTierRows(fd.getAll("tierMinQty").map(String), fd.getAll("tierPrice").map(String));
    for (const n of tierRows.badRows) issues.push(issue("tiers", t("actions.tierInvalid", { n })));
    const { trade, invalid: tradeInvalid } = parseTradeFields({
      leadTimeDays: str(fd, "leadTimeDays"),
      packaging: str(fd, "packaging"),
      sampleAvailable: str(fd, "sampleAvailable") === "on",
      samplePriceRupees: str(fd, "samplePriceRupees"),
      supplyCapacityPerMonth: str(fd, "supplyCapacityPerMonth"),
      paymentTerms: str(fd, "paymentTerms"),
      certifications: str(fd, "certifications"),
    });
    if (tradeInvalid) issues.push(issue("trade", t("actions.tradeNumber")));
    // stock (docs/design/variants-stock.md): absent when the listing has variants (its state is derived from them)
    const ts = await getTranslations("stock.actions");
    const availabilityRaw = str(fd, "availability");
    let availability: Availability | undefined;
    let availableQty: number | null | undefined;
    if (availabilityRaw) {
      if (!(AVAILABILITIES as readonly string[]).includes(availabilityRaw)) issues.push(issue("availability", ts("bad")));
      else availability = availabilityRaw as Availability;
      const q = numOrNull(fd, "availableQty");
      if (q !== null && (!Number.isInteger(q) || q < 0)) issues.push(issue("availableQty", ts("qtyInvalid")));
      else availableQty = availability === "out_of_stock" ? null : q;
      if (availability === "made_to_order" && trade.leadTimeDays == null) issues.push(issue("availability", ts("leadTimeNeeded")));
    }
    if (issues.length) throw new z.ZodError(issues);

    const input: ListingInput = {
      categoryId: parsed.categoryId,
      title: parsed.title,
      description: parsed.description,
      attributes,
      pricePaise: parsed.priceRupees === null ? null : rupeesToPaise(parsed.priceRupees),
      priceUnit: parsed.priceRupees === null ? null : parsed.priceUnit,
      moq: parsed.moq,
      moqUnit: parsed.moq === null ? null : parsed.moqUnit,
      hsn: parsed.hsn || null,
      priceTiers: tierRows.tiers,
      trade,
      language: parsed.language,
      imageUrls: parsed.imageUrls,
      ...(availability ? { availability, availableQty: availableQty ?? null } : {}),
    };

    let listing = parsed.id ? await catalogue.updateListing(actor.businessId, parsed.id, input) : await catalogue.createListing(actor.businessId, input);
    let version: VersionView | undefined;
    if (intent === "publish") {
      // Never goes live directly: snapshots a version for review; the publisher takes it live once approved.
      version = await catalogue.submitListingVersion(actor.businessId, listing.id, { changeNote: null, createdBy: session.personId });
      listing = (await catalogue.getListing(listing.id)) ?? listing;
      logEvent("seller.listing_publish_attempt", { businessId: actor.businessId, listingId: listing.id, status: version.status, version: version.version, aiGenerated: listing.aiGenerated });
      if (version.status !== "rejected" && !(await readOnb(ONB.firstListing))) {
        // ADR-004 metric: time from business creation to first listing submitted for publication. The start time (seller_onb_t0) is an
        // analytics cookie, so it exists only after opt-in; without it the event is still logged, with no timing.
        const t0 = Number(await readOnb(ONB.startedAt));
        logEvent("seller.first_listing_published", { businessId: actor.businessId, listingId: listing.id, timeToFirstListingMs: Number.isFinite(t0) && t0 > 0 ? Date.now() - t0 : null });
        await writeOnb(ONB.firstListing, String(Date.now()));
      }
    }
    revalidatePath("/listings");
    return { listing, intent, version };
  });
}

export async function publishListingAction(_prev: RowResult | null, fd: FormData): Promise<RowResult> {
  const session = await requireSeller("/listings");
  return run(async () => {
    const id = z.string().min(1).parse(str(fd, "id"));
    const version = await catalogue.submitListingVersion(session.business.id, id, { changeNote: null, createdBy: session.personId });
    logEvent("seller.listing_publish_attempt", { businessId: session.business.id, listingId: id, status: version.status, version: version.version });
    revalidatePath("/listings");
    return null;
  });
}

export async function archiveListingAction(_prev: RowResult | null, fd: FormData): Promise<RowResult> {
  const session = await requireSeller("/listings");
  return run(async () => {
    await catalogue.archiveListing(session.business.id, z.string().min(1).parse(str(fd, "id")));
    revalidatePath("/listings");
    return null;
  });
}

const submitSchema = z.object({
  listingId: z.string().min(1),
  changeNote: z.string().max(500).optional(),
  publishAt: z.string().optional(),
});

export type VersionActionResult = ActionResult<{ message: string }>;

/** Snapshot the saved working copy as a new version; optional schedule (datetime-local, interpreted in the seller's timezone offset sent by the form). */
export async function submitVersionAction(_prev: VersionActionResult | null, fd: FormData): Promise<VersionActionResult> {
  const t = await getTranslations("listings.actions");
  const session = await requireSeller("/listings");
  return run(async () => {
    const d = submitSchema.parse({ listingId: str(fd, "listingId"), changeNote: str(fd, "changeNote") || undefined, publishAt: str(fd, "publishAt") || undefined });
    let publishAt: Date | null = null;
    if (d.publishAt) {
      // <input type=datetime-local> has no zone; the form also posts tzOffset (minutes, Date#getTimezoneOffset).
      const off = Number(str(fd, "tzOffset") || 0);
      const local = new Date(`${d.publishAt}:00Z`);
      if (Number.isNaN(local.getTime())) throw new DomainError("validation", t("actions.badDate"));
      publishAt = new Date(local.getTime() + (Number.isFinite(off) ? off : 0) * 60_000);
    }
    const v = await catalogue.submitListingVersion(session.business.id, d.listingId, { changeNote: d.changeNote, publishAt, createdBy: session.personId });
    logEvent("seller.listing_version_submitted", { businessId: session.business.id, listingId: d.listingId, version: v.version, status: v.status, scheduled: !!publishAt });
    revalidatePath("/listings");
    revalidatePath(`/listings/${d.listingId}/edit`);
    const message =
      v.status === "approved" ? (publishAt ? t("approvedScheduled", { version: v.version }) : t("approvedLive", { version: v.version }))
      : v.status === "rejected" ? t("rejected", { version: v.version, note: v.reviewNote ?? t("policyFailed") })
      : t("submitted", { version: v.version });
    return { message };
  });
}

export async function withdrawVersionAction(_prev: VersionActionResult | null, fd: FormData): Promise<VersionActionResult> {
  const t = await getTranslations("listings.actions");
  const session = await requireSeller("/listings");
  return run(async () => {
    const v = await catalogue.withdrawVersion(session.business.id, z.string().min(1).parse(str(fd, "versionId")));
    revalidatePath("/listings");
    revalidatePath(`/listings/${v.listingId}/edit`);
    return { message: t("withdrawn", { version: v.version }) };
  });
}

export async function unpublishListingAction(_prev: VersionActionResult | null, fd: FormData): Promise<VersionActionResult> {
  const t = await getTranslations("listings.actions");
  const session = await requireSeller("/listings");
  return run(async () => {
    const id = z.string().min(1).parse(str(fd, "id"));
    await catalogue.unpublishListing(session.business.id, id);
    revalidatePath("/listings");
    revalidatePath(`/listings/${id}/edit`);
    return { message: t("offline") };
  });
}
