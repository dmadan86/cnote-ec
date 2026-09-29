"use server";
import { audited, hasPrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { runAction, type ActionResult } from "@cnote/next-kit";
import {
  reinstateStorefront, reorderTemplates, reviewStorefrontVersion, seedStorefrontTemplates, setTemplateActive, suspendStorefront, upsertTemplate, validateTemplateInput,
} from "@cnote/storefront";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

// Privileges are enforced by audited() on every call: storefronts.review (queue, suspend) / storefronts.templates (gallery).
const uuid = z.uuid();
const refresh = () => {
  revalidatePath("/storefronts/review");
  revalidatePath("/storefronts/templates");
};

export async function reviewVersionAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    const versionId = uuid.parse(fd.get("versionId"));
    const outcome = z.enum(["approved", "rejected"]).parse(fd.get("outcome"));
    const note = z.string().max(500).parse(fd.get("note") ?? "");
    await audited(ctx, "storefronts.review", `storefront.version.${outcome}`, { type: "storefront_version", id: versionId }, () => reviewStorefrontVersion(versionId, ctx.staff.id, outcome, note), { note });
  });
  if (r.ok) refresh();
  return r;
}

export async function suspendAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    const id = uuid.parse(fd.get("storefrontId"));
    const reason = z.string().trim().min(3, "Give a reason (shown to the seller).").max(500).parse(fd.get("reason") ?? "");
    await audited(ctx, "storefronts.review", "storefront.suspend", { type: "storefront", id }, () => suspendStorefront(id, ctx.staff.id, reason), { reason });
  });
  if (r.ok) refresh();
  return r;
}

export async function reinstateAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    const id = uuid.parse(fd.get("storefrontId"));
    await audited(ctx, "storefronts.review", "storefront.reinstate", { type: "storefront", id }, () => reinstateStorefront(id));
  });
  if (r.ok) refresh();
  return r;
}

// ---- templates ------------------------------------------------------------------------------

export async function seedTemplatesAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    const overwrite = fd.get("overwrite") === "on";
    await audited(ctx, "storefronts.templates", "storefront.template.seed", { type: "storefront_template", id: null }, () => seedStorefrontTemplates({ overwrite }), { overwrite });
  });
  if (r.ok) refresh();
  return r;
}

export async function setTemplateActiveAction(key: string, active: boolean): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    z.string().max(60).parse(key);
    await audited(ctx, "storefronts.templates", active ? "storefront.template.activate" : "storefront.template.deactivate", { type: "storefront_template", id: key }, () => setTemplateActive(key, active), { active });
  });
  if (r.ok) refresh();
  return r;
}

/** `keys` is the new full order of the gallery. */
export async function reorderTemplatesAction(keys: string[]): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    z.array(z.string().max(60)).max(200).parse(keys);
    await audited(ctx, "storefronts.templates", "storefront.template.reorder", { type: "storefront_template", id: null }, () => reorderTemplates(keys), { keys });
  });
  if (r.ok) refresh();
  return r;
}

const csv = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export interface TemplateSaveResult {
  issues?: { path: string; message: string }[];
}

export async function saveTemplateAction(_prev: ActionResult<TemplateSaveResult> | null, fd: FormData): Promise<ActionResult<TemplateSaveResult>> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    let documentJson: unknown;
    try {
      documentJson = JSON.parse(String(fd.get("document") ?? ""));
    } catch {
      throw new DomainError("validation", "The document is not valid JSON.");
    }
    const input = {
      key: String(fd.get("key") ?? "").trim(),
      name: String(fd.get("name") ?? ""),
      description: String(fd.get("description") ?? ""),
      verticals: csv(fd.get("verticals")),
      tags: csv(fd.get("tags")),
      sortOrder: Number.isFinite(Number(fd.get("sortOrder"))) ? Number(fd.get("sortOrder")) : undefined,
      active: fd.get("active") === "on",
      document: documentJson,
    };
    const v = validateTemplateInput(input);
    if (!v.ok) throw new DomainError("validation", `Template is not valid: ${v.issues.slice(0, 3).map((i) => `${i.path || "template"}: ${i.message}`).join("; ")}`, { issues: v.issues });
    await audited(ctx, "storefronts.templates", "storefront.template.save", { type: "storefront_template", id: input.key }, () => upsertTemplate(input, ctx.staff.id), { active: input.active });
    return {};
  });
  if (r.ok) refresh();
  return r;
}

export async function canReview() {
  return hasPrivilege((await actionContext()).staff, "storefronts.review");
}
