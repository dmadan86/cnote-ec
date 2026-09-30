import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { ACCOUNTS, accountBalance, listJournals, postJournal, trialBalance } from "../src/index";
import { cleanup, uid } from "./helpers";

afterAll(cleanup);

describe("postJournal", () => {
  it("is idempotent by key and derives balances", async () => {
    const o = uid();
    const key = `t:${uid()}`;
    const lines = [{ account: ACCOUNTS.nodal, debitPaise: 500 }, { account: ACCOUNTS.escrow(o), creditPaise: 500 }];
    const a = await prisma.$transaction((tx) => postJournal(tx, { key, kind: "fund", memo: "m", lines }));
    const b = await prisma.$transaction((tx) => postJournal(tx, { key, kind: "fund", memo: "m", lines }));
    expect(a.created).toBe(true);
    expect(b).toEqual({ journalId: a.journalId, created: false });
    expect(await accountBalance(ACCOUNTS.escrow(o))).toBe(500);
    expect(await accountBalance(ACCOUNTS.escrow(uid()))).toBe(0);
    expect(await prisma.ledgerLine.count({ where: { journalId: a.journalId } })).toBe(2);
  });
  it("rejects unbalanced journals without writing anything and requires a key", async () => {
    const key = `bad:${uid()}`;
    await expect(prisma.$transaction((tx) => postJournal(tx, { key, kind: "x", memo: "m", lines: [{ account: ACCOUNTS.nodal, debitPaise: 5 }, { account: ACCOUNTS.fee, creditPaise: 4 }] }))).rejects.toThrow(DomainError);
    expect(await prisma.ledgerJournal.count({ where: { key } })).toBe(0);
    await expect(prisma.$transaction((tx) => postJournal(tx, { key: "", kind: "x", memo: "m", lines: [] }))).rejects.toThrow(DomainError);
  });
  it("a rolled-back transaction leaves no journal", async () => {
    const key = `rb:${uid()}`;
    await prisma.$transaction(async (tx) => {
      await postJournal(tx, { key, kind: "x", memo: "m", lines: [{ account: ACCOUNTS.nodal, debitPaise: 5 }, { account: ACCOUNTS.fee, creditPaise: 5 }] });
      throw new Error("boom");
    }).catch(() => {});
    expect(await prisma.ledgerJournal.count({ where: { key } })).toBe(0);
  });
  it("trial balance always balances and lists journals per escrow", async () => {
    const esc = uid();
    const o = uid();
    await prisma.$transaction((tx) => postJournal(tx, { key: `tb:${uid()}`, kind: "fund", escrowId: esc, memo: "m", lines: [{ account: ACCOUNTS.nodal, debitPaise: 900 }, { account: ACCOUNTS.escrow(o), creditPaise: 900 }] }));
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.accounts.find((a) => a.code === ACCOUNTS.escrow(o))).toMatchObject({ creditPaise: 900, balancePaise: 900, normal: "credit" });
    expect((await trialBalance({ prefix: "buyer_escrow:" })).accounts.every((a) => a.code.startsWith("buyer_escrow:"))).toBe(true);
    const js = await listJournals(esc);
    expect(js).toHaveLength(1);
    expect(js[0]!.lines.map((l) => l.account).sort()).toEqual(["partner_nodal", ACCOUNTS.escrow(o)].sort());
  });
  it("property: random balanced journals keep the trial balance balanced and each escrow account = sum of its credits - debits", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 6 }), async (amounts) => {
      const o = uid();
      for (const [i, amt] of amounts.entries()) {
        await prisma.$transaction((tx) => postJournal(tx, { key: `pp:${o}:${i}`, kind: "fund", memo: "p", lines: [{ account: ACCOUNTS.nodal, debitPaise: amt }, { account: ACCOUNTS.escrow(o), creditPaise: amt }] }));
      }
      expect(await accountBalance(ACCOUNTS.escrow(o))).toBe(amounts.reduce((a, b) => a + b, 0));
      expect((await trialBalance({ prefix: "partner_nodal" })).balanced).toBe(false); // nodal alone is one-sided by design
      expect((await trialBalance()).balanced).toBe(true);
    }), { numRuns: 8 });
  });
});
