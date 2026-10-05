"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { deleteJudgementAction, importStarterSynonymsAction, judgeResultAction, publishSynonymsAction, rollbackSynonymsAction } from "./actions";

const field = "mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";

export function SynonymEditor({ text, version }: { text: string; version: number }) {
  return (
    <ActionForm action={publishSynonymsAction} successMessage="Published. New searches use it now; other servers pick it up within 30 seconds.">
      <input type="hidden" name="editedFrom" value={version} />
      <label className="block text-sm font-medium">
        Synonym groups (one per line)
        <textarea name="groups" rows={16} defaultValue={text} spellCheck={false} lang="und" className={`${field} font-mono`} aria-describedby="syn-help" />
      </label>
      <p id="syn-help" className="mt-1 text-xs text-muted">
        Terms in a line are interchangeable, in any script: <code>kapda, कपड़ा, cloth, fabric</code>. Add a note after <code>#</code>. At least two terms per line; no commas inside a term.
      </p>
      <label className="mt-3 block text-sm font-medium">
        What changed (shown in the history)
        <input name="note" maxLength={500} className={`${field} h-9 py-0`} />
      </label>
      <div className="mt-3"><SubmitButton>Publish as version {version + 1}</SubmitButton></div>
    </ActionForm>
  );
}

export function RollbackForm({ version }: { version: number }) {
  return (
    <ActionForm action={rollbackSynonymsAction} confirm={`Publish a copy of version ${version} as the newest version?`} successMessage="Rolled back (as a new version).">
      <input type="hidden" name="version" value={version} />
      <SubmitButton size="sm" variant="outline">Roll back to v{version}</SubmitButton>
    </ActionForm>
  );
}

export function ImportStarterForm() {
  return (
    <ActionForm action={importStarterSynonymsAction} confirm="Merge the shipped starter dictionary into the current groups as a new version?" successMessage="Starter dictionary imported.">
      <SubmitButton size="sm" variant="outline">Import starter dictionary</SubmitButton>
    </ActionForm>
  );
}

export interface JudgeProps {
  query: string;
  lang: string;
  backend: "postgres" | "opensearch";
  listingId: string;
  title: string;
  categorySlug: string | null;
  grade: number | null;
}

const GRADES = [
  { v: 3, label: "3 Ideal" },
  { v: 2, label: "2 Relevant" },
  { v: 1, label: "1 Related" },
  { v: 0, label: "0 Not relevant" },
];

export function JudgeForm({ p }: { p: JudgeProps }) {
  return (
    <ActionForm action={judgeResultAction} successMessage="Saved.">
      <input type="hidden" name="query" value={p.query} />
      <input type="hidden" name="lang" value={p.lang} />
      <input type="hidden" name="backend" value={p.backend} />
      <input type="hidden" name="listingId" value={p.listingId} />
      <input type="hidden" name="title" value={p.title} />
      <input type="hidden" name="categorySlug" value={p.categorySlug ?? ""} />
      <div className="flex items-center gap-2">
        <label className="text-xs">
          <span className="sr-only">Grade for {p.title}</span>
          <select name="grade" defaultValue={p.grade === null ? "" : String(p.grade)} required className="block h-9 rounded-lg border border-line bg-surface px-2 text-sm">
            <option value="" disabled>Grade…</option>
            {GRADES.map((g) => <option key={g.v} value={g.v}>{g.label}</option>)}
          </select>
        </label>
        <SubmitButton size="sm" variant="outline">Save</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function DeleteJudgementForm({ id }: { id: string }) {
  return (
    <ActionForm action={deleteJudgementAction} confirm="Delete this judgement?" successMessage="Deleted.">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="danger">Delete</SubmitButton>
    </ActionForm>
  );
}
