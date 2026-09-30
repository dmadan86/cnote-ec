import { DomainError } from "@cnote/core";
import { listCategories } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { addChecklistItem, createVertical } from "./verticals";
import type { ChecklistSection, VerticalInput, VerticalView } from "./types";

/**
 * The Phase-1 playbook (ADR-016) as data. docs/playbooks/TEMPLATE.md is the human-readable twin. Nothing here names a
 * vertical: ADR-011 stays undecided until staff choose one.
 */
export const PLAYBOOK_TEMPLATE: Record<ChecklistSection, string[]> = {
  schema: [
    "Define the category attribute schema (fields, units, select options) in the catalogue",
    "Map HSN codes and price units for the vertical",
    "Set the per-category lead cap (default 3)",
    "Review the schema with 5 real sellers for gaps",
  ],
  classifiers: [
    "Assemble a golden set for the prohibited-category classifier (ADR-003/008)",
    "Fine-tune or configure the prohibited-category classifier version for this vertical",
    "Fine-tune or configure the intent-scoring model version for this vertical",
    "Pass the golden-set evals before pointing config at the new versions",
  ],
  acquisition: [
    "Name the target seller clusters (city/district and industry)",
    "Recruit an on-ground cluster partner or association",
    "Run WhatsApp-first onboarding with the first 25 sellers",
    "Reach 200 verified sellers (tier >= 1) with live listings",
    "Confirm positive net seller adds over trailing 30 and 90 days",
  ],
  languages: [
    "Set the language order for the vertical (first = primary)",
    "Translate onboarding prompts, category names and attribute labels",
    "Test transliterated and Hinglish search queries against seed listings",
  ],
  ops: [
    "Staff the human review queue for low-confidence moderation",
    "Define lead-refund handling for unreachable buyers (72h)",
    "Prepare seller support scripts in the primary languages",
  ],
  compliance: [
    "Confirm the prohibited-category list for this vertical with legal (ADR-010)",
    "Check PII redaction on the vertical's extraction prompts",
    "Confirm data residency for any vertical-specific vendors",
  ],
};

/** Root categories in the catalogue (candidates for a new vertical), with child counts. Pure data for pickers. */
export async function listCandidateRoots(): Promise<{ slug: string; name: string; children: number }[]> {
  const cats = await listCategories();
  return cats.filter((c) => !c.parentId && !c.prohibited).map((c) => ({ slug: c.slug, name: c.name, children: cats.filter((x) => x.parentId === c.id).length }));
}

/**
 * Creates a candidate vertical and seeds its checklist from PLAYBOOK_TEMPLATE. The caller picks the categories and the
 * name; when `attributeSchemaSlug` is omitted it defaults to the first category. Rolls the vertical back if seeding fails.
 */
export async function createVerticalFromTemplate(input: VerticalInput): Promise<VerticalView> {
  const v = await createVertical({ ...input, attributeSchemaSlug: input.attributeSchemaSlug ?? input.categorySlugs[0] });
  try {
    for (const [section, titles] of Object.entries(PLAYBOOK_TEMPLATE) as [ChecklistSection, string[]][]) {
      let i = 0;
      for (const title of titles) await addChecklistItem(v.id, { section, title, sortOrder: i++ });
    }
  } catch (err) {
    await prisma.vertical.delete({ where: { id: v.id } }).catch(() => {});
    throw err instanceof DomainError ? err : new DomainError("conflict", "Could not seed the playbook checklist.");
  }
  return v;
}
