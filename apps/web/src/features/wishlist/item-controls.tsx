"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Select, Textarea } from "@cnote/ui";
import { useActionState } from "react";
import { moveItemAction, removeItemAction, updateNoteAction } from "./actions";

/** Note editor, move/copy and remove for one saved item. */
export function ItemControls({
  listId,
  listingId,
  title,
  note,
  otherLists,
}: {
  listId: string;
  listingId: string;
  title: string;
  note: string | null;
  otherLists: { id: string; name: string }[];
}) {
  const [noteState, saveNote, noting] = useActionState<ActionResult | null, FormData>(updateNoteAction, null);
  const [moveState, move, moving] = useActionState<ActionResult | null, FormData>(moveItemAction, null);
  const [rmState, remove, removing] = useActionState<ActionResult | null, FormData>(removeItemAction, null);
  const error = [noteState, moveState, rmState].find((s) => s && !s.ok);
  const noteId = `note-${listingId}`;
  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
      <form action={saveNote} className="flex flex-col gap-1.5">
        <input type="hidden" name="listId" value={listId} />
        <input type="hidden" name="listingId" value={listingId} />
        <label htmlFor={noteId} className="text-xs font-medium text-muted">
          Private note
        </label>
        <Textarea id={noteId} name="note" defaultValue={note ?? ""} rows={2} maxLength={500} placeholder="e.g. ask for 5-ply sample" className="min-h-16" />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="outline" size="sm" disabled={noting}>
            {noting ? "Saving…" : "Save note"}
          </Button>
          {noteState?.ok ? <span role="status" className="text-xs text-success">Saved</span> : null}
        </div>
      </form>
      <div className="flex flex-wrap items-end gap-3">
        {otherLists.length ? (
          <form action={move} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="listId" value={listId} />
            <input type="hidden" name="listingId" value={listingId} />
            <label htmlFor={`to-${listingId}`} className="sr-only">
              Move or copy {title} to list
            </label>
            <Select id={`to-${listingId}`} name="toListId" required defaultValue="" className="h-9 w-44">
              <option value="" disabled>
                Move / copy to…
              </option>
              {otherLists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <Button type="submit" name="mode" value="move" variant="outline" size="sm" disabled={moving}>
              Move
            </Button>
            <Button type="submit" name="mode" value="copy" variant="outline" size="sm" disabled={moving}>
              Copy
            </Button>
          </form>
        ) : null}
        <form action={remove} className="ml-auto">
          <input type="hidden" name="listId" value={listId} />
          <input type="hidden" name="listingId" value={listingId} />
          <Button type="submit" variant="ghost" size="sm" aria-label={`Remove ${title} from this list`} disabled={removing}>
            Remove
          </Button>
        </form>
      </div>
      {error && !error.ok ? <Alert tone="danger">{error.error}</Alert> : null}
    </div>
  );
}
