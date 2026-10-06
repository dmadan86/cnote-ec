// E-invoice (GST e-invoicing, IRN / signed QR) and e-way bill references on a supplier invoice. RECORD-ONLY: the seller
// pastes the values the Invoice Registration Portal gave them. This module validates formats (po-core.ts) and runs a
// consistency check through the EInvoiceVerifier port.
//
// The default (and only) adapter is the offline MOCK: it decodes the signed-QR JWT payload WITHOUT verifying the NIC signature
// and cross-checks IRN, document number, seller GSTIN, date and total against what the seller entered. A GSP adapter
// (IRP signature verification, "get IRN details" lookups, e-way bill validity) is a documented future adapter behind this port:
// docs/design/purchase-orders.md.
import QRCode from "qrcode";
import { MAX_SIGNED_QR_CHARS } from "./po-core";

export type EInvoiceCheckStatus = "consistent" | "mismatch" | "unchecked";

export interface EInvoiceCheckInput {
  irn: string | null;
  ackNo: string | null;
  signedQr: string | null;
  sellerGstin: string | null;
  invoiceNumber: string;
  /** "YYYY-MM-DD" */
  invoiceDate: string;
  totalPaise: number;
}

export interface EInvoiceCheckResult {
  status: EInvoiceCheckStatus;
  /** comma-separated field codes that disagreed (irn, docNo, sellerGstin, date, total), or null */
  note: string | null;
}

/** Port: a future GSP adapter implements the same shape. */
export interface EInvoiceVerifier {
  readonly name: string;
  verify(input: EInvoiceCheckInput): Promise<EInvoiceCheckResult>;
}

interface QrPayload { Irn?: unknown; DocNo?: unknown; SellerGstin?: unknown; DocDt?: unknown; TotInvVal?: unknown }

/** Decodes the payload of the signed QR JWT (no signature check). NIC wraps the invoice JSON as a string in `data`. */
export function decodeSignedQr(token: string): QrPayload | null {
  const parts = token.trim().split(".");
  if (parts.length < 2) return null;
  try {
    const outer = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { data?: unknown } & QrPayload;
    const inner = typeof outer.data === "string" ? (JSON.parse(outer.data) as QrPayload) : typeof outer.data === "object" && outer.data ? (outer.data as QrPayload) : outer;
    return inner && typeof inner === "object" ? inner : null;
  } catch {
    return null;
  }
}

/** NIC prints DocDt as dd/mm/yyyy. */
function qrDateToIso(v: unknown): string | null {
  const m = typeof v === "string" ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export const mockEInvoiceVerifier: EInvoiceVerifier = {
  name: "mock",
  async verify(i) {
    if (!i.signedQr) return { status: "unchecked", note: null };
    const q = decodeSignedQr(i.signedQr);
    if (!q) return { status: "mismatch", note: "signedQr" };
    const bad: string[] = [];
    if (typeof q.Irn === "string" && i.irn && q.Irn.toLowerCase() !== i.irn.toLowerCase()) bad.push("irn");
    if (typeof q.DocNo === "string" && q.DocNo.trim().toLowerCase() !== i.invoiceNumber.trim().toLowerCase()) bad.push("docNo");
    if (typeof q.SellerGstin === "string" && i.sellerGstin && q.SellerGstin.toUpperCase() !== i.sellerGstin.toUpperCase()) bad.push("sellerGstin");
    const qd = qrDateToIso(q.DocDt);
    if (qd && qd !== i.invoiceDate) bad.push("date");
    const tot = typeof q.TotInvVal === "number" ? q.TotInvVal : typeof q.TotInvVal === "string" ? Number(q.TotInvVal) : NaN;
    if (Number.isFinite(tot) && Math.abs(Math.round(tot * 100) - i.totalPaise) > 100) bad.push("total"); // rupee rounding tolerance
    return bad.length ? { status: "mismatch", note: bad.join(",") } : { status: "consistent", note: null };
  },
};

let verifier: EInvoiceVerifier = mockEInvoiceVerifier;
export const getEInvoiceVerifier = (): EInvoiceVerifier => verifier;
/** Wire a GSP adapter at the composition root (or a test double). */
export function setEInvoiceVerifier(v: EInvoiceVerifier | null): void {
  verifier = v ?? mockEInvoiceVerifier;
}

/**
 * The signed QR text as an SVG image data URI, for an <img> (no innerHTML). Null when the text cannot be encoded.
 * Error correction level L keeps the symbol readable at the ~1.5 KB size of a real signed QR.
 */
export async function qrSvgDataUri(text: string): Promise<string | null> {
  if (!text || text.length > MAX_SIGNED_QR_CHARS) return null;
  try {
    const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "L", margin: 2 });
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  } catch {
    return null;
  }
}
