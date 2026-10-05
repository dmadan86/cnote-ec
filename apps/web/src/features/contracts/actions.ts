"use server";
// Buyer rate-contract actions (docs/design/rate-contracts.md). Each re-checks the session: server actions are reachable by direct POST.
// Money is typed in rupees and converted to paise here; the domain module validates everything again.
import {
  createRateContract, createRateContractFromQuote, placeCallOff, proposeRateContractRevision, respondToRateContract, sendRateContract,
  startRateContractRenewal, terminateRateContract, updateRateContractDraft, type RcItemInput, type RcTermsInput,
} from "@cnote/enquiry";
import { actorOf, requireBusiness, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runLocalized } from "@/i18n/errors";

const text = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const num = (v: string): number | null => (v === "" ? null : Number(v));
const paise = (v: string): number | null => {
  const n = num(v);
  return n === null ? null : Number.isFinite(n) ? Math.round(n * 100) : -1;
};
const whole = (v: string): number | null => {
  const n = num(v);
  return n === null ? null : Number.isFinite(n) ? n : -1;
};

/** Item rows are posted as `items.<n>.<field>`; rows are read in the order of their numbers. */
function parseTerms(f: FormData): RcTermsInput {
  const idx = [...new Set([...f.keys()].flatMap((k) => { const m = /^items\.(\d+)\./.exec(k); return m ? [Number(m[1])] : []; }))].sort((a, b) => a - b);
  const items: RcItemInput[] = idx.map((n) => {
    const g = (k: string) => text(f, `items.${n}.${k}`);
    const kind = g("variationKind") === "indexed" ? "indexed" : "fixed";
    const gst = num(g("gstPercent"));
    const cap = num(g("variationCapPercent"));
    return {
      itemKey: g("itemKey") || null, listingId: g("listingId") || null, description: g("description"), hsn: g("hsn") || null, unit: g("unit"),
      unitPricePaise: paise(g("price")) ?? 0, gstRateBps: gst === null ? 1800 : Math.round(gst * 100), moq: whole(g("moq")), quantityCap: whole(g("quantityCap")),
      variationKind: kind, variationCapBps: kind === "indexed" && cap !== null ? Math.round(cap * 100) : null, variationNote: g("variationNote") || null,
    };
  });
  return {
    validFrom: text(f, "validFrom"), validTo: text(f, "validTo"), paymentTermsDays: whole(text(f, "paymentTermsDays")) ?? -1,
    priceBasis: text(f, "priceBasis") as RcTermsInput["priceBasis"], valueCapPaise: paise(text(f, "valueCap")), notes: text(f, "notes") || null,
    changeNote: text(f, "changeNote") || null, items,
  };
}

const detail = (id: string) => `/buyer/contracts/${id}`;

/** Creates the draft (from scratch or from a quote) and goes to it. */
export async function createContractAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness("/buyer/contracts/new");
  const quoteId = text(f, "quoteId");
  let id = "";
  const r = await runLocalized(async () => {
    const terms = parseTerms(f);
    const view = quoteId
      ? await createRateContractFromQuote(actorOf(s), quoteId, { title: text(f, "title"), terms })
      : await createRateContract(actorOf(s), { sellerBusinessId: text(f, "sellerBusinessId"), title: text(f, "title"), terms });
    id = view.id;
    revalidatePath("/buyer/contracts");
  });
  if (r.ok && id) redirect(detail(id));
  return r;
}

export async function updateDraftAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "contractId");
  const s = await requireBusiness(detail(id));
  return runLocalized(async () => {
    await updateRateContractDraft(actorOf(s), id, { title: text(f, "title"), terms: parseTerms(f) });
    revalidatePath(detail(id));
  });
}

export async function sendAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "contractId");
  const s = await requireBusiness(detail(id));
  return runLocalized(async () => {
    await sendRateContract(actorOf(s), id);
    revalidatePath(detail(id));
  });
}

export async function proposeAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "contractId");
  const s = await requireBusiness(detail(id));
  return runLocalized(async () => {
    await proposeRateContractRevision(actorOf(s), id, parseTerms(f));
    revalidatePath(detail(id));
  });
}

export async function respondAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "contractId");
  const s = await requireBusiness(detail(id));
  return runLocalized(async () => {
    await respondToRateContract(actorOf(s), id, {
      revision: Number(text(f, "revision")), decision: text(f, "decision") === "rejected" ? "rejected" : "accepted", reason: text(f, "reason") || null,
    });
    revalidatePath(detail(id));
  });
}

export async function terminateAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "contractId");
  const s = await requireBusiness(detail(id));
  return runLocalized(async () => {
    await terminateRateContract(actorOf(s), id, text(f, "reason"));
    revalidatePath(detail(id));
    revalidatePath("/buyer/contracts");
  });
}

export async function renewAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "contractId");
  const s = await requireBusiness(detail(id));
  let next = "";
  const r = await runLocalized(async () => {
    next = (await startRateContractRenewal(actorOf(s), id)).id;
    revalidatePath("/buyer/contracts");
  });
  if (r.ok && next) redirect(detail(next));
  return r;
}

/** Places the call-off, then opens the new purchase order (or the order when no PO could be issued). */
export async function callOffAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = text(f, "contractId");
  const s = await requireBusiness(`${detail(id)}/call-off`);
  let dest = "";
  const r = await runLocalized(async () => {
    const lines = [...new Set([...f.keys()].flatMap((k) => { const m = /^lines\.(\d+)\./.exec(k); return m ? [Number(m[1])] : []; }))]
      .sort((a, b) => a - b)
      .flatMap((n) => {
        const qty = whole(text(f, `lines.${n}.quantity`));
        if (qty === null || qty === 0) return []; // an item left empty is not part of the call-off
        const price = paise(text(f, `lines.${n}.price`));
        return [{ itemKey: text(f, `lines.${n}.itemKey`), quantity: qty, unitPricePaise: price }];
      });
    const res = await placeCallOff(actorOf(s), id, {
      lines, addressId: text(f, "addressId") || null, expectedDelivery: text(f, "expectedDelivery") || null, notes: text(f, "notes") || null,
      idempotencyKey: text(f, "idempotencyKey") || null,
    });
    revalidatePath(detail(id));
    dest = res.purchaseOrder && !res.purchaseOrderError ? `/buyer/orders/${res.orderId}/purchase-order` : `/buyer/orders/${res.orderId}`;
  });
  if (r.ok && dest) redirect(dest);
  return r;
}
