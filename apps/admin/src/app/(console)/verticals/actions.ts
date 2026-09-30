"use server";
import { audited } from "@cnote/admin";
import { type ActionResult, runAction } from "@cnote/next-kit";
import {
  addChecklistItem, changeStage, CHECKLIST_SECTIONS, createVerticalFromTemplate, deleteChecklistItem, updateChecklistItem, updateVertical, VERTICAL_STAGES, type Cluster,
} from "@cnote/verticals";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

// Every mutation is audited under verticals.manage. Stage overrides (ADR-016) carry their reason in the audit details.
const uuid = z.uuid();
const s = (fd: FormData, k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string).trim() : "");
const list = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
/** one cluster per line: "label | city | industry" (optionally "| district | state") */
function parseClusters(text: string): Cluster[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const [label, city, industry, district, state] = line.split("|").map((p) => p.trim());
    return { label: label ?? "", city: city ?? "", industry: industry ?? "", ...(district ? { district } : {}), ...(state ? { state } : {}) };
  });
}

export async function createVerticalAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    const slug = s(fd, "slug");
    await audited(ctx, "verticals.manage", "verticals.create", { type: "vertical", id: slug }, () =>
      createVerticalFromTemplate({
        slug, name: s(fd, "name"), categorySlugs: list(s(fd, "categorySlugs")), languages: list(s(fd, "languages")) as never,
        clusters: parseClusters(s(fd, "clusters")), attributeSchemaSlug: s(fd, "attributeSchemaSlug") || undefined,
      }),
    );
  });
  if (r.ok) revalidatePath("/verticals");
  return r;
}

export async function updateVerticalAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const id = uuid.parse(s(fd, "id"));
    const ctx = await actionContext();
    const num = (k: string) => Number(s(fd, k));
    await audited(ctx, "verticals.manage", "verticals.update", { type: "vertical", id }, () =>
      updateVertical(id, {
        name: s(fd, "name"), categorySlugs: list(s(fd, "categorySlugs")), languages: list(s(fd, "languages")) as never, clusters: parseClusters(s(fd, "clusters")),
        gates: { minVerifiedSellers: num("minVerifiedSellers"), minNetAdds30: num("minNetAdds30"), minNetAdds90: num("minNetAdds90") },
        classifierConfig: { prohibitedModelVersion: s(fd, "prohibitedModelVersion") || undefined, intentModelVersion: s(fd, "intentModelVersion") || undefined, notes: s(fd, "classifierNotes") || undefined },
        attributeSchemaSlug: s(fd, "attributeSchemaSlug") || null, notes: s(fd, "notes") || null,
      }),
    );
  });
  if (r.ok) revalidatePath(`/verticals/${s(fd, "id")}`);
  return r;
}

export async function changeStageAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const id = uuid.parse(s(fd, "id"));
    const to = z.enum(VERTICAL_STAGES).parse(s(fd, "to"));
    const overrideReason = s(fd, "overrideReason");
    const ctx = await actionContext();
    await audited(ctx, "verticals.manage", "verticals.change_stage", { type: "vertical", id }, () =>
      changeStage({ verticalId: id, to, changedBy: ctx.staff.id, ...(overrideReason ? { override: { reason: overrideReason } } : {}) }),
    { to, overrideReason: overrideReason || null });
  });
  if (r.ok) { revalidatePath("/verticals"); revalidatePath(`/verticals/${s(fd, "id")}`); }
  return r;
}

export async function toggleItemAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const itemId = uuid.parse(s(fd, "itemId"));
    const ctx = await actionContext();
    await audited(ctx, "verticals.manage", "verticals.checklist_update", { type: "vertical_checklist_item", id: itemId }, () =>
      updateChecklistItem(itemId, { done: s(fd, "done") === "true", owner: s(fd, "owner"), evidenceUrl: s(fd, "evidenceUrl") }),
    );
  });
  if (r.ok) revalidatePath(`/verticals/${s(fd, "id")}`);
  return r;
}

export async function addItemAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const id = uuid.parse(s(fd, "id"));
    const section = z.enum(CHECKLIST_SECTIONS).parse(s(fd, "section"));
    const ctx = await actionContext();
    await audited(ctx, "verticals.manage", "verticals.checklist_add", { type: "vertical", id }, () => addChecklistItem(id, { section, title: s(fd, "title"), owner: s(fd, "owner") || null }));
  });
  if (r.ok) revalidatePath(`/verticals/${s(fd, "id")}`);
  return r;
}

export async function deleteItemAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const itemId = uuid.parse(s(fd, "itemId"));
    const ctx = await actionContext();
    await audited(ctx, "verticals.manage", "verticals.checklist_delete", { type: "vertical_checklist_item", id: itemId }, () => deleteChecklistItem(itemId));
  });
  if (r.ok) revalidatePath(`/verticals/${s(fd, "id")}`);
  return r;
}
