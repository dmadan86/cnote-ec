// Purchase order PDF (one per sent version). Rendered from the immutable version snapshot, stored once in the PRIVATE media bucket
// (`invoices/po/...` keys are private-only) with its sha256 recorded for tamper evidence. Same approach as billing's invoice PDF.
import { amountInWords } from "@cnote/billing";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PoLine, PoTotals } from "./po-core";

export interface PartySnapshot { name: string; legalName: string | null; gstin: string | null; stateCode: string | null }
export interface AddressSnapshot { label: string; contactName: string | null; phone: string | null; line1: string; line2: string | null; city: string; state: string; stateCode: string; pincode: string }

export interface PoPdfData {
  number: string;
  version: number;
  issuedAt: Date;
  buyer: PartySnapshot;
  seller: PartySnapshot;
  deliveryAddress: AddressSnapshot;
  placeOfSupply: string;
  intraState: boolean;
  paymentTermsDays: number;
  /** "YYYY-MM-DD" */
  expectedDelivery: string | null;
  notes: string | null;
  lines: PoLine[];
  totals: PoTotals;
}

const rs = (p: number) => `Rs. ${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Helvetica (WinAnsi) cannot encode arbitrary Unicode; keep printable Latin-1 only. */
const safe = (s: string) => s.replace(/[^\x20-\x7e -ÿ]/g, "?");

export async function renderPurchaseOrderPdf(po: PoPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Deterministic bytes for a given snapshot: no "now" in the metadata.
  doc.setCreationDate(po.issuedAt);
  doc.setModificationDate(po.issuedAt);
  doc.setTitle(`Purchase order ${po.number} v${po.version}`);
  doc.setProducer("cnote");
  doc.setCreator("cnote");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);
  const M = 40;
  const PW = 595.28;
  const PH = 841.89;
  const W = PW - 2 * M;
  let page: PDFPage = doc.addPage([PW, PH]);
  let y = PH - M;

  const text = (t: string, x: number, yy: number, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean } = {}) => {
    const f = o.f ?? font;
    const size = o.size ?? 9;
    const s = safe(t);
    page.drawText(s, { x: o.right ? x - f.widthOfTextAtSize(s, size) : x, y: yy, size, font: f, color: o.color ?? ink });
  };
  const wrap = (t: string, max: number, size: number, f: PDFFont = font): string[] => {
    const out: string[] = [];
    let cur = "";
    for (const w of safe(t).split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > max && cur) { out.push(cur); cur = w; } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  };
  const rule = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: M + W, y: yy }, thickness: 0.5, color: rgb(0.8, 0.8, 0.84) });
  const ensure = (need: number) => {
    if (y - need < M + 50) { page = doc.addPage([PW, PH]); y = PH - M; }
  };

  text("PURCHASE ORDER", M, y - 14, { size: 18, f: bold });
  text(po.number, PW - M, y - 12, { size: 12, f: bold, right: true });
  text(`Version ${po.version}  |  Issued ${po.issuedAt.toISOString().slice(0, 10)}`, PW - M, y - 26, { size: 9, color: muted, right: true });
  y -= 44;
  rule(y);
  y -= 16;

  // Parties
  const colW = W / 2 - 8;
  const party = (title: string, p: PartySnapshot, x: number) => {
    let yy = y;
    text(title, x, yy, { size: 8, color: muted, f: bold });
    yy -= 13;
    for (const l of wrap(p.legalName ?? p.name, colW, 10, bold)) { text(l, x, yy, { size: 10, f: bold }); yy -= 12; }
    if (p.legalName && p.legalName !== p.name) { text(`Trade name: ${p.name}`, x, yy, { color: muted }); yy -= 12; }
    text(`GSTIN: ${p.gstin ?? "not provided"}`, x, yy); yy -= 12;
    if (p.stateCode) { text(`State code: ${p.stateCode}`, x, yy); yy -= 12; }
    return yy;
  };
  const yb = party("BUYER", po.buyer, M);
  const ys = party("SUPPLIER", po.seller, M + W / 2 + 8);
  y = Math.min(yb, ys) - 6;

  // Delivery + terms
  const a = po.deliveryAddress;
  text("DELIVER TO", M, y, { size: 8, color: muted, f: bold });
  text("TERMS", M + W / 2 + 8, y, { size: 8, color: muted, f: bold });
  let ya = y - 13;
  const addr = [a.contactName ? `${a.contactName}${a.phone ? `, ${a.phone}` : ""}` : null, a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`].filter((x): x is string => !!x);
  for (const l of addr) for (const w of wrap(l, colW, 9)) { text(w, M, ya); ya -= 11; }
  let yt = y - 13;
  const terms = [
    `Payment: ${po.paymentTermsDays === 0 ? "on delivery / advance" : `${po.paymentTermsDays} days from acceptance of goods`}`,
    `Expected delivery: ${po.expectedDelivery ?? "as agreed"}`,
    `Place of supply: state code ${po.placeOfSupply} (${po.intraState ? "CGST + SGST" : "IGST"})`,
  ];
  for (const l of terms) for (const w of wrap(l, colW, 9)) { text(w, M + W / 2 + 8, yt); yt -= 11; }
  y = Math.min(ya, yt) - 10;

  // Lines table
  const cols = { no: M, desc: M + 20, hsn: M + 215, qty: M + 275, rate: M + 345, tax: M + 410, gst: M + 440, total: M + W };
  rule(y + 4);
  text("#", cols.no, y - 8, { size: 8, f: bold });
  text("Item", cols.desc, y - 8, { size: 8, f: bold });
  text("HSN", cols.hsn, y - 8, { size: 8, f: bold });
  text("Qty", cols.qty, y - 8, { size: 8, f: bold });
  text("Rate", cols.rate + 50, y - 8, { size: 8, f: bold, right: true });
  text("Taxable", cols.tax + 55, y - 8, { size: 8, f: bold, right: true });
  text("GST %", cols.gst + 30, y - 8, { size: 8, f: bold, right: true });
  text("Total", cols.total, y - 8, { size: 8, f: bold, right: true });
  y -= 14;
  rule(y);
  y -= 4;
  for (const l of po.lines) {
    const descLines = wrap(l.description, 185, 9);
    ensure(descLines.length * 11 + 8);
    const top = y - 10;
    text(String(l.lineNo), cols.no, top);
    descLines.forEach((d, i) => text(d, cols.desc, top - i * 11));
    text(l.hsn ?? "-", cols.hsn, top);
    text(`${l.quantity} ${l.unit}`, cols.qty, top);
    text(`${rs(l.unitPricePaise)}${l.priceIncludesGst ? "*" : ""}`, cols.rate + 50, top, { right: true });
    text(rs(l.taxablePaise), cols.tax + 55, top, { right: true });
    text(`${l.gstRateBps / 100}`, cols.gst + 30, top, { right: true });
    text(rs(l.totalPaise), cols.total, top, { right: true });
    y -= Math.max(1, descLines.length) * 11 + 6;
  }
  rule(y);
  y -= 6;
  if (po.lines.some((l) => l.priceIncludesGst)) { text("* unit price includes GST", M, y - 8, { size: 8, color: muted }); y -= 14; }

  // Totals
  ensure(90);
  const tl = PW - M - 150;
  const row = (label: string, value: string, b = false) => {
    y -= 13;
    text(label, tl, y, { f: b ? bold : font });
    text(value, PW - M, y, { right: true, f: b ? bold : font });
  };
  row("Taxable value", rs(po.totals.taxablePaise));
  if (po.intraState) { row("CGST", rs(po.totals.cgstPaise)); row("SGST", rs(po.totals.sgstPaise)); } else row("IGST", rs(po.totals.igstPaise));
  row("Total", rs(po.totals.totalPaise), true);
  y -= 16;
  for (const l of wrap(amountInWords(po.totals.totalPaise), W, 9, bold)) { text(l, M, y, { f: bold }); y -= 11; }

  if (po.notes) {
    y -= 8;
    ensure(30);
    text("NOTES", M, y, { size: 8, color: muted, f: bold });
    y -= 12;
    for (const l of wrap(po.notes, W, 9)) { ensure(12); text(l, M, y); y -= 11; }
  }

  y -= 12;
  ensure(60);
  const fine = [
    "Payment to a registered micro or small enterprise is governed by section 15 of the MSMED Act 2006: the agreed credit period may not exceed 45 days from acceptance of goods (15 days if there is no written agreement).",
    "This document is system-generated and is valid without a signature. An amendment is issued as a new version and supersedes earlier versions. The supplier acknowledges or rejects each version in the marketplace.",
  ];
  for (const f of fine) for (const l of wrap(f, W, 7.5)) { ensure(10); text(l, M, y, { size: 7.5, color: muted }); y -= 9.5; }

  return doc.save({ useObjectStreams: false });
}
