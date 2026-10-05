// Cell parsing shared by product rows and variant rows.
import type { Availability } from "@cnote/catalogue";
import { parseAvailability } from "./columns";

export type Bad = (column: string, message: string) => void;

/** "1,250.5" / "Rs 12" / "₹12.50" -> paise, or null when not a valid money amount. */
export function rupeesToPaise(raw: string): number | null {
  const s = raw.replace(/[₹,\s]|^rs\.?/gi, "");
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

export interface StockCells {
  availability?: Availability;
  availableQty?: number;
  leadTimeDays?: number;
}

/** availability / available_qty / lead_time_days of a product or variant row; blank cells stay undefined. */
export function parseStockCells(c: Record<string, string>, bad: Bad): StockCells {
  const out: StockCells = {};
  if (c.availability) {
    const a = parseAvailability(c.availability);
    if (!a) bad("availability", "Availability must be one of: in_stock, made_to_order, out_of_stock");
    else out.availability = a;
  }
  if (c.available_qty) {
    const n = Number(c.available_qty.replace(/,/g, ""));
    if (!Number.isInteger(n) || n < 0 || n > 2_000_000_000) bad("available_qty", "Available quantity must be a whole number, 0 or more");
    else out.availableQty = n;
  }
  if (c.lead_time_days) {
    const n = Number(c.lead_time_days);
    if (!Number.isInteger(n) || n < 0 || n > 730) bad("lead_time_days", "Lead time must be a whole number of days, 0 to 730");
    else out.leadTimeDays = n;
  }
  return out;
}

export const parseMoq = (raw: string, bad: Bad): number | undefined => {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isInteger(n) || n < 1 || n > 2_000_000_000) {
    bad("moq", "MOQ must be a whole number, 1 or more");
    return undefined;
  }
  return n;
};
