import "server-only";
// Sending a quote, shared by the text-only server action (actions.ts) and the multipart route handler (app/api/quotes/route.ts).
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { rupeesToPaise } from "@cnote/core";
import { actorOf, type SessionWithBusiness } from "@cnote/next-kit";
import { numOrNull, str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { enquiry } from "@/lib/services";

/** Whole-request cap for the upload route: every allowed attachment at full size plus form fields and multipart framing. */
export const QUOTE_UPLOAD_MAX_BYTES = enquiry.MAX_QUOTE_ATTACHMENTS * enquiry.MAX_QUOTE_ATTACHMENT_BYTES + 512 * 1024;

const quoteSchema = (t: Awaited<ReturnType<typeof getTranslations>>) =>
  z.object({
    price: z.number(t("enterPrice")).positive(t("pricePositive")),
    quantity: z.number(t("enterQuantity")).positive(t("quantityPositive")),
    unit: z.string().min(1, t("chooseUnit")),
    leadTimeDays: z.number().int(t("wholeDays")).min(0).nullable().refine((v) => v === null || Number.isFinite(v), t("enterWholeDays")),
    validUntil: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, t("chooseDate")),
    notes: z.string().max(1000, t("notesMax")),
    moq: z.number(t("moqPositive")).int(t("moqPositive")).positive(t("moqPositive")).nullable(),
    deliveryTerms: z.enum(enquiry.DELIVERY_TERMS).nullable(),
    deliveryNote: z.string().max(300),
    deliveryCharge: z.number(t("chargeInvalid")).min(0, t("chargeInvalid")).nullable(),
    paymentTerms: z.enum(enquiry.PAYMENT_TERMS).nullable(),
    paymentNote: z.string().max(300),
    gstIncluded: z.boolean().nullable(),
  });

/** Quote attachments (drawings, spec sheets): an empty file input submits one zero-byte entry, which is skipped. */
async function files(fd: FormData, field: string) {
  const out: { fileName: string; bytes: Uint8Array }[] = [];
  for (const v of fd.getAll(field)) {
    if (typeof v === "string" || v.size === 0) continue;
    out.push({ fileName: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  return out;
}

/** `withFiles` is true only on the route handler, which has its own body cap; the server action (2 MB cap) refuses files outright. */
export async function sendQuote(fd: FormData, session: SessionWithBusiness, opts: { withFiles?: boolean } = {}): Promise<null> {
  const conversationId = str(fd, "conversationId");
  const t = await getTranslations("leads.conversation.errors");
  const attachments = await files(fd, "attachments");
  if (attachments.length && !opts.withFiles) throw new Error("Attachments must be uploaded through the upload endpoint, not a plain form post.");
  const q = quoteSchema(t).parse({
    price: numOrNull(fd, "price") ?? undefined,
    quantity: numOrNull(fd, "quantity") ?? undefined,
    unit: str(fd, "unit"),
    leadTimeDays: numOrNull(fd, "leadTimeDays"),
    validUntil: str(fd, "validUntil"),
    notes: str(fd, "notes"),
    moq: numOrNull(fd, "moq"),
    deliveryTerms: str(fd, "deliveryTerms") || null,
    deliveryNote: str(fd, "deliveryNote"),
    deliveryCharge: numOrNull(fd, "deliveryCharge"),
    paymentTerms: str(fd, "paymentTerms") || null,
    paymentNote: str(fd, "paymentNote"),
    gstIncluded: str(fd, "gstIncluded") === "included" ? true : str(fd, "gstIncluded") === "extra" ? false : null,
  });
  await enquiry.sendQuote(actorOf(session), z.string().min(1).parse(conversationId), {
    pricePaise: rupeesToPaise(q.price),
    quantity: q.quantity,
    unit: q.unit,
    leadTimeDays: q.leadTimeDays,
    notes: q.notes || null,
    validUntil: q.validUntil ? new Date(`${q.validUntil}T23:59:59+05:30`).toISOString() : null,
    moq: q.moq,
    moqUnit: q.moq != null ? q.unit : null,
    deliveryTerms: q.deliveryTerms,
    deliveryNote: q.deliveryNote || null,
    deliveryChargePaise: q.deliveryCharge != null ? rupeesToPaise(q.deliveryCharge) : null,
    paymentTerms: q.paymentTerms,
    paymentNote: q.paymentNote || null,
    gstIncluded: q.gstIncluded,
    attachments,
  });
  logEvent("seller.quote_sent", { businessId: session.business.id, conversationId });
  revalidatePath(`/conversations/${conversationId}`);
  return null;
}
