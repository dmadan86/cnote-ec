"use client";
import { DEFAULT_MFA_LABELS, MfaChallengeForm, MfaSettings, type MfaLabels, type MfaSettingsProps } from "@cnote/next-kit/client";
import { useTranslations } from "next-intl";

/** MFA-form labels in the seller's language (messages/<locale>.mfa.json); missing keys fall back to English per key. */
function useMfaLabels(): MfaLabels {
  const t = useTranslations("mfa");
  return Object.fromEntries(Object.keys(DEFAULT_MFA_LABELS).map((k) => [k, t.raw(k) as string])) as unknown as MfaLabels;
}

/** Translator for stable error keys from `errors.*` (undefined when the key has no translation). */
function useErrorTranslator(): (key: string) => string | undefined {
  const t = useTranslations("errors");
  return (key) => (t.has(key) ? t(key) : undefined);
}

export const LocalizedMfaChallengeForm = () => <MfaChallengeForm labels={useMfaLabels()} translateError={useErrorTranslator()} />;
export const LocalizedMfaSettings = (p: MfaSettingsProps) => <MfaSettings {...p} labels={useMfaLabels()} translateError={useErrorTranslator()} />;
