"use client";
import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { Field, Select, Textarea } from "@cnote/ui";
import { LANGUAGES } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { draftListingAction, type DraftResult } from "./actions";

const EXAMPLES = [
  { label: "Hinglish", text: "Hum kraft paper ke 3 ply corrugated box banate hain, size 12x10x8 inch, 500 piece se order, rate 18 rupaye per piece, Bengaluru se dispatch." },
  { label: "हिन्दी", text: "मेरे पास स्टेनलेस स्टील की पाइप है, 304 ग्रेड, कम से कम 1 टन का ऑर्डर, रेट 210 रुपये प्रति किलो, मुंबई से डिलीवरी।" },
  { label: "English", text: "We make plain cotton T-shirts, 180 GSM, sizes S to XXL, MOQ 100 pcs, Rs 120 per piece, ready stock in Tiruppur." },
];

export function AiDraftBox({ mode, defaultLanguage = "hi" }: { mode: "onboarding" | "portal"; defaultLanguage?: string }) {
  const t = useTranslations("listings.aiDraft");
  const [state, action] = useActionState<DraftResult | null, FormData>(draftListingAction, null);
  const [text, setText] = useState("");
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <Field
        label={t("label")}
        htmlFor="text"
        hint={t("hint")}
        error={fieldError(state, "text")}
      >
        <Textarea
          id="text"
          name="text"
          required
          minLength={10}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-44 text-base"
          placeholder="Hum kraft paper ke 3 ply box banate hain, 500 piece se order…"
          aria-invalid={Boolean(fieldError(state, "text"))}
        />
      </Field>

      <div>
        <p className="text-xs font-medium text-muted">{t("tapExample")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() => setText(ex.text)}
              className="min-h-11 rounded-full border border-line bg-surface px-3 text-sm text-ink hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </div>

      <Field label={t("language")} htmlFor="language" className="max-w-xs">
        <Select id="language" name="language" defaultValue={defaultLanguage} className="h-11">
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native} ({l.label})
            </option>
          ))}
        </Select>
      </Field>

      <FormAlert state={state} />
      <SubmitButton size="lg" icon={<Sparkles className="size-4" aria-hidden />} pendingText={t("drafting")}>
        {t("submit")}
      </SubmitButton>
      <p className="text-xs text-muted">
        {t("footnote")}
      </p>
    </form>
  );
}
