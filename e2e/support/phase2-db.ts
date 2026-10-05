/**
 * Test-only data helper for the Phase-2/3 buyer screens (orders, disputes, agent mandates and negotiations). Those need a
 * seller session or a worker run to create rows through the UI, so, like rfq-db.ts, this writes what the flows would have
 * written straight into the isolated `*_e2e` database. Refuses any database whose name does not end in `_e2e`.
 * Everything is fictional test data.
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

export interface Principal {
  personId: string;
  businessId: string;
}

async function principalOf(c: PgClient, email: string): Promise<Principal> {
  const r = (await c.query("select p.id as person_id, m.business_id from persons p join business_members m on m.person_id = p.id where p.email = $1 limit 1", [email.toLowerCase()])).rows[0];
  if (!r) throw new Error(`no business for ${email}`);
  return { personId: String(r.person_id), businessId: String(r.business_id) };
}

async function otherSeller(c: PgClient, buyerBusinessId: string): Promise<string> {
  const r = (await c.query("select id from businesses where is_seller and id <> $1 order by trust_score desc, id limit 1", [buyerBusinessId])).rows[0];
  if (!r) throw new Error("e2e seed has no seller business");
  return String(r.id);
}

export type OrderStatus = "recorded" | "confirmed" | "dispatched" | "delivered" | "completed" | "cancelled";

/** An off-platform order for the buyer with the given email, with a quantity, price and (for `dispatched`+) a tracking stage. */
export async function seedOrder(email: string, opts: { status?: OrderStatus; settlement?: "off_platform" | "escrow" } = {}): Promise<{ orderId: string; sellerBusinessId: string } & Principal> {
  return withDb(async (c) => {
    const me = await principalOf(c, email);
    const seller = await otherSeller(c, me.businessId);
    const status = opts.status ?? "recorded";
    const stage = status === "dispatched" ? "in_transit" : null;
    const o = (
      await c.query(
        `insert into orders (id, buyer_business_id, seller_business_id, settlement, status, price_paise, quantity, unit, total_paise, buyer_confirmed_at, fulfilment_stage, fulfilment_updated_at, tracking_courier, tracking_ref, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4::order_status, 54000, 500, 'pcs', 27000000, now(), $5::fulfilment_stage, case when $5::text is null then null else now() end, case when $5::text is null then null else 'BlueDart' end, case when $5::text is null then null else 'AWB123456' end, now()) returning id`,
        [me.businessId, seller, opts.settlement ?? "off_platform", status, stage],
      )
    ).rows[0]!;
    if (stage) {
      await c.query("insert into order_fulfilment_events (id, order_id, stage, note, courier, tracking_ref, actor_business_id) values (gen_random_uuid(), $1, 'packed', 'Packed and labelled', null, null, $2), (gen_random_uuid(), $1, 'in_transit', null, 'BlueDart', 'AWB123456', $2)", [o.id, seller]);
    }
    return { ...me, orderId: String(o.id), sellerBusinessId: seller };
  });
}

/** An open dispute the buyer raised on `orderId` (the buyer can respond with evidence and messages, and withdraw it). */
export async function seedDispute(email: string, orderId: string): Promise<{ disputeId: string }> {
  return withDb(async (c) => {
    const me = await principalOf(c, email);
    const o = (await c.query("select seller_business_id from orders where id = $1", [orderId])).rows[0]!;
    const d = (
      await c.query(
        `insert into disputes (id, order_id, opened_by_business_id, opened_by_person_id, against_business_id, opened_by_role, type, status, description, language, amount_paise, at_stake_paise, active_order_id, due_at, response_due_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4, 'buyer', 'damaged', 'open', 'Cartons arrived crushed on two corners.', 'en', 5400000, 27000000, $1, now() + interval '7 days', now() + interval '3 days', now()) returning id`,
        [orderId, me.businessId, me.personId, o.seller_business_id],
      )
    ).rows[0]!;
    await c.query(
      "insert into dispute_evidence (id, dispute_id, party, submitted_by_business_id, submitted_by_person_id, kind, text, source) values (gen_random_uuid(), $1, 'buyer', $2, $3, 'statement', 'Photos to follow.', 'upload')",
      [d.id, me.businessId, me.personId],
    );
    await c.query("insert into dispute_messages (id, dispute_id, party_business_id, author_type, author_person_id, body) values (gen_random_uuid(), $1, $2, 'buyer', $3, 'Please look at this.')", [d.id, me.businessId, me.personId]);
    return { disputeId: String(d.id) };
  });
}

/** A standing buyer agent mandate (with its consent timestamp) and the audit row the page lists. */
export async function seedMandate(email: string): Promise<{ mandateId: string }> {
  return withDb(async (c) => {
    const me = await principalOf(c, email);
    const m = (
      await c.query(
        `insert into agent_mandate (id, business_id, side, status, name, created_by_person_id, spec, quantity, unit, target_price_paise, limit_price_paise, max_lead_time_days, consented_at, updated_at)
         values (gen_random_uuid(), $1, 'buyer', 'active', 'Corrugated boxes monthly', $2, '{"title":"3 ply corrugated boxes","requirement":"12x10x8 inch, printed logo","deliveryCity":"Pune"}'::jsonb, 500, 'pcs', 55000, 62000, 21, now(), now()) returning id`,
        [me.businessId, me.personId],
      )
    ).rows[0]!;
    await c.query("insert into agent_mandate_change (id, mandate_id, business_id, version, action, actor_kind, actor_person_id) values (gen_random_uuid(), $1, $2, 1, 'created', 'human', $3)", [m.id, me.businessId, me.personId]);
    return { mandateId: String(m.id) };
  });
}

/** A negotiation the two agents have agreed on, waiting for the buyer's confirmation (the "needs you" state). */
export async function seedNegotiation(email: string, mandateId: string): Promise<{ negotiationId: string }> {
  return withDb(async (c) => {
    const me = await principalOf(c, email);
    const seller = await otherSeller(c, me.businessId);
    const terms = JSON.stringify({ by: "seller", pricePaise: 56000, quantity: 500, unit: "pcs", leadTimeDays: 14, deliveryTerms: "Ex-works Pune", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), paymentTerms: "net_30" });
    const n = (
      await c.query(
        `insert into agent_negotiation (id, buyer_business_id, seller_business_id, buyer_mandate_id, seller_mandate_id, enquiry_id, match_id, initiated_by, status, round, max_rounds, turn, buyer_private, seller_private, last_offer, agreed_terms, agreed_price_paise, buyer_confirmation, seller_confirmation, expires_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'buyer', 'agreed', 2, 6, null, '{}'::jsonb, '{}'::jsonb, $4::jsonb, $4::jsonb, 56000, 'pending', 'human', now() + interval '3 days', now()) returning id`,
        [me.businessId, seller, mandateId, terms],
      )
    ).rows[0]!;
    await c.query(
      `insert into agent_message (id, negotiation_id, seq, side, type, price_paise, quantity, terms, idempotency_key, actor_kind)
       values (gen_random_uuid(), $1, 1, 'buyer', 'offer', 55000, 500, '{"unit":"pcs","leadTimeDays":21,"validUntil":"2099-01-01"}'::jsonb, 'k1', 'internal_agent'),
              (gen_random_uuid(), $1, 2, 'seller', 'counter', 56000, 500, '{"unit":"pcs","leadTimeDays":14,"validUntil":"2099-01-01"}'::jsonb, 'k2', 'internal_agent')`,
      [n.id],
    );
    await c.query("insert into agent_activity (id, principal_business_id, principal_side, action, mandate_id, negotiation_id, summary) values (gen_random_uuid(), $1, 'buyer', 'negotiation_agreed', $2, $3, 'Your agent agreed terms with the seller.')", [me.businessId, mandateId, n.id]);
    return { negotiationId: String(n.id) };
  });
}

// ---- purchase orders / supplier invoices (docs/design/purchase-orders.md) -------------------------------------------------------

/**
 * A delivered order for the buyer with an accepted purchase order (one line, intra-state) and two supplier invoices from a
 * declared micro/small seller: one overdue with an e-invoice (IRN + signed QR) and an e-way bill, one due in 5 days.
 * Also saves a default delivery address for the buyer.
 */
export async function seedPurchaseOrder(email: string): Promise<{ orderId: string; purchaseOrderId: string; overdueInvoiceId: string; openInvoiceId: string } & Principal> {
  return withDb(async (c) => {
    const me = await principalOf(c, email);
    const seller = await otherSeller(c, me.businessId);
    await c.query("update businesses set udyam = coalesce(udyam, 'UDYAM-MH-01-0000001'), msme_category = 'small', msme_declared_at = now() where id = $1", [seller]);
    await c.query(
      "insert into business_addresses (id, business_id, label, line1, city, state, state_code, pincode, is_default, updated_at) values (gen_random_uuid(), $1, 'Warehouse', '12 Industrial Area', 'Pune', 'Maharashtra', '27', '411001', true, now())",
      [me.businessId],
    );
    const o = (
      await c.query(
        `insert into orders (id, buyer_business_id, seller_business_id, status, price_paise, quantity, unit, total_paise, buyer_confirmed_at, seller_confirmed_at, delivered_at, updated_at)
         values (gen_random_uuid(), $1, $2, 'delivered', 25000, 100, 'pcs', 2500000, now(), now(), now() - interval '50 days', now()) returning id`,
        [me.businessId, seller],
      )
    ).rows[0]!;
    const fy = "2026-27";
    await c.query("insert into purchase_order_sequences (buyer_business_id, financial_year, last_number) values ($1, $2, 1)", [me.businessId, fy]);
    const po = (
      await c.query(
        "insert into purchase_orders (id, order_id, buyer_business_id, seller_business_id, number, financial_year, status, current_version, updated_at) values (gen_random_uuid(), $1, $2, $3, 'PO/26-27/000001', $4, 'acknowledged', 1, now()) returning id",
        [o.id, me.businessId, seller, fy],
      )
    ).rows[0]!;
    const party = (name: string) => JSON.stringify({ name, legalName: null, gstin: null, stateCode: "27" });
    const v = (
      await c.query(
        `insert into purchase_order_versions (id, purchase_order_id, version, payment_terms_days, expected_delivery, buyer, seller, delivery_address, place_of_supply, intra_state, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, created_by_person_id)
         values (gen_random_uuid(), $1, 1, 30, current_date + 7, $2::jsonb, $3::jsonb, $4::jsonb, '27', true, 2500000, 225000, 225000, 0, 2950000, $5) returning id`,
        [po.id, party("E2E buyer"), party("E2E seller"), JSON.stringify({ label: "Warehouse", contactName: null, phone: null, line1: "12 Industrial Area", line2: null, city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411001" }), me.personId],
      )
    ).rows[0]!;
    await c.query(
      "insert into purchase_order_lines (id, version_id, line_no, description, hsn, quantity, unit, unit_price_paise, price_includes_gst, gst_rate_bps, taxable_paise, tax_paise, total_paise) values (gen_random_uuid(), $1, 1, 'Corrugated boxes', '4819', 100, 'pcs', 25000, false, 1800, 2500000, 450000, 2950000)",
      [v.id],
    );
    await c.query("insert into purchase_order_acks (id, version_id, decision, by_person_id) values (gen_random_uuid(), $1, 'accepted', $2)", [v.id, me.personId]);
    const inv = async (number: string, invoiceDaysAgo: number, due: string, extra: { irn?: string; qr?: string; ewb?: string } = {}) =>
      String(
        (
          await c.query(
            `insert into supplier_invoices (id, purchase_order_id, po_version, order_id, buyer_business_id, seller_business_id, invoice_number, invoice_date, financial_year, taxable_paise, gst_paise, total_paise,
               irn, ack_no, ack_date, signed_qr, e_invoice_check, ewb_no, ewb_valid_until, msme_covered, agreement_basis, agreed_days, due_basis, acceptance_date, due_date, recorded_by_person_id, updated_at)
             values (gen_random_uuid(), $1, 1, $2, $3, $4, $5, current_date - $6::int, $7, 1000000, 180000, 1180000,
               $8, case when $8::text is null then null else '112010000012345' end, case when $8::text is null then null else now() end, $9, case when $8::text is null then null else 'unchecked' end, $10, case when $10::text is null then null else now() + interval '2 days' end,
               true, 'written_agreement', 30, 'delivery', current_date - 50, current_date + $11::int, $12, now()) returning id`,
            [po.id, o.id, me.businessId, seller, number, invoiceDaysAgo, fy, extra.irn ?? null, extra.qr ?? null, extra.ewb ?? null, Number(due), me.personId],
          )
        ).rows[0]!.id,
      );
    const overdue = await inv("INV/26-27/001", 45, "-20", { irn: "a".repeat(64), qr: "eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoie30ifQ.c2ln", ewb: "123456789012" });
    const open = await inv("INV/26-27/002", 2, "5");
    return { ...me, orderId: String(o.id), purchaseOrderId: String(po.id), overdueInvoiceId: overdue, openInvoiceId: open };
  });
}
