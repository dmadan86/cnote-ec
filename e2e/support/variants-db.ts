/**
 * Test-only data helper for the variant/stock specs (docs/design/variants-stock.md). The buyer-web specs have no seller session, so
 * this clones a seeded live listing straight into the isolated `cnote_live_e2e` read database with variants and stock set, exactly
 * the shape the catalogue publisher writes (live_listings.variants / variant_axes / variant_values / availability). A brand-new id
 * is used on purpose: the PDP and listing caches never saw it, so there is nothing stale to purge.
 * Guarded like rfq-db: refuses any database whose name does not end in `_e2e`.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { e2eEnv } from "./env";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(q: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

async function withLiveDb<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
  const url = e2eEnv.LIVE_DATABASE_URL!;
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

const v = (sku: string, size: string, colour: string, extra: Record<string, unknown>, sortOrder: number) => ({
  id: randomUUID(), sku, axisValues: { size, colour }, pricePaise: null, priceTiers: [], moq: null, availability: "in_stock", availableQty: null, leadTimeDays: null, imageId: null, sortOrder, ...extra,
});

export interface SeededVariantListing {
  id: string;
  title: string;
  /** relative product URL (the page redirects to the canonical slug) */
  href: (locale?: "en" | "hi") => string;
  skus: { inStock: string; madeToOrder: string; outOfStock: string };
}

/**
 * A listing with a Size x Colour matrix: M/Red in stock (own price), L/Red made to order (14 days), L/Blue out of stock,
 * M/Blue in stock. Cloned from any live listing so the seller card, images and category all exist.
 */
export async function seedVariantListing(): Promise<SeededVariantListing> {
  const id = randomUUID();
  const title = `Variant Tee ${id.slice(0, 6)}`;
  const variants = [
    v("TEE-M-RED", "M", "Red", { pricePaise: 45_000, priceTiers: [{ minQty: 50, pricePaise: 42_000 }], moq: 10, availableQty: 120 }, 0),
    v("TEE-M-BLUE", "M", "Blue", {}, 1),
    v("TEE-L-RED", "L", "Red", { availability: "made_to_order", leadTimeDays: 14 }, 2),
    v("TEE-L-BLUE", "L", "Blue", { availability: "out_of_stock" }, 3),
  ];
  await withLiveDb(async (c) => {
    await c.query("create temp table clone_src as select * from live_listings where price_paise is not null order by id limit 1");
    await c.query(
      `update clone_src set id = $1::uuid, title = $2, version_id = gen_random_uuid(), availability = 'in_stock', available_qty = null,
         stock_updated_at = now(), variant_axes = $3::jsonb, variants = $4::jsonb, variant_values = $5::text[]`,
      [
        id,
        title,
        JSON.stringify([{ key: "size", label: "Size" }, { key: "colour", label: "Colour" }]),
        JSON.stringify(variants),
        ["colour:blue", "colour:red", "size:l", "size:m"],
      ],
    );
    // search_tsv is a GENERATED column: copy everything else
    const cols = (await c.query("select column_name from information_schema.columns where table_name = 'live_listings' and column_name <> 'search_tsv' order by ordinal_position")).rows.map((r) => `"${String(r.column_name)}"`).join(", ");
    await c.query(`insert into live_listings (${cols}) select ${cols} from clone_src`);
    await c.query("drop table clone_src");
  });
  return {
    id,
    title,
    href: (locale = "en") => `${locale === "hi" ? "/hi" : ""}/p/variant-tee-${id}`,
    skus: { inStock: "TEE-M-RED", madeToOrder: "TEE-L-RED", outOfStock: "TEE-L-BLUE" },
  };
}

export async function removeVariantListing(id: string): Promise<void> {
  await withLiveDb(async (c) => void (await c.query("delete from live_listings where id = $1::uuid", [id])));
}
