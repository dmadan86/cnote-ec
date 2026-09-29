"use server";
import { runAction, type ActionResult } from "@cnote/next-kit";
import {
  applyTemplate, getDraft, getOrCreateStorefront, isSlugAvailable, listVersions, previewDraft, publish, restoreVersion, saveDraft, setSlug, slugProblem,
  type PublishOutcome, type VersionView,
} from "@cnote/storefront";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actionSeller } from "@/lib/auth";

// Every action re-derives the seller from the session; the client never supplies a business id.

export async function createStorefrontAction(): Promise<void> {
  const a = await actionSeller();
  await getOrCreateStorefront(a.businessId, a.personId);
  redirect("/templates");
}

export async function applyTemplateFormAction(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  const goto = String(formData.get("goto") ?? "editor") === "editor" ? "/editor" : "/templates";
  let error: string | null = null;
  try {
    const a = await actionSeller();
    await getOrCreateStorefront(a.businessId, a.personId);
    await applyTemplate(a.businessId, a.personId, key);
  } catch (err) {
    error = err instanceof Error ? err.message : "Could not apply the template.";
  }
  if (error) redirect(`/templates?error=${encodeURIComponent(error)}`);
  revalidatePath("/editor");
  redirect(goto);
}

export async function saveDraftAction(document: unknown, etag: string | null): Promise<ActionResult<{ etag: string; savedAt: string }>> {
  return runAction(async () => {
    const a = await actionSeller();
    const r = await saveDraft(a.businessId, a.personId, document, etag);
    return { etag: r.etag, savedAt: r.savedAt };
  });
}

export async function publishAction(): Promise<ActionResult<PublishOutcome>> {
  return runAction(async () => {
    const a = await actionSeller();
    const r = await publish(a.businessId, a.personId);
    revalidatePath("/");
    return r;
  });
}

export async function previewLinkAction(): Promise<ActionResult<{ path: string; expiresAt: string }>> {
  return runAction(async () => {
    const a = await actionSeller();
    const { token, expiresAt } = await previewDraft(a.businessId);
    return { path: `/preview/${token}`, expiresAt };
  });
}

export async function checkSlugAction(slug: string): Promise<ActionResult<{ available: boolean; problem: string | null }>> {
  return runAction(async () => {
    const a = await actionSeller();
    const s = slug.trim().toLowerCase();
    const problem = slugProblem(s);
    if (problem) return { available: false, problem: problem.message };
    const sf = await getOrCreateStorefront(a.businessId, a.personId);
    return { available: await isSlugAvailable(s, sf.id), problem: null };
  });
}

export async function setSlugAction(slug: string): Promise<ActionResult<{ slug: string }>> {
  return runAction(async () => {
    const a = await actionSeller();
    const sf = await setSlug(a.businessId, slug);
    revalidatePath("/");
    return { slug: sf.slug };
  });
}

export async function restoreVersionAction(versionId: string): Promise<ActionResult<{ document: unknown; etag: string }>> {
  return runAction(async () => {
    const a = await actionSeller();
    const d = await restoreVersion(a.businessId, a.personId, versionId);
    return { document: d.document, etag: d.etag };
  });
}

export async function reloadDraftAction(): Promise<ActionResult<{ document: unknown; etag: string }>> {
  return runAction(async () => {
    const a = await actionSeller();
    const d = await getDraft(a.businessId, a.personId);
    return { document: d.document, etag: d.etag };
  });
}

export async function listVersionsAction(): Promise<ActionResult<VersionView[]>> {
  return runAction(async () => listVersions((await actionSeller()).businessId));
}
