// DB-level append-only enforcement (security audit M5, migration 20261003000000_append_only_triggers).
// Test databases default `cnote.allow_purge` to on (scripts/allow-test-purge.sh) so suite cleanup can delete; every denial
// test here therefore runs on a client whose sessions start with the setting OFF, i.e. what production sees.
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, prisma, withPurge } from "../src";

const strict = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 2, options: "-c TimeZone=UTC -c cnote.allow_purge=off" }),
});
const tag = `ao-${randomUUID()}`;
let personId: string;
let businessId: string;

const denied = (p: Promise<unknown>) => expect(p).rejects.toThrow(/append-only table/);

beforeAll(async () => {
  expect((await strict.$queryRaw<{ v: string }[]>`SELECT current_setting('cnote.allow_purge', true) AS v`)[0]!.v).toBe("off");
  personId = (await prisma.person.create({ data: { email: `${tag}@example.com` } })).id;
  businessId = (await prisma.business.create({ data: { name: tag } })).id;
});
afterAll(async () => {
  await withPurge(async (tx) => {
    await tx.adminAuditLog.deleteMany({ where: { userAgent: tag } });
    await tx.domainEvent.deleteMany({ where: { aggregateType: tag } });
    await tx.cookieConsentReceipt.deleteMany({ where: { locale: tag } });
    await tx.consent.deleteMany({ where: { personId } });
    await tx.creditLedgerEntry.deleteMany({ where: { businessId } });
  });
  await prisma.business.delete({ where: { id: businessId } });
  await prisma.person.delete({ where: { id: personId } });
  await strict.$disconnect();
});

describe("append-only tables reject ad-hoc UPDATE and DELETE", () => {
  it("admin_audit_log", async () => {
    const row = await strict.adminAuditLog.create({ data: { privilege: "x", action: "a", userAgent: tag } });
    await denied(strict.adminAuditLog.update({ where: { id: row.id }, data: { action: "tampered" } }));
    await denied(strict.adminAuditLog.deleteMany({ where: { id: row.id } }));
    expect((await strict.adminAuditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe("a");
  });

  it("credit_ledger", async () => {
    const row = await strict.creditLedgerEntry.create({ data: { businessId, delta: 5, reason: "grant" } });
    await denied(strict.creditLedgerEntry.update({ where: { id: row.id }, data: { delta: 500 } }));
    await denied(strict.creditLedgerEntry.deleteMany({ where: { id: row.id } }));
  });

  it("consents", async () => {
    const row = await strict.consent.create({ data: { personId, purpose: "marketing", granted: true, source: tag } });
    await denied(strict.consent.update({ where: { id: row.id }, data: { granted: false } }));
    await denied(strict.consent.deleteMany({ where: { id: row.id } }));
  });

  it("ledger_journals and ledger_lines (escrow double-entry)", async () => {
    const acct = await strict.ledgerAccount.create({ data: { code: `${tag}:acct`, kind: "asset", normal: "debit" } });
    const j = await strict.ledgerJournal.create({ data: { key: `${tag}:j`, kind: "fund", memo: "t" } });
    const l = await strict.ledgerLine.create({ data: { journalId: j.id, accountId: acct.id, debitPaise: 1n } });
    await denied(strict.ledgerLine.update({ where: { id: l.id }, data: { debitPaise: 2n } }));
    await denied(strict.ledgerJournal.update({ where: { id: j.id }, data: { memo: "x" } }));
    await denied(strict.ledgerLine.deleteMany({ where: { id: l.id } }));
    await withPurge(async (tx) => {
      await tx.ledgerLine.deleteMany({ where: { id: l.id } });
      await tx.ledgerJournal.deleteMany({ where: { id: j.id } });
    }, strict);
    await strict.ledgerAccount.delete({ where: { id: acct.id } });
  });

  it("TRUNCATE is rejected too", async () => {
    await denied(strict.$executeRawUnsafe("TRUNCATE admin_audit_log"));
    await denied(strict.$executeRawUnsafe("TRUNCATE domain_events"));
  });
});

describe("domain_events: only published_at may change", () => {
  it("allows the outbox relay's published_at stamp, rejects every other update and any delete", async () => {
    const ev = await strict.domainEvent.create({ data: { type: "T", aggregateType: tag, aggregateId: "1", payload: { a: 1 } } });
    await strict.$executeRaw`UPDATE domain_events SET published_at = now() WHERE id = ${ev.id}`;
    await strict.$executeRaw`UPDATE domain_events SET published_at = NULL WHERE id = ${ev.id}`;
    await denied(strict.domainEvent.update({ where: { id: ev.id }, data: { payload: { a: 2 } } }));
    await denied(strict.domainEvent.update({ where: { id: ev.id }, data: { type: "Other" } }));
    await denied(strict.domainEvent.update({ where: { id: ev.id }, data: { occurredAt: new Date(0), publishedAt: new Date() } }));
    await denied(strict.domainEvent.deleteMany({ where: { id: ev.id } }));
    expect((await strict.domainEvent.findUniqueOrThrow({ where: { id: ev.id } })).payload).toEqual({ a: 1 });
  });
});

describe("cookie_consent_receipts: only the DPDP erasure update (person_id -> NULL)", () => {
  const receipt = (consentId: string) => ({ consentId, policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom", locale: tag, personId });
  it("allows nulling person_id, rejects any other change and any delete", async () => {
    const row = await strict.cookieConsentReceipt.create({ data: receipt(randomUUID().replace(/-/g, "")) });
    await denied(strict.cookieConsentReceipt.update({ where: { id: row.id }, data: { marketing: true } }));
    await denied(strict.cookieConsentReceipt.update({ where: { id: row.id }, data: { personId: randomUUID() } }));
    await denied(strict.cookieConsentReceipt.update({ where: { id: row.id }, data: { personId: null, analytics: false } }));
    await denied(strict.cookieConsentReceipt.deleteMany({ where: { id: row.id } }));
    await strict.cookieConsentReceipt.update({ where: { id: row.id }, data: { personId: null } });
    expect((await strict.cookieConsentReceipt.findUniqueOrThrow({ where: { id: row.id } })).personId).toBeNull();
  });
});

describe("retention purges still work", () => {
  it("withPurge allows DELETE inside its transaction and the permission does not leak out of it", async () => {
    const row = await strict.adminAuditLog.create({ data: { privilege: "x", action: "purge-me", userAgent: tag } });
    const removed = await withPurge((tx) => tx.adminAuditLog.deleteMany({ where: { id: row.id } }), strict);
    expect(removed.count).toBe(1);
    const other = await strict.adminAuditLog.create({ data: { privilege: "x", action: "keep", userAgent: tag } });
    await denied(strict.adminAuditLog.deleteMany({ where: { id: other.id } })); // the setting was transaction-local
  });

  it("the cookie-receipt purge shape (DELETE ... WHERE created_at < x inside withPurge) succeeds on a strict session", async () => {
    const id = randomUUID().replace(/-/g, "");
    await strict.cookieConsentReceipt.create({ data: { consentId: id, policyVersion: 1, analytics: false, marketing: false, gpc: false, action: "reject_all", locale: tag, createdAt: new Date("2020-01-01") } });
    const n = await withPurge(async (tx) => (await tx.cookieConsentReceipt.deleteMany({ where: { consentId: id, createdAt: { lt: new Date("2021-01-01") } } })).count, strict);
    expect(n).toBe(1);
  });
});

describe("migration is registered", () => {
  it("every guarded table has its trigger", async () => {
    const rows = await prisma.$queryRaw<{ t: string }[]>`
      SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 'cnote_append_only' AND NOT g.tgisinternal`;
    expect(rows.map((r) => r.t).sort()).toEqual(
      ["ad_wallet_ledger", "admin_audit_log", "consents", "cookie_consent_receipts", "credit_ledger", "domain_events", "ledger_journals", "ledger_lines"].sort(),
    );
  });
});
