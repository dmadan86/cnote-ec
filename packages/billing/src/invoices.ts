// GST tax invoices + credit notes (ADR-001/005). Rule 46 CGST: mandatory fields, consecutive serial per FY (<= 16 chars),
// place of supply decides CGST+SGST (intra-state) vs IGST. See docs/design/payments-and-invoicing.md.
import { getMediaStore } from "@cnote/media";
import { DomainError } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

// ---- pure helpers ------------------------------------------------------------------------------------------------

export interface GstSplit { taxablePaise: number; gstPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }

/** GST on a taxable value, rounded half-up to the paisa. Intra-state: CGST = floor(gst/2), SGST = the rest (splits sum exactly). */
export function splitGst(taxablePaise: number, rateBps: number, intraState: boolean): GstSplit {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0) throw new DomainError("validation", "Taxable value must be a non-negative integer (paise)");
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new DomainError("validation", "GST rate must be a non-negative integer (bps)");
  const gstPaise = Math.floor((taxablePaise * rateBps + 5000) / 10_000);
  const cgstPaise = intraState ? Math.floor(gstPaise / 2) : 0;
  const sgstPaise = intraState ? gstPaise - cgstPaise : 0;
  const igstPaise = intraState ? 0 : gstPaise;
  return { taxablePaise, gstPaise, cgstPaise, sgstPaise, igstPaise, totalPaise: taxablePaise + gstPaise };
}

/** Back out the taxable value from a tax-inclusive amount (credit notes for refunds). */
export function splitInclusive(totalPaise: number, rateBps: number, intraState: boolean): GstSplit {
  const taxable = Math.round((totalPaise * 10_000) / (10_000 + rateBps));
  const gst = totalPaise - taxable;
  const cgst = intraState ? Math.floor(gst / 2) : 0;
  return { taxablePaise: taxable, gstPaise: gst, cgstPaise: cgst, sgstPaise: intraState ? gst - cgst : 0, igstPaise: intraState ? 0 : gst, totalPaise };
}

/** Indian financial year (Apr-Mar) in IST, e.g. "2026-27". */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below100(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}
function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? below100(r) : ""].filter(Boolean).join(" ");
}
/** Indian numbering (thousand, lakh, crore). */
export function numberToWordsIN(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  let rest = n;
  const crore = Math.floor(rest / 10_000_000); rest %= 10_000_000;
  const lakh = Math.floor(rest / 100_000); rest %= 100_000;
  const thousand = Math.floor(rest / 1000); rest %= 1000;
  if (crore) parts.push(`${numberToWordsIN(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}
/** "Rupees One Lakh Twenty Three Thousand and Fifty Paise Only" */
export function amountInWords(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${numberToWordsIN(r)}${p ? ` and ${below100(p)} Paise` : ""} Only`;
}

// ---- supplier config ---------------------------------------------------------------------------------------------

export interface Supplier { name: string; gstin: string; address: string; stateCode: string; sac: string; gstRateBps: number }
export function platformSupplier(env: NodeJS.ProcessEnv = process.env): Supplier {
  const rate = Number(env.PLATFORM_GST_RATE_BPS ?? 1800);
  return {
    name: env.PLATFORM_LEGAL_NAME || "Platform (legal name not configured)",
    gstin: env.PLATFORM_GSTIN ?? "",
    address: env.PLATFORM_ADDRESS ?? "",
    stateCode: env.PLATFORM_STATE_CODE || "29",
    sac: env.PLATFORM_SAC || "998314",
    gstRateBps: Number.isInteger(rate) && rate >= 0 ? rate : 1800,
  };
}

/** Place of supply for a B2B/B2C service: recipient's registered state, else the supplier's location. */
export function placeOfSupply(recipientStateCode: string | null, supplierStateCode: string): string {
  return recipientStateCode && /^\d{2}$/.test(recipientStateCode) ? recipientStateCode : supplierStateCode;
}
export const isIntraState = (pos: string, supplierState: string): boolean => pos === supplierState;

// ---- numbering ---------------------------------------------------------------------------------------------------

export type InvoiceKind = "tax_invoice" | "credit_note";
const PREFIX: Record<InvoiceKind, string> = { tax_invoice: "CN", credit_note: "CR" };

/**
 * Next gapless number for a series. The upsert takes a row lock held until the caller's transaction ends, so a
 * rollback releases the number (no gaps) and concurrent issuers serialise. Format "CN/26-27/000123" = 15 chars:
 * Rule 46 caps the serial at 16 characters.
 */
export async function nextInvoiceNumber(tx: Tx, kind: InvoiceKind, fy: string): Promise<string> {
  const series = `${PREFIX[kind]}/${fy}`;
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO invoice_sequences (series, last_number) VALUES (${series}, 1)
    ON CONFLICT (series) DO UPDATE SET last_number = invoice_sequences.last_number + 1
    RETURNING last_number`;
  const n = rows[0]!.last_number;
  return `${PREFIX[kind]}/${fy.slice(2)}/${String(n).padStart(6, "0")}`;
}

// ---- issuing -----------------------------------------------------------------------------------------------------

export interface InvoiceLineInput { description: string; sac: string; quantity: number; unitPaise: number; gstRateBps: number }
export interface InvoiceLine extends InvoiceLineInput { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }
export interface Recipient { name: string; gstin?: string | null; address: string; stateCode: string | null }

export interface IssueInput {
  kind: InvoiceKind;
  businessId: string;
  paymentOrderId?: string | null;
  recipient: Recipient;
  lines: InvoiceLineInput[];
  refInvoiceId?: string | null;
  supplier?: Supplier;
  at?: Date;
  /** Credit notes: the refunded, tax-inclusive amount. The first line is re-priced so taxable + GST equals this exactly. */
  inclusiveTotalPaise?: number;
}

export function computeLines(lines: InvoiceLineInput[], intra: boolean): { lines: InvoiceLine[]; totals: GstSplit } {
  const out = lines.map((l) => {
    const s = splitGst(l.unitPaise * l.quantity, l.gstRateBps, intra);
    return { ...l, taxablePaise: s.taxablePaise, cgstPaise: s.cgstPaise, sgstPaise: s.sgstPaise, igstPaise: s.igstPaise };
  });
  const sum = (k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise") => out.reduce((a, l) => a + l[k], 0);
  const t = { taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise") };
  const gstPaise = t.cgstPaise + t.sgstPaise + t.igstPaise;
  return { lines: out, totals: { ...t, gstPaise, totalPaise: t.taxablePaise + gstPaise } };
}

export interface InvoiceView {
  id: string; number: string; kind: InvoiceKind; businessId: string; paymentOrderId: string | null; refInvoiceId: string | null;
  taxablePaise: number; gstPaise: number; totalPaise: number; issuedAt: string; placeOfSupply: string;
}
type InvoiceRow = Awaited<ReturnType<typeof prisma.invoice.findFirstOrThrow>>;
const toView = (i: InvoiceRow): InvoiceView => ({
  id: i.id, number: i.number, kind: i.kind as InvoiceKind, businessId: i.businessId, paymentOrderId: i.paymentOrderId, refInvoiceId: i.refInvoiceId,
  taxablePaise: Number(i.taxablePaise), gstPaise: Number(i.cgstPaise + i.sgstPaise + i.igstPaise), totalPaise: Number(i.totalPaise),
  issuedAt: i.issuedAt.toISOString(), placeOfSupply: i.placeOfSupply,
});

/** Issue an invoice / credit note inside the caller's transaction (the number is only consumed if the tx commits). */
export async function issueInvoiceTx(tx: Tx, input: IssueInput): Promise<InvoiceView> {
  if (input.lines.length === 0) throw new DomainError("validation", "An invoice needs at least one line");
  const supplier = input.supplier ?? platformSupplier();
  const at = input.at ?? new Date();
  const pos = placeOfSupply(input.recipient.stateCode, supplier.stateCode);
  const intra = isIntraState(pos, supplier.stateCode);
  let { lines, totals } = computeLines(input.lines, intra);
  if (input.inclusiveTotalPaise !== undefined) {
    const first = input.lines[0]!;
    const sp = splitInclusive(input.inclusiveTotalPaise, first.gstRateBps, intra);
    lines = [{ ...first, quantity: 1, unitPaise: sp.taxablePaise, taxablePaise: sp.taxablePaise, cgstPaise: sp.cgstPaise, sgstPaise: sp.sgstPaise, igstPaise: sp.igstPaise }];
    totals = sp;
  }
  const fy = financialYear(at);
  const number = await nextInvoiceNumber(tx, input.kind, fy);
  const row = await tx.invoice.create({
    data: {
      paymentOrderId: input.paymentOrderId ?? null, businessId: input.businessId, kind: input.kind, number, financialYear: fy,
      supplier: supplier as object, recipient: input.recipient as object, lines: lines as object[],
      taxablePaise: BigInt(totals.taxablePaise), cgstPaise: BigInt(totals.cgstPaise), sgstPaise: BigInt(totals.sgstPaise), igstPaise: BigInt(totals.igstPaise),
      totalPaise: BigInt(totals.totalPaise), placeOfSupply: pos, refInvoiceId: input.refInvoiceId ?? null, issuedAt: at,
    },
  });
  return toView(row);
}

// ---- access ------------------------------------------------------------------------------------------------------

/** Owner (businessId) or staff. Callers gate `staff: true` behind payments.read. */
export type InvoiceActor = { businessId: string; staff?: false } | { staff: true; businessId?: string };

export async function listInvoices(actor: InvoiceActor, opts: { limit?: number; businessId?: string } = {}): Promise<InvoiceView[]> {
  const businessId = actor.staff ? opts.businessId : actor.businessId;
  if (!actor.staff && !businessId) throw new DomainError("forbidden", "No business");
  const rows = await prisma.invoice.findMany({ where: businessId ? { businessId } : {}, orderBy: { issuedAt: "desc" }, take: Math.min(opts.limit ?? 50, 200) });
  return rows.map(toView);
}

/** Pluggable private document cache (composition root may wire @cnote/media). Rendering is deterministic, so this is optional. */
export interface InvoiceDocStore { put(key: string, bytes: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | null> }
/** Default: the PRIVATE media bucket (`invoices/` keys are private-only). Rendered PDFs are cached there once issued. */
const mediaDocStore: InvoiceDocStore = {
  put: (key, bytes) => getMediaStore("private").put(key, bytes, "application/pdf"),
  get: async (key) => (await getMediaStore("private").get(key))?.bytes ?? null,
};
export const mediaInvoiceDocStore = mediaDocStore;
let docStore: InvoiceDocStore | null = mediaDocStore;
/** Tests / alternative stores; null disables caching (render on demand). */
export function setInvoiceDocStore(s: InvoiceDocStore | null): void { docStore = s; }

export async function getInvoicePdf(actor: InvoiceActor, invoiceId: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv || (!actor.staff && inv.businessId !== actor.businessId)) throw new DomainError("not_found", "Invoice not found");
  const filename = `${inv.number.replace(/\//g, "-")}.pdf`;
  const key = `invoices/${inv.id}/document.pdf`;
  if (docStore) {
    const hit = await docStore.get(key).catch(() => null);
    if (hit) return { bytes: hit, filename };
  }
  const bytes = await renderInvoicePdf(inv);
  if (docStore) {
    await docStore.put(key, bytes).then(() => prisma.invoice.update({ where: { id: inv.id }, data: { documentKey: key } })).catch((e) => console.error("[billing] invoice doc cache failed", e));
  }
  return { bytes, filename };
}

// ---- PDF ---------------------------------------------------------------------------------------------------------

const rs = (p: number | bigint) => `Rs. ${(Number(p) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Helvetica (WinAnsi) cannot encode arbitrary Unicode; keep only printable Latin-1. */
const safe = (s: string) => s.replace(/[^\x20-\x7e -ÿ]/g, "?");

export async function renderInvoicePdf(inv: Pick<InvoiceRow, "number" | "kind" | "supplier" | "recipient" | "lines" | "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "totalPaise" | "placeOfSupply" | "issuedAt"> & { refInvoiceId?: string | null }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sup = inv.supplier as unknown as Supplier;
  const rec = inv.recipient as unknown as Recipient;
  const lines = inv.lines as unknown as InvoiceLine[];
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);
  const M = 40;
  const W = 595.28 - 2 * M;
  const text = (p: PDFPage, t: string, x: number, y: number, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean } = {}) => {
    const f = o.f ?? font;
    const size = o.size ?? 9;
    const s = safe(t);
    p.drawText(s, { x: o.right ? x - f.widthOfTextAtSize(s, size) : x, y, size, font: f, color: o.color ?? ink });
  };
  const wrap = (t: string, max: number, size: number): string[] => {
    const out: string[] = [];
    let cur = "";
    for (const w of safe(t).split(/\s+/)) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > max && cur) { out.push(cur); cur = w; } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  };
  const credit = inv.kind === "credit_note";
  let y = 800;
  text(page, credit ? "CREDIT NOTE" : "TAX INVOICE", M, y, { size: 20, f: bold });
  text(page, `No: ${inv.number}`, M + W, y + 8, { right: true, f: bold, size: 11 });
  text(page, `Date: ${inv.issuedAt.toISOString().slice(0, 10)}`, M + W, y - 6, { right: true });
  y -= 34;
  const block = (title: string, name: string, gstin: string | null | undefined, addr: string, x: number) => {
    let by = y;
    text(page, title, x, by, { size: 8, color: muted, f: bold });
    by -= 13;
    text(page, name, x, by, { f: bold, size: 10 });
    for (const l of wrap(addr, W / 2 - 20, 9)) { by -= 12; text(page, l, x, by); }
    by -= 12;
    text(page, `GSTIN: ${gstin || "Unregistered"}`, x, by);
    return by;
  };
  const b1 = block("SUPPLIER", sup.name, sup.gstin, sup.address, M);
  const b2 = block("BILLED TO", rec.name, rec.gstin, rec.address, M + W / 2 + 10);
  y = Math.min(b1, b2) - 16;
  text(page, `Place of supply: ${inv.placeOfSupply}    Supplier state code: ${sup.stateCode}`, M, y);
  if (credit && inv.refInvoiceId) text(page, "Against original tax invoice (see records)", M + W, y, { right: true, color: muted });
  y -= 22;

  const cols = [M, M + 24, M + 250, M + 300, M + 340, M + 400, M + 445, M + W];
  const head = ["#", "Description", "SAC", "Qty", "Taxable", "Rate", "GST"];
  page.drawRectangle({ x: M, y: y - 5, width: W, height: 18, color: rgb(0.93, 0.94, 0.96) });
  head.forEach((h, i) => text(page, h, i >= 3 ? cols[i + 1]! - 4 : cols[i]! + 3, y, { f: bold, right: i >= 3 }));
  y -= 20;
  lines.forEach((l, i) => {
    const gst = l.cgstPaise + l.sgstPaise + l.igstPaise;
    const d = wrap(l.description, 215, 9);
    text(page, String(i + 1), cols[0]! + 3, y);
    d.forEach((ln, k) => text(page, ln, cols[1]! + 3, y - k * 11));
    text(page, l.sac, cols[2]! + 3, y);
    text(page, String(l.quantity), cols[4]! - 4, y, { right: true });
    text(page, rs(l.taxablePaise), cols[5]! - 4, y, { right: true });
    text(page, `${l.gstRateBps / 100}%`, cols[6]! - 4, y, { right: true });
    text(page, rs(gst), cols[7]! - 4, y, { right: true });
    y -= 14 + (d.length - 1) * 11;
  });
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: M + W, y: y + 6 }, thickness: 0.5, color: muted });
  y -= 10;
  const sumRow = (label: string, v: number | bigint, b = false) => {
    text(page, label, M + W - 120, y, { f: b ? bold : font, right: true });
    text(page, rs(v), M + W, y, { f: b ? bold : font, right: true });
    y -= 14;
  };
  sumRow("Taxable value", inv.taxablePaise);
  if (inv.igstPaise > 0n) sumRow("IGST", inv.igstPaise);
  else { sumRow("CGST", inv.cgstPaise); sumRow("SGST", inv.sgstPaise); }
  sumRow(credit ? "Credit total" : "Invoice total", inv.totalPaise, true);
  y -= 8;
  text(page, `Amount in words: ${amountInWords(Number(inv.totalPaise))}`, M, y, { f: bold });
  y -= 30;
  text(page, credit ? "Issued under section 34 of the CGST Act against the original invoice." : "Reverse charge: No. Payment received via hosted gateway checkout; we never store card details.", M, y, { color: muted, size: 8 });
  text(page, "This is a computer generated document and does not require a signature.", M, 50, { color: muted, size: 8 });
  return doc.save();
}
