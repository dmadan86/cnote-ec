/**
 * Multi-line RFQ (docs/design/rfq-multiline.md) test data. Seller quoting needs a seller session on the other app, so after the buyer posts
 * a bill of materials through the real UI this writes what the seller flow would have written (per-line quotes) into the `_e2e` database
 * (same guard as rfq-db.ts).
 */
import { seedQuotes, withDb, type SeededQuote } from "./rfq-db";

/**
 * Turns the two seeded quotes into per-line quotes. Supplier A prices every line (1000 / 300 / 80); supplier B skips the last one (a partial
 * quote), is cheaper on line 1 (900) and dearer on line 2 (350). Returns the line ids in order.
 */
export async function seedLineQuotes(enquiryId: string): Promise<{ a: SeededQuote; b: SeededQuote; lineIds: string[] }> {
  const { a, b } = await seedQuotes(enquiryId);
  return withDb(async (c) => {
    const lines = (await c.query("select id, quantity from enquiry_lines where enquiry_id = $1 order by ordinal", [enquiryId])).rows;
    const prices: Record<string, (number | null)[]> = { [a.quoteId]: [1000, 300, 80], [b.quoteId]: [900, 350, null] };
    for (const q of [a, b]) {
      let total = 0;
      let quoted = 0;
      for (const [i, l] of lines.entries()) {
        const p = prices[q.quoteId]![i] ?? null;
        if (p === null) continue;
        const line = p * Number(l.quantity);
        total += line;
        quoted++;
        await c.query(
          `insert into quote_lines (id, quote_id, enquiry_line_id, unit_price_paise, quantity, line_subtotal_paise, line_gst_paise, line_total_paise)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, 0, $5)`,
          [q.quoteId, l.id, p, l.quantity, line],
        );
      }
      await c.query("update quotes set line_subtotal_paise = $2, line_gst_paise = 0, line_total_paise = $2, quoted_line_count = $3 where id = $1", [q.quoteId, total, quoted]);
    }
    return { a, b, lineIds: lines.map((l) => String(l.id)) };
  });
}

export async function lineAwards(enquiryId: string): Promise<{ ordinal: number; seller: string; orderId: string | null }[]> {
  return withDb(async (c) =>
    (await c.query("select ordinal, seller_business_id, order_id from enquiry_line_awards where enquiry_id = $1 order by ordinal", [enquiryId])).rows.map((r) => ({
      ordinal: Number(r.ordinal),
      seller: String(r.seller_business_id),
      orderId: r.order_id ? String(r.order_id) : null,
    })),
  );
}
