// Per-business escrow reads for underwriting and portals (ADR-019 credit). Read-only; no change to escrow behaviour.
import { DomainError } from "@cnote/core";
import { prisma, type EscrowAgreement } from "@cnote/db";
import { heldOf, type EscrowRow } from "./escrow";

const UUID = /^[0-9a-f-]{36}$/i;

export interface EscrowHistory {
  /** escrows that ended released */
  completed: number;
  /** sum of the escrow amounts of completed escrows, paise */
  completedPaise: number;
  /** completed escrows that never had a dispute freeze */
  clean: number;
  /** escrows that ended refunded */
  refunded: number;
}
export type EscrowRole = "buyer" | "seller" | "any";

const sideWhere = (businessId: string, role: EscrowRole) =>
  role === "buyer" ? { buyerBusinessId: businessId } : role === "seller" ? { sellerBusinessId: businessId } : { OR: [{ buyerBusinessId: businessId }, { sellerBusinessId: businessId }] };

/** Aggregates over every escrow of the business (not a sampled page). `role` defaults to either side. */
export async function escrowHistoryForBusiness(businessId: string, opts: { role?: EscrowRole } = {}): Promise<EscrowHistory> {
  if (!UUID.test(businessId)) return { completed: 0, completedPaise: 0, clean: 0, refunded: 0 };
  const side = sideWhere(businessId, opts.role ?? "any");
  const [released, clean, refunded] = await Promise.all([
    prisma.escrowAgreement.aggregate({ where: { ...side, status: "released" }, _count: { _all: true }, _sum: { amountPaise: true } }),
    prisma.escrowAgreement.count({ where: { ...side, status: "released", freezes: { none: {} } } }),
    prisma.escrowAgreement.count({ where: { ...side, status: "refunded" } }),
  ]);
  return { completed: released._count._all, completedPaise: Number(released._sum.amountPaise ?? 0n), clean, refunded };
}

export interface EscrowPage { items: EscrowRow[]; nextCursor: string | null }

const rowOf = (e: EscrowAgreement): EscrowRow => ({
  id: e.id, orderId: e.orderId, status: e.status, frozen: e.frozen, amountPaise: Number(e.amountPaise), heldPaise: heldOf(e),
  buyerBusinessId: e.buyerBusinessId, sellerBusinessId: e.sellerBusinessId, partner: e.partner, createdAt: e.createdAt.toISOString(),
});

const encode = (e: { createdAt: Date; id: string }): string => Buffer.from(`${e.createdAt.toISOString()}|${e.id}`).toString("base64url");
function decode(c: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(c, "base64url").toString().split("|");
  const at = new Date(iso ?? "");
  if (!id || !UUID.test(id) || Number.isNaN(at.getTime())) throw new DomainError("validation", "Invalid cursor.");
  return { at, id };
}

/** Keyset-paged (newest first) escrows of one business, optionally by role and status. */
export async function listEscrowsForBusiness(businessId: string, opts: { role?: EscrowRole; status?: string; cursor?: string | null; limit?: number } = {}): Promise<EscrowPage> {
  if (!UUID.test(businessId)) return { items: [], nextCursor: null };
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const cur = opts.cursor ? decode(opts.cursor) : null;
  const rows = await prisma.escrowAgreement.findMany({
    where: {
      AND: [
        sideWhere(businessId, opts.role ?? "any"),
        ...(opts.status ? [{ status: opts.status }] : []),
        ...(cur ? [{ OR: [{ createdAt: { lt: cur.at } }, { createdAt: cur.at, id: { lt: cur.id } }] }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return { items: page.map(rowOf), nextCursor: rows.length > limit ? encode(page[page.length - 1]!) : null };
}
