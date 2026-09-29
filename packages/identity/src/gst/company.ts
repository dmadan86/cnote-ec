// Company profile (seller-declared identity data that GST/MCA checks verify). ADR-003.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { GST_STATES, isValidGstin, normaliseGstin } from "../gstin";
import { bustSellerCaches } from "../business";
import { openPan, sealPan } from "./pan";
import { CIN_RE, LLPIN_RE, PAN_RE, maskPan, panFromGstin } from "./normalise";

export const COMPANY_TYPES = ["proprietorship", "partnership", "llp", "private_limited", "public_limited", "huf", "other"] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export interface CompanyActor {
  personId: string;
  businessId: string;
}

const upper = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : v);
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const addressSchema = z.object({
  line1: z.string().trim().min(3, "Enter the address.").max(200),
  line2: z.string().trim().max(200).optional().or(z.literal("").transform(() => undefined)),
  city: z.string().trim().min(2, "Enter the city.").max(80),
  state: z.string().trim().min(2).max(80),
  stateCode: z.string().regex(/^\d{2}$/, "Choose the state.").refine((c) => c in GST_STATES, "Unknown state code."),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode."),
});
export type RegisteredAddress = z.infer<typeof addressSchema>;

export const companyProfileSchema = z
  .object({
    legalName: z.string().trim().min(2, "Enter the legal name.").max(200),
    tradeName: z.preprocess(blank, z.string().trim().min(2).max(200).optional()),
    companyType: z.enum(COMPANY_TYPES, { message: "Choose the company type." }),
    cin: z.preprocess((v) => blank(upper(v)), z.string().regex(CIN_RE, "Enter a valid 21-character CIN (e.g. U12345MH2019PTC123456).").optional()),
    /** LLPs carry an LLPIN (AAA-1234) instead of a CIN; accepted in the same field. */
    pan: z.preprocess((v) => blank(upper(v)), z.string().regex(PAN_RE, "Enter a valid PAN (e.g. ABCDE1234F).").optional()),
    /** Used for PAN linkage and the state check; persisted only by verifyCompanyGst on success. */
    gstin: z.preprocess((v) => blank(upper(v)), z.string().optional()),
    registeredAddress: addressSchema,
    website: z.preprocess(blank, z.string().trim().max(200).url("Enter a full URL, e.g. https://example.com.").refine((u) => /^https?:\/\//i.test(u), "Use http or https.").optional()),
  })
  .superRefine((d, ctx) => {
    if (d.gstin && !isValidGstin(d.gstin)) ctx.addIssue({ code: "custom", path: ["gstin"], message: "Invalid GSTIN. Check the 15 characters." });
    if (d.gstin && d.pan && isValidGstin(d.gstin) && panFromGstin(d.gstin) !== d.pan)
      ctx.addIssue({ code: "custom", path: ["pan"], message: "PAN must match characters 3–12 of the GSTIN." });
    if (d.cin && ["proprietorship", "partnership", "huf"].includes(d.companyType))
      ctx.addIssue({ code: "custom", path: ["cin"], message: "A CIN applies to companies only." });
    if (d.cin && d.companyType === "llp") ctx.addIssue({ code: "custom", path: ["cin"], message: "LLPs have an LLPIN, not a CIN." });
  });
export type CompanyProfileInput = z.input<typeof companyProfileSchema>;
export { LLPIN_RE };

export interface CompanyProfileView {
  businessId: string;
  legalName: string | null;
  tradeName: string | null;
  companyType: CompanyType | null;
  cin: string | null;
  /** always masked: XXXXX1234F */
  panMasked: string | null;
  gstin: string | null;
  registeredAddress: RegisteredAddress | null;
  website: string | null;
  gstStatus: string | null;
  gstVerifiedAt: string | null;
  gstLastCheckedAt: string | null;
  verificationTier: number;
}

async function assertOwner(actor: CompanyActor) {
  const m = await prisma.businessMember.findUnique({
    where: { businessId_personId: { businessId: actor.businessId, personId: actor.personId } },
    select: { role: true },
  });
  if (!m || m.role !== "owner") throw new DomainError("forbidden", "Only a business owner can change company details.");
}

/** Saves company details. PAN is stored encrypted; reads only ever return it masked. */
export async function updateCompanyProfile(actor: CompanyActor, input: CompanyProfileInput): Promise<CompanyProfileView> {
  await assertOwner(actor);
  const parsedResult = companyProfileSchema.safeParse(input);
  if (!parsedResult.success) throw new DomainError("validation", parsedResult.error.issues[0]?.message ?? "Invalid company details.");
  const d = parsedResult.data;
  const existing = await prisma.business.findUnique({ where: { id: actor.businessId }, select: { gstin: true, pan: true } });
  if (!existing) throw new DomainError("not_found", "Business not found.");
  // PAN ↔ GSTIN linkage also against an already-verified GSTIN on the business
  const gstin = d.gstin ?? existing.gstin ?? undefined;
  if (d.pan && gstin && isValidGstin(gstin) && panFromGstin(gstin) !== d.pan)
    throw new DomainError("validation", "PAN must match characters 3–12 of the GSTIN.");
  await prisma.business.update({
    where: { id: actor.businessId },
    data: {
      legalName: d.legalName,
      tradeName: d.tradeName ?? null,
      companyType: d.companyType,
      cin: d.cin ?? null,
      ...(d.pan ? { pan: await sealPan(d.pan, actor.businessId) } : {}),
      registeredAddress: d.registeredAddress,
      website: d.website ?? null,
      // keep the listing-facing location in step with the registered address
      city: d.registeredAddress.city,
      state: d.registeredAddress.state,
      pincode: d.registeredAddress.pincode,
    },
  });
  await bustSellerCaches(actor.businessId);
  return (await getCompanyProfile(actor.businessId))!;
}

export async function getCompanyProfile(businessId: string): Promise<CompanyProfileView | null> {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) return null;
  const pan = await openPan(b.pan, b.id);
  return {
    businessId: b.id,
    legalName: b.legalName,
    tradeName: b.tradeName,
    companyType: (b.companyType as CompanyType | null) ?? null,
    cin: b.cin,
    panMasked: maskPan(pan) ?? (b.pan ? "XXXXXXXXXX" : null),
    gstin: b.gstin,
    registeredAddress: (b.registeredAddress as RegisteredAddress | null) ?? null,
    website: b.website,
    gstStatus: b.gstStatus,
    gstVerifiedAt: b.gstVerifiedAt?.toISOString() ?? null,
    gstLastCheckedAt: b.gstLastCheckedAt?.toISOString() ?? null,
    verificationTier: b.verificationTier,
  };
}
export { normaliseGstin };
