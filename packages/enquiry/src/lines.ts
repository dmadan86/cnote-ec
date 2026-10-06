// Multi-line RFQ (bill of materials): requirement lines, per-line quote maths and per-line awards.
// docs/design/rfq-multiline.md. Per ADR-007 (lifecycle, event log); AI text goes through the existing capabilities.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { categoryById } from "./support";

export const MAX_ENQUIRY_LINES = 50;

const optStr = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

/** One requirement line as typed by the buyer, uploaded from a BOM sheet, or sent through the API. */
export const enquiryLineSchema = z.object({
  itemName: z.string().trim().min(1, "Give each line an item name").max(140, "Item name is too long (max 140)"),
  spec: optStr(1000),
  quantity: z.number().int("Quantity must be a whole number").positive("Quantity must be above 0").max(2_000_000_000),
  unit: z.string().trim().min(1, "Give each line a unit").max(20),
  targetPricePaise: z.number().int().positive().max(10_000_000_000_00).nullish().transform((v) => v ?? null),
  categorySlug: optStr(100),
  hsn: z
    .string()
    .trim()
    .regex(/^\d{4}(\d{2}(\d{2})?)?$/, "HSN must be 4, 6 or 8 digits")
    .nullish()
    .transform((v) => v ?? null),
});
export type EnquiryLineInput = z.input<typeof enquiryLineSchema>;
export type ParsedEnquiryLine = z.output<typeof enquiryLineSchema>;

export const enquiryLinesSchema = z.array(enquiryLineSchema).min(1, "Add at least one line").max(MAX_ENQUIRY_LINES, `An RFQ can have up to ${MAX_ENQUIRY_LINES} lines`);

export interface EnquiryLineView {
  id: string;
  /** 1-based */
  ordinal: number;
  itemName: string;
  spec: string | null;
  quantity: number;
  unit: string;
  targetPricePaise: number | null;
  category: { slug: string; name: string } | null;
  hsn: string | null;
}

type LineRow = {
  id: string; ordinal: number; itemName: string; spec: string | null; quantity: number; unit: string;
  targetPricePaise: bigint | null; categoryId: string | null; hsn: string | null;
};

export async function toLineViews(rows: LineRow[]): Promise<EnquiryLineView[]> {
  const out: EnquiryLineView[] = [];
  for (const r of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    const cat = await categoryById(r.categoryId);
    out.push({
      id: r.id, ordinal: r.ordinal, itemName: r.itemName, spec: r.spec, quantity: r.quantity, unit: r.unit,
      targetPricePaise: r.targetPricePaise === null ? null : Number(r.targetPricePaise),
      category: cat ? { slug: cat.slug, name: cat.name } : null,
      hsn: r.hsn,
    });
  }
  return out;
}

/** Lines of many enquiries in one query (ordered). */
export async function linesByEnquiry(enquiryIds: string[]): Promise<Map<string, EnquiryLineView[]>> {
  const map = new Map<string, EnquiryLineView[]>();
  if (!enquiryIds.length) return map;
  const rows = await prisma.enquiryLine.findMany({ where: { enquiryId: { in: enquiryIds } }, orderBy: [{ enquiryId: "asc" }, { ordinal: "asc" }] });
  const grouped = new Map<string, LineRow[]>();
  for (const r of rows) grouped.set(r.enquiryId, [...(grouped.get(r.enquiryId) ?? []), r]);
  for (const [id, list] of grouped) map.set(id, await toLineViews(list));
  return map;
}

/**
 * Plain-text digest of the lines for the AI capabilities (moderation, embedding, intent scoring). The text is passed to
 * the capabilities like any other requirement text, i.e. inside the existing `userInputEnvelope` (ADR-008, prompt injection).
 */
export function linesDigest(lines: Pick<ParsedEnquiryLine, "itemName" | "spec" | "quantity" | "unit" | "hsn">[], maxChars = 3000): string {
  if (lines.length <= 1 && !lines[0]?.spec && !lines[0]?.hsn) return "";
  const out: string[] = [];
  let used = 0;
  for (const [i, l] of lines.entries()) {
    const row = `${i + 1}. ${l.itemName} x ${l.quantity} ${l.unit}${l.hsn ? ` (HSN ${l.hsn})` : ""}${l.spec ? ` - ${l.spec}` : ""}`;
    if (used + row.length > maxChars) { out.push(`... and ${lines.length - i} more line(s)`); break; }
    out.push(row);
    used += row.length + 1;
  }
  return `Line items (${lines.length}):\n${out.join("\n")}`;
}

/** Title used when the caller (typically the API) sends lines but no RFQ title. */
export function deriveTitle(lines: { itemName: string }[]): string {
  const first = lines[0]?.itemName ?? "Requirement";
  const t = lines.length > 1 ? `${first} and ${lines.length - 1} more item${lines.length > 2 ? "s" : ""}` : first;
  return t.length >= 5 ? t.slice(0, 140) : `${t} requirement`;
}

// ---------------------------------------------------------------------------------------------
// Quote lines: pure maths (paise, BigInt). All totals are computed here, never taken from the client.
// ---------------------------------------------------------------------------------------------

/** Round-half-up integer division for non-negative operands. */
export function divRound(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

export interface LineAmounts {
  /** price x quantity, ex GST (when prices include GST: the gross with the GST portion removed) */
  subtotalPaise: bigint;
  gstPaise: bigint;
  /** payable for the line */
  totalPaise: bigint;
}

/**
 * `gstIncluded === true`: the unit price already contains GST, so the payable is price x quantity and the GST is the
 * included portion. Otherwise GST is added on top at `gstRatePct` (null rate = 0).
 */
export function lineAmounts(unitPricePaise: bigint, quantity: number, gstRatePct: number | null, gstIncluded: boolean | null): LineAmounts {
  const gross = unitPricePaise * BigInt(quantity);
  const rate = BigInt(gstRatePct ?? 0);
  if (gstIncluded === true) {
    const subtotal = divRound(gross * 100n, 100n + rate);
    return { subtotalPaise: subtotal, gstPaise: gross - subtotal, totalPaise: gross };
  }
  const gst = divRound(gross * rate, 100n);
  return { subtotalPaise: gross, gstPaise: gst, totalPaise: gross + gst };
}

export const quoteLineSchema = z.object({
  /** Identify the requirement line by id, or by its 1-based ordinal (API convenience). One of the two is required. */
  enquiryLineId: z.string().uuid().nullish().transform((v) => v ?? null),
  ordinal: z.number().int().positive().max(MAX_ENQUIRY_LINES).nullish().transform((v) => v ?? null),
  unitPricePaise: z.number().int().positive().max(10_000_000_000_00).nullish().transform((v) => v ?? null),
  gstRatePct: z.number().int().min(0).max(40).nullish().transform((v) => v ?? null),
  leadTimeDays: z.number().int().min(0).max(730).nullish().transform((v) => v ?? null),
  cantSupply: z.boolean().nullish().transform((v) => v ?? false),
  notes: z.string().trim().max(300).nullish().transform((v) => v || null),
}).superRefine((v, ctx) => {
  if (!v.enquiryLineId && v.ordinal === null) ctx.addIssue({ code: "custom", path: ["enquiryLineId"], message: "Each quote line needs a requirement line" });
  if (!v.cantSupply && v.unitPricePaise === null) ctx.addIssue({ code: "custom", path: ["unitPricePaise"], message: "Enter a unit price, or mark the line as can't supply" });
});
export type QuoteLineInput = z.input<typeof quoteLineSchema>;
export type ParsedQuoteLine = z.output<typeof quoteLineSchema>;

export interface PreparedQuoteLine {
  enquiryLineId: string;
  unitPricePaise: bigint | null;
  gstRatePct: number | null;
  leadTimeDays: number | null;
  cantSupply: boolean;
  notes: string | null;
  quantity: number;
  amounts: LineAmounts | null;
}

export interface PreparedQuoteLines {
  rows: PreparedQuoteLine[];
  subtotalPaise: bigint;
  gstPaise: bigint;
  totalPaise: bigint;
  quotedLineCount: number;
  /** first priced line, mirrored into Quote.pricePaise/quantity/unit for backward compatibility */
  first: { unitPricePaise: bigint; quantity: number; unit: string };
}

/**
 * Validates a seller's per-line input against the requirement's lines and computes every amount server-side.
 * Partial quotes are fine (lines may be skipped); at least one line must be priced.
 */
export function prepareQuoteLines(
  input: QuoteLineInput[],
  enquiryLines: { id: string; ordinal: number; quantity: number; unit: string }[],
  gstIncluded: boolean | null,
): PreparedQuoteLines {
  if (!Array.isArray(input) || input.length === 0) throw new DomainError("validation", "Add at least one quote line.");
  const parsed = z.array(quoteLineSchema).max(MAX_ENQUIRY_LINES).safeParse(input);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid quote line");
  const byId = new Map(enquiryLines.map((l) => [l.id, l]));
  const byOrdinal = new Map(enquiryLines.map((l) => [l.ordinal, l]));
  const seen = new Set<string>();
  const rows: PreparedQuoteLine[] = [];
  for (const p of parsed.data) {
    const line = p.enquiryLineId ? byId.get(p.enquiryLineId) : byOrdinal.get(p.ordinal!);
    if (!line) throw new DomainError("validation", "A quote line does not belong to this requirement.");
    if (p.enquiryLineId && p.ordinal !== null && line.ordinal !== p.ordinal) throw new DomainError("validation", "Quote line id and line number disagree.");
    if (seen.has(line.id)) throw new DomainError("validation", `Line ${line.ordinal} is quoted twice.`);
    seen.add(line.id);
    const price = p.cantSupply ? null : BigInt(p.unitPricePaise!);
    rows.push({
      enquiryLineId: line.id,
      unitPricePaise: price,
      gstRatePct: p.cantSupply ? null : p.gstRatePct,
      leadTimeDays: p.cantSupply ? null : p.leadTimeDays,
      cantSupply: p.cantSupply,
      notes: p.notes,
      quantity: line.quantity,
      amounts: price === null ? null : lineAmounts(price, line.quantity, p.gstRatePct, gstIncluded),
    });
  }
  const priced = rows.filter((r) => r.amounts !== null);
  if (priced.length === 0) throw new DomainError("validation", "Price at least one line.");
  const sum = (pick: (a: LineAmounts) => bigint) => priced.reduce((acc, r) => acc + pick(r.amounts!), 0n);
  const firstRow = [...priced].sort((a, b) => (byId.get(a.enquiryLineId)!.ordinal - byId.get(b.enquiryLineId)!.ordinal))[0]!;
  return {
    rows,
    subtotalPaise: sum((a) => a.subtotalPaise),
    gstPaise: sum((a) => a.gstPaise),
    totalPaise: sum((a) => a.totalPaise),
    quotedLineCount: priced.length,
    first: { unitPricePaise: firstRow.unitPricePaise!, quantity: firstRow.quantity, unit: byId.get(firstRow.enquiryLineId)!.unit },
  };
}

export interface QuoteLineView {
  id: string;
  enquiryLineId: string;
  ordinal: number;
  unitPricePaise: number | null;
  gstRatePct: number | null;
  leadTimeDays: number | null;
  cantSupply: boolean;
  notes: string | null;
  quantity: number;
  lineSubtotalPaise: number | null;
  lineGstPaise: number | null;
  lineTotalPaise: number | null;
}

type QuoteLineRow = {
  id: string; enquiryLineId: string; unitPricePaise: bigint | null; gstRatePct: number | null; leadTimeDays: number | null; cantSupply: boolean;
  notes: string | null; quantity: number; lineSubtotalPaise: bigint | null; lineGstPaise: bigint | null; lineTotalPaise: bigint | null;
};
const num = (v: bigint | null) => (v === null ? null : Number(v));

export function toQuoteLineView(r: QuoteLineRow, ordinal: number): QuoteLineView {
  return {
    id: r.id, enquiryLineId: r.enquiryLineId, ordinal, unitPricePaise: num(r.unitPricePaise), gstRatePct: r.gstRatePct, leadTimeDays: r.leadTimeDays,
    cantSupply: r.cantSupply, notes: r.notes, quantity: r.quantity, lineSubtotalPaise: num(r.lineSubtotalPaise), lineGstPaise: num(r.lineGstPaise), lineTotalPaise: num(r.lineTotalPaise),
  };
}

/** Quote lines of many quotes, ordered by requirement-line ordinal. */
export async function quoteLinesByQuote(quoteIds: string[]): Promise<Map<string, QuoteLineView[]>> {
  const map = new Map<string, QuoteLineView[]>();
  if (!quoteIds.length) return map;
  const rows = await prisma.quoteLine.findMany({ where: { quoteId: { in: quoteIds } }, include: { line: { select: { ordinal: true } } } });
  for (const r of rows) map.set(r.quoteId, [...(map.get(r.quoteId) ?? []), toQuoteLineView(r, r.line.ordinal)]);
  for (const [id, list] of map) map.set(id, list.sort((a, b) => a.ordinal - b.ordinal));
  return map;
}

// ---------------------------------------------------------------------------------------------
// Comparison matrix (pure): rows = requirement lines, columns = suppliers.
// ---------------------------------------------------------------------------------------------

export interface MatrixCell {
  /** quoteId the cell belongs to */
  quoteId: string;
  /** null = the supplier skipped this line (partial quote) */
  line: QuoteLineView | null;
  /** lowest payable for this line among suppliers (ties are all marked) */
  lowest: boolean;
}

/** Lowest line total per requirement line. Can't-supply and skipped lines never count. Ties are all lowest. */
export function lowestPerLine(quotes: { quoteId: string; lines: QuoteLineView[] }[], lineIds: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const id of lineIds) {
    let best: number | null = null;
    let winners = new Set<string>();
    for (const q of quotes) {
      const l = q.lines.find((x) => x.enquiryLineId === id);
      if (!l || l.cantSupply || l.lineTotalPaise === null) continue;
      if (best === null || l.lineTotalPaise < best) { best = l.lineTotalPaise; winners = new Set([q.quoteId]); }
      else if (l.lineTotalPaise === best) winners.add(q.quoteId);
    }
    out.set(id, winners);
  }
  return out;
}
