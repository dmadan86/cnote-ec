"use client";
import { Input } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { labelResultAction, toggleCategoryAction } from "./actions";

/** Radio group so the truth label is chosen explicitly (not colour-coded). */
export function LabelForm({ resultId, current }: { resultId: string; current: string | null }) {
  return (
    <ActionForm action={labelResultAction} successMessage="Saved." className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="resultId" value={resultId} />
      <label htmlFor={`lb-${resultId}`} className="sr-only">Ground-truth label</label>
      <select id={`lb-${resultId}`} name="label" defaultValue={current ?? "consistent"} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
        <option value="consistent">Consistent</option>
        <option value="inconsistent">Inconsistent</option>
        <option value="inconclusive">Inconclusive</option>
      </select>
      <SubmitButton size="sm" variant="outline">{current ? "Update label" : "Save label"}</SubmitButton>
    </ActionForm>
  );
}

export function CategoryToggle({ slug, enabled }: { slug: string; enabled: boolean }) {
  return (
    <ActionForm action={toggleCategoryAction} successMessage={enabled ? "Disabled." : "Enabled."} confirm={enabled ? `Disable photo checks for ${slug}?` : `Enable photo checks for ${slug}?`}>
      <input type="hidden" name="categorySlug" value={slug} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <SubmitButton size="sm" variant={enabled ? "outline" : "primary"}>{enabled ? "Disable" : "Enable"}</SubmitButton>
    </ActionForm>
  );
}

export function EnableForm() {
  return (
    <ActionForm action={toggleCategoryAction} successMessage="Enabled." className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="enabled" value="true" />
      <div><label htmlFor="q-slug" className="block text-xs text-muted">Category slug</label><Input id="q-slug" name="categorySlug" required maxLength={80} className="w-64" /></div>
      <SubmitButton size="sm">Enable (gated)</SubmitButton>
    </ActionForm>
  );
}
