"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { LANGUAGES } from "@/lib/constants";
import { PhotoDraftPanel } from "./photo-draft-panel";
import { VoiceDraftPanel } from "./voice-draft-panel";

/** "Create from photos" + "Describe by voice", shown under the text box on /listings/new and onboarding step 4. */
export function AiDraftAlternatives({ mode, defaultLanguage = "hi" }: { mode: "onboarding" | "portal"; defaultLanguage?: string }) {
  const t = useTranslations("listings.alternatives");
  const [language, setLanguage] = useState(defaultLanguage);
  return (
    <div className="space-y-4 border-t border-line pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{t("or")}</p>
        <label className="flex items-center gap-2 text-sm text-muted">
          {t("language")}
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className="h-11 rounded-md border border-line bg-surface px-2 text-ink">
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.native} ({l.label})</option>
            ))}
          </select>
        </label>
      </div>
      <PhotoDraftPanel mode={mode} language={language} />
      <VoiceDraftPanel mode={mode} language={language} />
    </div>
  );
}
