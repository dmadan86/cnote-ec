// DPDP Rules 2025 r.8 / Third Schedule: 48-hour notice before an inactive account is erased.
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import { executeInactivityErasures, MIN_NOTICE_HOURS, noticePeriodMs, RETENTION_POLICIES, runInactivityErasure, runRetention, sendInactivityNotices } from "../src";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WINDOW = 1095 * DAY;
const ON = { INACTIVITY_ERASURE_ENABLED: "true" } as NodeJS.ProcessEnv;

/** A real moment: the test DB is shared, and only people backdated years ago can be candidates. */
const now = () => new Date();

async function person(o: { ageDays?: number; lastActiveDays?: number | null; email?: string | null; seller?: boolean; staff?: boolean; session?: boolean } = {}) {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - (o.ageDays ?? 1500) * DAY);
  await prisma.person.create({
    data: {
      id,
      email: o.email === null ? null : (o.email ?? `inact-${id.slice(0, 8)}@example.com`),
      createdAt,
      lastActiveAt: o.lastActiveDays == null ? null : new Date(Date.now() - o.lastActiveDays * DAY),
    },
  });
  if (o.seller) {
    const b = await prisma.business.create({ data: { name: `Seller ${id.slice(0, 6)}`, isSeller: true } });
    await prisma.businessMember.create({ data: { businessId: b.id, personId: id, role: "owner" } });
  }
  if (o.staff) await prisma.staffMember.create({ data: { personId: id, roles: ["support"] } });
  if (o.session) {
    await prisma.authSession.create({ data: { personId: id, refreshTokenHash: `h-${randomUUID()}`, expiresAt: new Date(Date.now() + DAY) } });
  }
  return id;
}
const notices = (personId: string) => prisma.inactivityErasureNotice.findMany({ where: { personId } });
const events = (personId: string) => prisma.domainEvent.findMany({ where: { type: "InactivityErasureNoticeSent", aggregateId: personId } });

describe("notice period", () => {
  it("is never below the statutory 48 hours, whatever the env says", () => {
    expect(MIN_NOTICE_HOURS).toBe(48);
    expect(noticePeriodMs({ INACTIVITY_NOTICE_HOURS: "1" })).toBe(48 * HOUR);
    expect(noticePeriodMs({ INACTIVITY_NOTICE_HOURS: "72" })).toBe(72 * HOUR);
    expect(noticePeriodMs({})).toBe(168 * HOUR);
  });
});

describe("sendInactivityNotices", () => {
  it("notices an inactive buyer-side account once, with erasure at least 48h away, and emits the event", async () => {
    const id = await person();
    const t = now();
    await sendInactivityNotices({ now: t, windowMs: WINDOW, env: { INACTIVITY_NOTICE_HOURS: "1" } });
    await sendInactivityNotices({ now: t, windowMs: WINDOW });
    const rows = await notices(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.eraseAfter.getTime() - rows[0]!.noticedAt.getTime()).toBeGreaterThanOrEqual(48 * HOUR);
    const ev = await events(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ personId: id, noticeId: rows[0]!.id });
  });
  it("skips recent, seller, staff, e-mail-less and signed-in accounts, and one that came back recently", async () => {
    const skipped = [
      await person({ ageDays: 10 }),
      await person({ lastActiveDays: 30 }),
      await person({ seller: true }),
      await person({ staff: true }),
      await person({ email: null }),
      await person({ session: true }),
    ];
    await sendInactivityNotices({ now: now(), windowMs: WINDOW });
    for (const id of skipped) expect(await notices(id), id).toHaveLength(0);
  });
  it("does nothing on a dry run but still counts", async () => {
    const id = await person();
    const n = await sendInactivityNotices({ now: now(), windowMs: WINDOW, dryRun: true });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await notices(id)).toHaveLength(0);
  });
});

describe("executeInactivityErasures", () => {
  const mkNotice = async (id: string, o: { noticedHoursAgo: number; eraseInHours: number }) =>
    prisma.inactivityErasureNotice.create({
      data: { personId: id, lastActiveAt: new Date(Date.now() - 1500 * DAY), noticedAt: new Date(Date.now() - o.noticedHoursAgo * HOUR), eraseAfter: new Date(Date.now() + o.eraseInHours * HOUR) },
    });

  it("never erases before the waiting period is over", async () => {
    const id = await person();
    await mkNotice(id, { noticedHoursAgo: 1, eraseInHours: 100 });
    await executeInactivityErasures({ now: now() });
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    expect((await notices(id))[0]!.status).toBe("pending");
  });
  it("erases through erasePerson once the period is over and the person did not come back", async () => {
    const id = await person();
    const n = await mkNotice(id, { noticedHoursAgo: 200, eraseInHours: -1 });
    const r = await executeInactivityErasures({ now: now() });
    expect(r.erased).toBeGreaterThanOrEqual(1);
    const p = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(p.erasedAt).not.toBeNull();
    expect(p.email).toBeNull();
    const done = await prisma.inactivityErasureNotice.findUniqueOrThrow({ where: { id: n.id } });
    expect(done).toMatchObject({ status: "erased", resolution: "erased" });
    expect(await prisma.domainEvent.count({ where: { type: "DataErasureRequested", aggregateId: id } })).toBe(1);
  });
  it("cancels when the person signed in after the notice", async () => {
    const id = await person();
    const n = await mkNotice(id, { noticedHoursAgo: 200, eraseInHours: -1 });
    await prisma.person.update({ where: { id }, data: { lastActiveAt: new Date(Date.now() - 2 * HOUR) } });
    await executeInactivityErasures({ now: now() });
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    expect(await prisma.inactivityErasureNotice.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ status: "cancelled", resolution: "activity_since_notice" });
  });
  it("cancels when an API key was used after the notice", async () => {
    const id = await person();
    const n = await mkNotice(id, { noticedHoursAgo: 200, eraseInHours: -1 });
    await prisma.apiKey.create({ data: { personId: id, name: "k", prefix: `ck_t_${randomUUID().slice(0, 8)}`, secretHash: randomUUID(), scopes: ["profile:read"], lastUsedAt: new Date(Date.now() - HOUR) } });
    await executeInactivityErasures({ now: now() });
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    expect((await prisma.inactivityErasureNotice.findUniqueOrThrow({ where: { id: n.id } })).resolution).toBe("api_activity_since_notice");
  });
  it("cancels when the person became a seller or staff meanwhile", async () => {
    const id = await person();
    const n = await mkNotice(id, { noticedHoursAgo: 200, eraseInHours: -1 });
    await prisma.staffMember.create({ data: { personId: id, roles: ["support"] } });
    await executeInactivityErasures({ now: now() });
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    expect((await prisma.inactivityErasureNotice.findUniqueOrThrow({ where: { id: n.id } })).resolution).toBe("no_longer_eligible");
  });
  it("refuses a notice that gave less than 48 hours, even if the row says it is due", async () => {
    const id = await person();
    const n = await prisma.inactivityErasureNotice.create({
      data: { personId: id, lastActiveAt: new Date(Date.now() - 1500 * DAY), noticedAt: new Date(Date.now() - 3 * HOUR), eraseAfter: new Date(Date.now() - HOUR) },
    });
    await executeInactivityErasures({ now: now() });
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    expect((await prisma.inactivityErasureNotice.findUniqueOrThrow({ where: { id: n.id } })).resolution).toBe("notice_period_too_short");
  });
  it("a dry run changes nothing", async () => {
    const id = await person();
    await mkNotice(id, { noticedHoursAgo: 200, eraseInHours: -1 });
    const r = await executeInactivityErasures({ now: now(), dryRun: true });
    expect(r.erased).toBeGreaterThanOrEqual(1);
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
  });
});

describe("runInactivityErasure and the retention policy", () => {
  it("is OFF by default: nothing is sent or erased unless INACTIVITY_ERASURE_ENABLED=true (a dry run still reports)", async () => {
    const id = await person();
    expect(await runInactivityErasure({ now: now(), windowMs: WINDOW, env: {} })).toEqual({ noticed: 0, erased: 0, cancelled: 0 });
    expect(await notices(id)).toHaveLength(0);
    const dry = await runInactivityErasure({ now: now(), windowMs: WINDOW, dryRun: true, env: {} });
    expect(dry.noticed).toBeGreaterThanOrEqual(1);
    expect(await notices(id)).toHaveLength(0);
  });
  it("notice first, erasure only in a LATER run, through the registered retention policy", async () => {
    const policy = RETENTION_POLICIES.find((p) => p.name === "identity.inactive_accounts_erasure")!;
    expect(policy).toBeDefined();
    const id = await person();
    const t0 = now();
    const prev = process.env.INACTIVITY_ERASURE_ENABLED;
    process.env.INACTIVITY_ERASURE_ENABLED = "true";
    try {
      await runRetention({ policies: [policy], now: t0 });
      expect(await notices(id)).toHaveLength(1);
      expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull(); // same run: never
      await runRetention({ policies: [policy], now: new Date(t0.getTime() + 2 * DAY) });
      expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull(); // 48h passed but the default notice is 7 days
      await runRetention({ policies: [policy], now: new Date(t0.getTime() + 8 * DAY) });
      expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.INACTIVITY_ERASURE_ENABLED;
      else process.env.INACTIVITY_ERASURE_ENABLED = prev;
    }
    void ON;
  });
});
