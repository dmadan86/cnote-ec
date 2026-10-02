/**
 * Seeds sellers on a paid ANNUAL plan for the cancel-flow spec (e2e/functional/seller-billing.spec.ts).
 * Cancelling mutates the account, so there is one per attempt (the spec picks by `testInfo.retry`), and this script
 * resets all of them on every run. Each one has a fulfilled mock PaymentOrder behind its subscription, so the
 * confirm screen shows a real pro-rated refund. Same loader pattern as backfill-live.ts; run with the e2e env exported.
 * ADR-005. Everything here is fictional test data in the isolated e2e databases.
 */
import { createRequire } from "node:module";
import { createHash, randomBytes, scrypt as scryptCb } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BILLING_E2E_ACCOUNTS, BILLING_E2E_PASSWORD, BILLING_E2E_UNDO_ACCOUNTS, E2E_PAID_TOTAL_PAISE, billingE2eEmail, billingUndoEmail } from "../support/billing";

const req = createRequire(path.resolve(__dirname, "../../apps/worker/package.json"));
const load = <T>(id: string) => import(pathToFileURL(req.resolve(id)).href) as Promise<T>;
const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const stableId = (name: string) => {
  const h = createHash("sha1").update(`cnote-e2e-billing:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
};
async function hashPassword(password: string): Promise<string> {
  const N = 16384, R = 8, P = 1;
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N, r: R, p: P, maxmem: 256 * N * R });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

type Prisma = { person: any; business: any; businessMember: any; subscription: any; paymentOrder: any; paymentRefund: any; creditLedgerEntry: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function main() {
  const { prisma } = await load<{ prisma: Prisma }>("@cnote/db");
  const billing = await load<{ seedPlans(): Promise<void>; grantCredits(b: string, n: number, reason: string, ref: { refType: string; refId: string }): Promise<string> }>("@cnote/billing");
  await billing.seedPlans();
  const hash = await hashPassword(BILLING_E2E_PASSWORD);
  const DAY = 86_400_000;
  const accounts = [
    ...Array.from({ length: BILLING_E2E_ACCOUNTS }, (_, n) => ({ n, email: billingE2eEmail(n), annual: true })),
    ...Array.from({ length: BILLING_E2E_UNDO_ACCOUNTS }, (_, n) => ({ n: 100 + n, email: billingUndoEmail(n), annual: false })),
  ];
  for (const { n, email, annual } of accounts) {
    const personId = stableId(`person:${n}`);
    const businessId = stableId(`business:${n}`);
    await prisma.person.upsert({ where: { email }, update: { passwordHash: hash }, create: { id: personId, email, emailVerifiedAt: new Date(), name: `Billing E2E ${n}`, passwordHash: hash } });
    const person = await prisma.person.findUnique({ where: { email }, select: { id: true } });
    const biz = { name: `Billing E2E Works ${n}`, city: "Pune", state: "Maharashtra", pincode: "411001", isSeller: true, isBuyer: false, languages: ["en"] };
    await prisma.business.upsert({ where: { id: businessId }, update: biz, create: { id: businessId, ...biz } });
    await prisma.businessMember.upsert({ where: { businessId_personId: { businessId, personId: person.id } }, update: {}, create: { businessId, personId: person.id, role: "owner" } });

    // reset, then recreate the paid annual period
    const orders = (await prisma.paymentOrder.findMany({ where: { businessId }, select: { id: true } })).map((o: { id: string }) => o.id);
    await prisma.paymentRefund.deleteMany({ where: { paymentOrderId: { in: orders } } });
    await prisma.subscription.deleteMany({ where: { businessId } });
    await prisma.paymentOrder.deleteMany({ where: { businessId } });
    await prisma.creditLedgerEntry.deleteMany({ where: { businessId } });

    if (!annual) {
      // monthly Starter, nothing paid through us: cancelling refunds nothing, so the cancellation can be undone
      const now = new Date();
      const sub = await prisma.subscription.create({ data: { businessId, planCode: "starter", status: "active", periodStart: now, periodEnd: new Date(now.getTime() + 30 * DAY), autoRenew: false, billingInterval: "monthly" } });
      await billing.grantCredits(businessId, 60, "plan:starter", { refType: "subscription", refId: sub.id });
      continue;
    }
    const orderId = stableId(`order:${n}`);
    await prisma.paymentOrder.create({
      data: { id: orderId, businessId, purpose: "subscription", purposeRef: "starter:annual", provider: "mock", status: "paid", amountPaise: 959_040n, gstPaise: 172_627n, totalPaise: BigInt(E2E_PAID_TOTAL_PAISE), fulfilledAt: new Date() },
    });
    const start = new Date(Date.now() - 40 * DAY);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 12);
    const sub = await prisma.subscription.create({
      data: { businessId, planCode: "starter", status: "active", periodStart: start, periodEnd: end, autoRenew: false, billingInterval: "annual", paymentOrderId: orderId, nextGrantAt: new Date(Date.now() + 20 * DAY) },
    });
    await billing.grantCredits(businessId, 60, "plan:starter", { refType: "subscription", refId: sub.id });
  }
  console.log(`[e2e] seeded ${accounts.length} paid-plan sellers for the cancel flow`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
