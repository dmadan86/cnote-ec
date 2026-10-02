"use server";
import { DomainError, rateLimit } from "@cnote/core";
import { addAddress, deleteAddress, setDefaultAddress, updateAddress, verifyGstin, type AddressInput } from "@cnote/identity";
import { requireSession, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { runLocalized } from "@/i18n/errors";
import { getRequestLocale } from "@/lib/request-locale";
import { stateNameFromPincode } from "./pincode-state";

const ACCOUNT_BUSINESS = "/account/business";
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

async function tr() {
  return getTranslations({ locale: await getRequestLocale(), namespace: "account2" });
}

/** T1 (ADR-003): checks the GSTIN against the GST provider port (mock in dev) and applies the Business's tier. */
export async function verifyBuyerGstinAction(_prev: ActionResult<{ legalName: string; state: string }> | null, fd: FormData): Promise<ActionResult<{ legalName: string; state: string }>> {
  const s = await requireSession(ACCOUNT_BUSINESS);
  const t = await tr();
  if (!s.business) return { ok: false, error: t("noBusiness") };
  const businessId = s.business.id;
  const r = await runLocalized(async () => {
    // Provider lookups can cost money: cap attempts per person.
    if (!(await rateLimit(`gstin-verify:${s.personId}`, 10, 3600))) throw new DomainError("rate_limited", "Too many attempts. Try again in an hour.");
    return verifyGstin(businessId, str(fd, "gstin"));
  });
  if (!r.ok) return r;
  if (!r.data.passed) return { ok: false, error: r.data.reason ?? t("gstinFailed"), fieldErrors: { gstin: r.data.reason ?? t("gstinFailed") } };
  revalidatePath(ACCOUNT_BUSINESS);
  return { ok: true, data: { legalName: r.data.legalName ?? "", state: r.data.state ?? "" } };
}

function addressInput(fd: FormData, state: string): AddressInput {
  return {
    label: str(fd, "label"),
    contactName: str(fd, "contactName"),
    phone: str(fd, "phone").replace(/[\s-]/g, ""),
    line1: str(fd, "line1"),
    line2: str(fd, "line2"),
    city: str(fd, "city"),
    pincode: str(fd, "pincode").trim(),
    state,
    makeDefault: fd.get("makeDefault") === "on",
  };
}

/** Create (no `id`) or update a saved delivery address. The state is derived from the pincode here, never taken from the form. */
export async function saveAddressAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession(ACCOUNT_BUSINESS);
  const t = await tr();
  if (!s.business) return { ok: false, error: t("noBusiness") };
  const businessId = s.business.id;
  const pincode = str(fd, "pincode").trim();
  const state = /^[1-9]\d{5}$/.test(pincode) ? stateNameFromPincode(pincode) : null;
  if (/^[1-9]\d{5}$/.test(pincode) && !state) return { ok: false, error: t("pincodeUnknown"), fieldErrors: { pincode: t("pincodeUnknown") } };
  const id = str(fd, "id");
  const r = await runLocalized(() => (id ? updateAddress(businessId, id, addressInput(fd, state ?? "")) : addAddress(businessId, addressInput(fd, state ?? ""))));
  if (!r.ok) return r;
  revalidatePath(ACCOUNT_BUSINESS);
  return { ok: true, data: undefined };
}

export async function deleteAddressAction(fd: FormData): Promise<void> {
  const s = await requireSession(ACCOUNT_BUSINESS);
  if (!s.business) return;
  await deleteAddress(s.business.id, str(fd, "id")).catch((e) => {
    if (!(e instanceof DomainError && e.code === "not_found")) throw e;
  });
  revalidatePath(ACCOUNT_BUSINESS);
}

export async function setDefaultAddressAction(fd: FormData): Promise<void> {
  const s = await requireSession(ACCOUNT_BUSINESS);
  if (!s.business) return;
  await setDefaultAddress(s.business.id, str(fd, "id")).catch((e) => {
    if (!(e instanceof DomainError && e.code === "not_found")) throw e;
  });
  revalidatePath(ACCOUNT_BUSINESS);
}
