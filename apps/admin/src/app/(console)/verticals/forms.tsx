"use client";
import { Field, Input, Select, Textarea } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { addItemAction, changeStageAction, createVerticalAction, deleteItemAction, toggleItemAction, updateVerticalAction } from "./actions";

const SECTIONS = ["schema", "classifiers", "acquisition", "languages", "ops", "compliance"];
export interface VerticalFormValue {
  id: string; name: string; categorySlugs: string; languages: string; clusters: string; attributeSchemaSlug: string; notes: string;
  minVerifiedSellers: number; minNetAdds30: number; minNetAdds90: number; prohibitedModelVersion: string; intentModelVersion: string; classifierNotes: string;
}

export function CreateVerticalForm() {
  return (
    <ActionForm action={createVerticalAction} successMessage="Created with the playbook checklist. Find it in the list." className="max-w-2xl space-y-4">
      <Field label="Slug" htmlFor="v-slug" hint="lowercase, hyphens"><Input id="v-slug" name="slug" required maxLength={63} /></Field>
      <Field label="Name" htmlFor="v-name"><Input id="v-name" name="name" required maxLength={120} /></Field>
      <Field label="Root category slugs" htmlFor="v-cats" hint="comma separated; must exist in the catalogue"><Input id="v-cats" name="categorySlugs" required /></Field>
      <Field label="Languages in order" htmlFor="v-langs" hint="codes: en hi kn ta te mr gu bn; first is primary"><Input id="v-langs" name="languages" defaultValue="en, hi" required /></Field>
      <Field label="Seller clusters" htmlFor="v-clusters" hint="one per line: label | city | industry | district | state"><Textarea id="v-clusters" name="clusters" rows={3} /></Field>
      <Field label="Attribute schema category" htmlFor="v-attr" hint="defaults to the first category"><Input id="v-attr" name="attributeSchemaSlug" /></Field>
      <SubmitButton>Create from playbook template</SubmitButton>
    </ActionForm>
  );
}

export function EditVerticalForm({ v }: { v: VerticalFormValue }) {
  return (
    <ActionForm action={updateVerticalAction} successMessage="Saved." className="max-w-2xl space-y-4">
      <input type="hidden" name="id" value={v.id} />
      <Field label="Name" htmlFor="e-name"><Input id="e-name" name="name" defaultValue={v.name} required /></Field>
      <Field label="Root category slugs" htmlFor="e-cats"><Input id="e-cats" name="categorySlugs" defaultValue={v.categorySlugs} required /></Field>
      <Field label="Languages in order" htmlFor="e-langs"><Input id="e-langs" name="languages" defaultValue={v.languages} required /></Field>
      <Field label="Seller clusters" htmlFor="e-clusters" hint="label | city | industry | district | state"><Textarea id="e-clusters" name="clusters" rows={3} defaultValue={v.clusters} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Min verified sellers" htmlFor="e-g1"><Input id="e-g1" name="minVerifiedSellers" type="number" min={0} defaultValue={v.minVerifiedSellers} /></Field>
        <Field label="Min net adds (30d)" htmlFor="e-g2"><Input id="e-g2" name="minNetAdds30" type="number" defaultValue={v.minNetAdds30} /></Field>
        <Field label="Min net adds (90d)" htmlFor="e-g3"><Input id="e-g3" name="minNetAdds90" type="number" defaultValue={v.minNetAdds90} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Prohibited-category model version" htmlFor="e-c1"><Input id="e-c1" name="prohibitedModelVersion" defaultValue={v.prohibitedModelVersion} /></Field>
        <Field label="Intent model version" htmlFor="e-c2"><Input id="e-c2" name="intentModelVersion" defaultValue={v.intentModelVersion} /></Field>
      </div>
      <Field label="Classifier notes" htmlFor="e-c3"><Input id="e-c3" name="classifierNotes" defaultValue={v.classifierNotes} /></Field>
      <Field label="Attribute schema category" htmlFor="e-attr"><Input id="e-attr" name="attributeSchemaSlug" defaultValue={v.attributeSchemaSlug} /></Field>
      <Field label="Notes" htmlFor="e-notes"><Textarea id="e-notes" name="notes" rows={2} defaultValue={v.notes} /></Field>
      <SubmitButton>Save</SubmitButton>
    </ActionForm>
  );
}

export function StageForm({ id, options, blocked }: { id: string; options: string[]; blocked: boolean }) {
  return (
    <ActionForm action={changeStageAction} confirm="Change stage? This is audited." successMessage="Stage changed." className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Move to" htmlFor="st-to">
          <Select id="st-to" name="to" defaultValue={options[0]}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
        </Field>
        <SubmitButton>Change stage</SubmitButton>
      </div>
      <Field label={blocked ? "Override reason (required: an open vertical misses its gates)" : "Override reason (only used if an open vertical misses its gates)"} htmlFor="st-reason" hint="At least 10 characters. Recorded in the audit log and the stage history.">
        <Input id="st-reason" name="overrideReason" maxLength={300} />
      </Field>
    </ActionForm>
  );
}

export function ChecklistRow({ verticalId, item }: { verticalId: string; item: { id: string; title: string; done: boolean; owner: string | null; evidenceUrl: string | null } }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line py-2 last:border-b-0">
      <ActionForm action={toggleItemAction} successMessage="Saved." className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={verticalId} />
        <input type="hidden" name="itemId" value={item.id} />
        <input type="hidden" name="done" value={item.done ? "false" : "true"} />
        <span className={item.done ? "text-sm text-muted line-through" : "text-sm text-ink"}>{item.title}</span>
        <Input name="owner" aria-label={`Owner for ${item.title}`} placeholder="owner" defaultValue={item.owner ?? ""} className="h-8 w-32 text-xs" />
        <Input name="evidenceUrl" aria-label={`Evidence URL for ${item.title}`} placeholder="evidence url" defaultValue={item.evidenceUrl ?? ""} className="h-8 w-48 text-xs" />
        <SubmitButton size="sm" variant={item.done ? "outline" : "primary"}>{item.done ? "Reopen" : "Mark done"}</SubmitButton>
      </ActionForm>
      <ActionForm action={deleteItemAction} confirm="Remove this checklist item?" successMessage="Removed.">
        <input type="hidden" name="id" value={verticalId} />
        <input type="hidden" name="itemId" value={item.id} />
        <SubmitButton size="sm" variant="outline">Remove</SubmitButton>
      </ActionForm>
    </div>
  );
}

export function AddItemForm({ id }: { id: string }) {
  return (
    <ActionForm action={addItemAction} successMessage="Added." className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <Field label="Section" htmlFor="ai-section"><Select id="ai-section" name="section">{SECTIONS.map((x) => <option key={x} value={x}>{x}</option>)}</Select></Field>
      <Field label="Title" htmlFor="ai-title"><Input id="ai-title" name="title" required maxLength={200} className="w-72" /></Field>
      <Field label="Owner" htmlFor="ai-owner"><Input id="ai-owner" name="owner" className="w-32" /></Field>
      <SubmitButton>Add item</SubmitButton>
    </ActionForm>
  );
}
