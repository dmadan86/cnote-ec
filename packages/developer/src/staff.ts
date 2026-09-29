import { prisma, type Prisma } from "@cnote/db";
import { z } from "zod";
import { toView } from "./keys";
import { loadUsage } from "./usage";
import type { ApiKeyView } from "./types";

export interface StaffApiKeyView extends ApiKeyView {
  personId: string;
  /** daily request counts, oldest first (last 14 days) */
  usage: number[];
}

const PAGE = 50;

/** Metadata only — never secrets or hashes. Caller must have checked api_keys.read. */
export async function listApiKeysForStaff(
  opts: { q?: string; status?: "active" | "expired" | "revoked"; cursor?: string } = {},
): Promise<{ items: StaffApiKeyView[]; nextCursor: string | null }> {
  const now = new Date();
  const q = opts.q?.trim();
  const and: Prisma.ApiKeyWhereInput[] = [];
  if (q) {
    const ors: Prisma.ApiKeyWhereInput[] = [
      { name: { contains: q, mode: "insensitive" } },
      { prefix: { contains: q, mode: "insensitive" } },
    ];
    if (z.uuid().safeParse(q).success) ors.push({ id: q }, { personId: q }, { businessId: q });
    and.push({ OR: ors });
  }
  if (opts.status === "revoked") and.push({ revokedAt: { not: null } });
  if (opts.status === "active") and.push({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
  if (opts.status === "expired") and.push({ revokedAt: null, expiresAt: { lte: now } });

  const cursor = opts.cursor && z.uuid().safeParse(opts.cursor).success ? { id: opts.cursor } : undefined;
  const rows = await prisma.apiKey.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1,
    ...(cursor ? { cursor, skip: 1 } : {}),
  });
  const page = rows.slice(0, PAGE);
  const usage = await Promise.all(page.map((r) => loadUsage(r.id, 14, now)));
  return {
    items: page.map((r, i) => ({ ...toView(r, now), personId: r.personId, usage: usage[i]!.map((d) => d.requests) })),
    nextCursor: rows.length > PAGE ? page[page.length - 1]!.id : null,
  };
}
