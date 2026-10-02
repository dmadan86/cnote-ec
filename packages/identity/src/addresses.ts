// Saved delivery addresses of a business (buyer role). Personal data (DPDP): exported by exportPersonalData and
// deleted by erasePerson. The state is DERIVED from the pincode by the caller (apps/web uses @cnote/prices'
// India Post PIN table, which identity may not depend on) and validated here against the GST state table.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { GST_STATES } from "./gstin";

export const MAX_ADDRESSES = 10;

export interface DeliveryAddress {
  id: string;
  label: string;
  contactName: string | null;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  isDefault: boolean;
}

/** Optional free text: blank (as posted by an empty form field) means absent. */
const optText = (max: number) => z.string().trim().max(max).transform((v) => v || undefined).optional();

export const addressSchema = z.object({
  label: z.string().trim().min(1, "Give this address a label, for example Warehouse.").max(40),
  contactName: optText(100),
  phone: z.string().trim().regex(/^(\+91[\s-]?)?[6-9]\d{9}$/, "Enter a valid 10-digit mobile number.").optional().or(z.literal("").transform(() => undefined)),
  line1: z.string().trim().min(3, "Enter the street address.").max(160),
  line2: optText(160),
  city: z.string().trim().min(2, "Enter the city.").max(80),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode."),
  /** state name derived from the pincode by the caller; must be a known GST state */
  state: z.string().trim(),
  makeDefault: z.boolean().optional(),
});
export type AddressInput = z.input<typeof addressSchema>;

const stateCodeOf = (state: string): string | undefined => Object.entries(GST_STATES).find(([, n]) => n === state)?.[0];

const view = (a: { id: string; label: string; contactName: string | null; phone: string | null; line1: string; line2: string | null; city: string; state: string; stateCode: string; pincode: string; isDefault: boolean }): DeliveryAddress => ({
  id: a.id, label: a.label, contactName: a.contactName, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, state: a.state, stateCode: a.stateCode, pincode: a.pincode, isDefault: a.isDefault,
});

/** Default first, then newest. */
export async function listAddresses(businessId: string): Promise<DeliveryAddress[]> {
  const rows = await prisma.businessAddress.findMany({ where: { businessId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] });
  return rows.map(view);
}

/**
 * The default saved address pincode of a business, or null. Intended for prefilling the RFQ delivery pincode:
 *   const pin = await getDefaultDeliveryPincode(session.business.id);
 */
export async function getDefaultDeliveryPincode(businessId: string): Promise<string | null> {
  const a = await prisma.businessAddress.findFirst({ where: { businessId, isDefault: true }, select: { pincode: true } });
  return a?.pincode ?? null;
}

function parse(input: AddressInput) {
  const d = addressSchema.parse(input);
  const stateCode = stateCodeOf(d.state);
  if (!stateCode) throw new DomainError("validation", "We could not work out the state for this pincode.", { pincode: "We could not work out the state for this pincode." });
  return { d, stateCode };
}

/** Creates an address; the first one (or `makeDefault`) becomes the default. At most MAX_ADDRESSES per business. */
export async function addAddress(businessId: string, input: AddressInput): Promise<DeliveryAddress> {
  const { d, stateCode } = parse(input);
  return prisma.$transaction(async (tx) => {
    const count = await tx.businessAddress.count({ where: { businessId } });
    if (count >= MAX_ADDRESSES) throw new DomainError("validation", `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`);
    const isDefault = count === 0 || !!d.makeDefault;
    if (isDefault) await tx.businessAddress.updateMany({ where: { businessId, isDefault: true }, data: { isDefault: false } });
    const row = await tx.businessAddress.create({
      data: { businessId, label: d.label, contactName: d.contactName ?? null, phone: d.phone ?? null, line1: d.line1, line2: d.line2 ?? null, city: d.city, state: d.state, stateCode, pincode: d.pincode, isDefault },
    });
    return view(row);
  });
}

export async function updateAddress(businessId: string, addressId: string, input: AddressInput): Promise<DeliveryAddress> {
  const { d, stateCode } = parse(input);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.businessAddress.findFirst({ where: { id: addressId, businessId } });
    if (!existing) throw new DomainError("not_found", "Address not found.");
    const isDefault = existing.isDefault || !!d.makeDefault;
    if (isDefault && !existing.isDefault) await tx.businessAddress.updateMany({ where: { businessId, isDefault: true }, data: { isDefault: false } });
    const row = await tx.businessAddress.update({
      where: { id: addressId },
      data: { label: d.label, contactName: d.contactName ?? null, phone: d.phone ?? null, line1: d.line1, line2: d.line2 ?? null, city: d.city, state: d.state, stateCode, pincode: d.pincode, isDefault },
    });
    return view(row);
  });
}

export async function setDefaultAddress(businessId: string, addressId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.businessAddress.findFirst({ where: { id: addressId, businessId }, select: { id: true } });
    if (!existing) throw new DomainError("not_found", "Address not found.");
    await tx.businessAddress.updateMany({ where: { businessId, isDefault: true }, data: { isDefault: false } });
    await tx.businessAddress.update({ where: { id: addressId }, data: { isDefault: true } });
  });
}

/** Deletes an address; when it was the default, the most recent remaining one is promoted. */
export async function deleteAddress(businessId: string, addressId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.businessAddress.findFirst({ where: { id: addressId, businessId } });
    if (!existing) throw new DomainError("not_found", "Address not found.");
    await tx.businessAddress.delete({ where: { id: addressId } });
    if (existing.isDefault) {
      const next = await tx.businessAddress.findFirst({ where: { businessId }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (next) await tx.businessAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
}
