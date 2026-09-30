import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cnote/db";
import { MockPartner, listIssues, processPayouts, reconcile, resolveIssue, setEscrowPartner, staffReleaseEscrow } from "../src/index";
import { cleanup, fundedEscrow, mock, uid } from "./helpers";

afterAll(() => { setEscrowPartner(null); return cleanup(); });
const window = () => ({ from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) });

describe("reconciliation", () => {
  it("clean books: the mock statement (non-authoritative) matches the ledger and opens nothing for this escrow", async () => {
    const f = await fundedEscrow();
    await staffReleaseEscrow(f.escrowId);
    await processPayouts();
    await reconcile(window());
    expect((await listIssues({ escrowId: f.escrowId })).length).toBe(0);
  });
  it("amount mismatch and missing-in-ledger are recorded once, then resolvable", async () => {
    const f = await fundedEscrow();
    mock().pushStatement({ partnerRef: "p1", escrowRef: f.escrowId, kind: "collect", amountPaise: 999, at: new Date().toISOString() });
    mock().pushStatement({ partnerRef: "p2", escrowRef: uid(), kind: "payout", amountPaise: 55, at: new Date().toISOString() });
    const r1 = await reconcile(window());
    expect(r1.kinds).toEqual(expect.arrayContaining(["amount_mismatch", "missing_in_ledger"]));
    const r2 = await reconcile(window());
    expect(r2.opened).toBe(0); // de-duplicated
    const issues = await listIssues({ escrowId: f.escrowId, status: "open" });
    const mm = issues.find((i) => i.kind === "amount_mismatch")!;
    expect(mm).toMatchObject({ actualPaise: 1_000_999, expectedPaise: 1_000_000 });
    await expect(resolveIssue(mm.id, uid(), "x")).rejects.toMatchObject({ code: "validation" });
    await resolveIssue(mm.id, uid(), "Partner fee adjustment confirmed");
    await expect(resolveIssue(mm.id, uid(), "again again")).rejects.toMatchObject({ code: "conflict" });
    await expect(resolveIssue("bad", uid(), "note note")).rejects.toMatchObject({ code: "not_found" });
    expect((await listIssues({ escrowId: f.escrowId, status: "resolved" }))[0]!.resolutionNote).toBe("Partner fee adjustment confirmed");
    expect((await listIssues({ limit: 5 })).length).toBeGreaterThan(0);
    mock().reset();
  });
  it("authoritative partner: ledger movement missing at the partner is flagged", async () => {
    class Auth extends MockPartner { override readonly authoritativeStatement = true as never; }
    const f = await fundedEscrow(); // funded through the default mock: its statement is not visible to the new partner
    setEscrowPartner(new Auth());
    try {
      const r = await reconcile(window());
      expect(r.kinds).toContain("missing_at_partner");
      expect(await prisma.escrowReconciliationIssue.count({ where: { escrowId: f.escrowId, kind: "missing_at_partner" } })).toBe(1);
    } finally { setEscrowPartner(null); }
  });
});
