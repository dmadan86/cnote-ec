/**
 * Test-only read of the cookie-consent receipts in the isolated `cnote_e2e` database, to prove WHICH app a receipt came from
 * (compliance.cookie_consent_receipts.app). Guarded like prepare-db: it refuses any database whose name does not end in `_e2e`.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { e2eEnv } from "./env";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(q: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ReceiptRow {
  app: string;
  policy_version: number;
  analytics: boolean;
  marketing: boolean;
  functional: boolean;
  action: string;
  registry_hash: string | null;
}

export async function receiptsOf(consentId: string): Promise<ReceiptRow[]> {
  const url = e2eEnv.DATABASE_URL!;
  if (!/_e2e$/.test(new URL(url).pathname.slice(1))) throw new Error("refusing to touch a database that does not end in _e2e");
  const root = path.resolve(__dirname, "../..");
  const { Client } = createRequire(path.join(root, "packages/db/package.json"))("pg") as { Client: new (o: { connectionString: string }) => PgClient };
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query("SELECT app, policy_version, analytics, marketing, functional, action, registry_hash FROM cookie_consent_receipts WHERE consent_id = $1 ORDER BY client_at", [consentId]);
    return r.rows as unknown as ReceiptRow[];
  } finally {
    await c.end();
  }
}
