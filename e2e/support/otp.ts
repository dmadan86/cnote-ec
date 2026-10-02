/**
 * Test-only: the app never returns a one-time code in a production build (OTP_DEV_ECHO is ignored when
 * NODE_ENV=production, which `next start` always is), so a journey that needs to finish phone verification plants a
 * known code for the person in the isolated e2e Redis, exactly where requestPhoneOtp stores it (HMAC digest only).
 * Guarded like consent-db.ts: refuses any database whose name does not end in `_e2e`.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { e2eEnv } from "./env";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(q: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
interface RedisClient {
  hset(key: string, v: Record<string, string | number>): Promise<unknown>;
  expire(key: string, s: number): Promise<unknown>;
  quit(): Promise<unknown>;
}

const root = path.resolve(__dirname, "../..");
const e164 = (p: string) => (/^[6-9]\d{9}$/.test(p) ? `+91${p}` : p);

export async function plantPhoneOtp(email: string, phone: string, code = "424242"): Promise<string> {
  const url = e2eEnv.DATABASE_URL!;
  if (!/_e2e$/.test(new URL(url).pathname.slice(1))) throw new Error("refusing to touch a database that does not end in _e2e");
  const { Client } = createRequire(path.join(root, "packages/db/package.json"))("pg") as { Client: new (o: { connectionString: string }) => PgClient };
  const c = new Client({ connectionString: url });
  await c.connect();
  let personId: string;
  try {
    const r = await c.query("SELECT id FROM persons WHERE email = $1", [email.toLowerCase()]);
    if (!r.rows[0]) throw new Error(`no person for ${email}`);
    personId = String(r.rows[0].id);
  } finally {
    await c.end();
  }
  const key = Buffer.from(hkdfSync("sha256", e2eEnv.JWT_SECRET!, "cnote-jwt", "realm:web", 32));
  const hash = createHmac("sha256", key).update(`${personId}:${e164(phone)}:${code}`).digest("hex");
  const Redis = createRequire(path.join(root, "packages/core/package.json"))("ioredis") as new (u: string) => RedisClient;
  const redis = new Redis(e2eEnv.REDIS_URL!);
  try {
    await redis.hset(`otp:${personId}`, { phone: e164(phone), hash, attempts: 0 });
    await redis.expire(`otp:${personId}`, 600);
  } finally {
    await redis.quit();
  }
  return code;
}
