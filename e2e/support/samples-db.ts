/**
 * Test-only data helper for the samples spec: the seller side lives in another app, so this writes what the seller flow would have
 * written (accepted / dispatched / delivered sample requests) straight into the isolated `cnote_e2e` database. Guarded like
 * rfq-db.ts: it refuses any database whose name does not end in `_e2e`.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { e2eEnv } from "./env";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(q: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
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

export type SeededStatus = "requested" | "accepted" | "dispatched" | "delivered";

/** One sample request from the buyer (found by account email) to the first seller in the seed, at the given stage. Returns its id. */
export async function seedSample(buyerEmail: string, status: SeededStatus, subject = "Kraft carton 5-ply"): Promise<string> {
  return withDb(async (c) => {
    const buyer = (
      await c.query(
        "select p.id as person_id, m.business_id from persons p join business_members m on m.person_id = p.id where p.email = $1 limit 1",
        [buyerEmail],
      )
    ).rows[0];
    if (!buyer) throw new Error(`no buyer for ${buyerEmail}`);
    const seller = (await c.query("select id from businesses where is_seller and id <> $1 order by trust_score desc, id limit 1", [buyer.business_id])).rows[0]!;
    const row = (
      await c.query(
        `insert into sample_requests (id, buyer_business_id, buyer_person_id, seller_business_id, subject, quantity, unit, status, ship_name, ship_line1, ship_city, ship_pincode,
           respond_by, active_key, courier, tracking_ref, dispatched_at, delivered_at, delivered_by)
         values (gen_random_uuid(), $1, $2, $3, $4, 3, 'piece', $5::sample_status, 'E2E Receiver', '12 MG Road', 'Pune', '411001',
           now() + interval '48 hours', $6, $7, $8, $9, $10, $11) returning id`,
        [
          buyer.business_id, buyer.person_id, seller.id, subject, status, `${buyer.business_id}:e2e:${Math.random()}`,
          status === "dispatched" || status === "delivered" ? "Delhivery" : null, status === "dispatched" || status === "delivered" ? "DL1234" : null,
          status === "dispatched" || status === "delivered" ? new Date() : null, status === "delivered" ? new Date() : null, status === "delivered" ? "buyer" : null,
        ],
      )
    ).rows[0]!;
    const id = String(row.id);
    await c.query("insert into sample_status_log (id, sample_id, status, actor) values (gen_random_uuid(), $1, $2::sample_status, 'buyer')", [id, status]);
    return id;
  });
}
