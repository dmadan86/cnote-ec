/**
 * Test-only data helper for the RFQ/quote specs: a seller's quote needs a seller session on the other app, which the
 * buyer-web specs do not have. So after the buyer posts a requirement through the real UI, this writes what the seller
 * flow would have written (accepted match, conversation, quotes) straight into the isolated `cnote_e2e` database.
 * Guarded like prepare-db: it refuses any database whose name does not end in `_e2e`.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { e2eEnv } from "./env";

type Row = Record<string, unknown>;
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(q: string, p?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

async function withDb<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
  const url = e2eEnv.DATABASE_URL!;
  if (!/_e2e$/.test(new URL(url).pathname.slice(1))) throw new Error("refusing to touch a database that does not end in _e2e");
  const root = path.resolve(__dirname, "../..");
  const { Client } = createRequire(path.join(root, "packages/db/package.json"))("pg") as { Client: new (o: { connectionString: string }) => PgClient };
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export interface SeededQuote {
  sellerName: string;
  quoteId: string;
  pricePaise: number;
  leadTimeDays: number;
}

/** Two accepted suppliers with different quotes: A is dearer but faster, B is cheaper but slower. */
export async function seedQuotes(enquiryId: string): Promise<{ a: SeededQuote; b: SeededQuote; sentTo: number }> {
  return withDb(async (c) => {
    const existing = (await c.query("select id, seller_business_id, rank from matches where enquiry_id = $1 order by rank", [enquiryId])).rows;
    if (existing.length < 2) {
      const extra = (
        await c.query(
          `select id from businesses where is_seller and id <> all($1::uuid[]) and id <> (select buyer_business_id from enquiries where id = $2) order by trust_score desc, id limit $3`,
          [existing.map((r) => r.seller_business_id), enquiryId, 2 - existing.length],
        )
      ).rows;
      let rank = existing.reduce((m, r) => Math.max(m, Number(r.rank)), 0);
      for (const e of extra) {
        await c.query(
          "insert into matches (id, enquiry_id, seller_business_id, rank, match_score, status, respond_by) values (gen_random_uuid(), $1, $2, $3, 0.7, 'offered', now() + interval '2 hours')",
          [enquiryId, e.id, ++rank],
        );
      }
    }
    const matches = (await c.query("select id, seller_business_id from matches where enquiry_id = $1 order by rank limit 2", [enquiryId])).rows;
    if (matches.length < 2) throw new Error("e2e seed has fewer than two sellers to quote with");
    const sentTo = Number((await c.query("select count(*)::int as n from matches where enquiry_id = $1", [enquiryId])).rows[0]!.n);
    const specs = [
      { price: 62000, lead: 14, terms: "net_15", notes: "Includes printing and tooling" },
      { price: 54000, lead: 21, terms: "net_30", notes: null },
    ];
    const out: SeededQuote[] = [];
    for (const [i, m] of matches.entries()) {
      const s = specs[i]!;
      await c.query("update matches set status = 'accepted', responded_at = now() where id = $1", [m.id]);
      const convo = (await c.query("insert into conversations (id, match_id) values (gen_random_uuid(), $1) on conflict (match_id) do update set match_id = excluded.match_id returning id", [m.id])).rows[0]!;
      const q = (
        await c.query(
          `insert into quotes (id, conversation_id, seller_business_id, price_paise, quantity, unit, lead_time_days, notes, valid_until, payment_terms)
           values (gen_random_uuid(), $1, $2, $3, 500, 'pcs', $4, $5, current_date + 30, $6) returning id`,
          [convo.id, m.seller_business_id, s.price, s.lead, s.notes, s.terms],
        )
      ).rows[0]!;
      const name = String((await c.query("select name from businesses where id = $1", [m.seller_business_id])).rows[0]!.name);
      out.push({ sellerName: name, quoteId: String(q.id), pricePaise: s.price, leadTimeDays: s.lead });
    }
    return { a: out[0]!, b: out[1]!, sentTo };
  });
}

export async function dealReports(enquiryId: string): Promise<{ outcome: string; valuePaise: number | null }[]> {
  return withDb(async (c) =>
    (await c.query("select d.outcome, d.value_paise from deal_reports d join matches m on m.id = d.match_id where m.enquiry_id = $1 order by d.created_at", [enquiryId])).rows.map((r) => ({
      outcome: String(r.outcome),
      valuePaise: r.value_paise === null ? null : Number(r.value_paise),
    })),
  );
}
