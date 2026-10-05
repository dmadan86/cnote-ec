"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { activateRateCardAction, resetRateCardAction, saveRateCardAction } from "./actions";

const input = "mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm";

export function RateCardForm({ json }: { json: string }) {
  return (
    <ActionForm action={saveRateCardAction} successMessage="Saved as a new version and activated." confirm="Activate this rate card for every freight estimate?">
      <div className="space-y-2">
        <label className="block text-xs">Rate card (JSON; money in paise, weights in kg)
          <textarea name="card" required spellCheck={false} defaultValue={json} rows={22} className="mt-1 block w-full rounded-lg border border-line bg-surface p-3 font-mono text-xs" />
        </label>
        <label className="block text-xs">Reason
          <input name="reason" required minLength={3} maxLength={300} className={input} />
        </label>
        <SubmitButton size="sm">Save as new version</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function ActivateForm({ version }: { version: number }) {
  return (
    <ActionForm action={activateRateCardAction} successMessage={`Version ${version} is now active.`}>
      <div className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="version" value={version} />
        <label className="min-w-40 text-xs"><span className="sr-only">Reason to activate version {version}</span>
          <input name="reason" required minLength={3} maxLength={300} placeholder="Reason" className={input} />
        </label>
        <SubmitButton size="sm" variant="outline">Activate v{version}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function ResetForm() {
  return (
    <ActionForm action={resetRateCardAction} successMessage="Using the built-in default card." confirm="Switch back to the built-in default rate card?">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-56 flex-1 text-xs">Reason
          <input name="reason" required minLength={3} maxLength={300} className={input} />
        </label>
        <SubmitButton size="sm" variant="outline">Use built-in default</SubmitButton>
      </div>
    </ActionForm>
  );
}
