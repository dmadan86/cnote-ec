"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { deleteJudgement, importBuiltInSynonyms, parseGroupsText, publishSynonyms, recordJudgement, rollbackSynonyms } from "@cnote/search";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

// Search tuning (ADR-004, ADR-009). Every mutation is audited under `search.manage`. Synonym changes take effect for new
// searches at once on the publishing instance and within SYNONYM_CACHE_MS (30 s) everywhere else; OpenSearch analyzers pick
// them up at the next reindex, while query-side expansion (what search actually uses) is immediate on both backends.
const SUBJECT = { type: "search_synonyms", id: "dictionary" } as const;

const publishSchema = z.object({
  groups: z.string().max(400_000),
  note: z.string().trim().max(500).optional(),
  editedFrom: z.coerce.number().int().min(0),
});

export async function publishSynonymsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = publishSchema.parse({ groups: fd.get("groups") ?? "", note: fd.get("note") || undefined, editedFrom: fd.get("editedFrom") ?? 0 });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "search.manage");
    const groups = parseGroupsText(input.groups);
    const details: Record<string, unknown> = { editedFrom: input.editedFrom, note: input.note ?? null, groupsSubmitted: groups.length };
    await audited(
      ctx, "search.manage", "search.synonyms.publish", SUBJECT,
      async () => {
        const r = await publishSynonyms(groups, { staffId: ctx.staff.id, note: input.note, editedFrom: input.editedFrom });
        Object.assign(details, { version: r.version, groupCount: r.groups.length });
      },
      details,
    );
  });
  if (result.ok) revalidatePath("/search/synonyms");
  return result;
}

const rollbackSchema = z.object({ version: z.coerce.number().int().min(1) });

export async function rollbackSynonymsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = rollbackSchema.parse({ version: fd.get("version") });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "search.manage");
    const details: Record<string, unknown> = { toVersion: input.version };
    await audited(
      ctx, "search.manage", "search.synonyms.rollback", SUBJECT,
      async () => {
        const r = await rollbackSynonyms(input.version, { staffId: ctx.staff.id });
        details.version = r.version;
      },
      details,
    );
  });
  if (result.ok) revalidatePath("/search/synonyms");
  return result;
}

export async function importStarterSynonymsAction(): Promise<ActionResult> {
  const result = await runAction(async () => {
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "search.manage");
    const details: Record<string, unknown> = {};
    await audited(
      ctx, "search.manage", "search.synonyms.import", SUBJECT,
      async () => {
        const r = await importBuiltInSynonyms({ staffId: ctx.staff.id });
        Object.assign(details, { version: r.version, groupCount: r.groups.length });
      },
      details,
    );
  });
  if (result.ok) revalidatePath("/search/synonyms");
  return result;
}

const judgeSchema = z.object({
  query: z.string().trim().min(1).max(500),
  lang: z.string().trim().min(2).max(16),
  listingId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  categorySlug: z.string().trim().max(100).optional(),
  grade: z.coerce.number().int().min(0).max(3),
  backend: z.enum(["postgres", "opensearch"]),
});

export async function judgeResultAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = judgeSchema.parse({
      query: fd.get("query"), lang: fd.get("lang"), listingId: fd.get("listingId"), title: fd.get("title"),
      categorySlug: fd.get("categorySlug") || undefined, grade: fd.get("grade"), backend: fd.get("backend"),
    });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "search.manage");
    await audited(
      ctx, "search.manage", "search.judgement.record", { type: "search_judgement", id: input.listingId },
      () => recordJudgement({ query: input.query, lang: input.lang, listingId: input.listingId, listingTitle: input.title, categorySlug: input.categorySlug ?? null, grade: input.grade, backend: input.backend, staffId: ctx.staff.id }),
      { query: input.query, lang: input.lang, grade: input.grade, backend: input.backend },
    );
  });
  if (result.ok) revalidatePath("/search/judgements");
  return result;
}

export async function deleteJudgementAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const id = z.uuid().parse(fd.get("id"));
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "search.manage");
    await audited(ctx, "search.manage", "search.judgement.delete", { type: "search_judgement", id }, () => deleteJudgement(id));
  });
  if (result.ok) revalidatePath("/search/judgements");
  return result;
}
