"use client";
import { DEFAULT_AUTH_LABELS, ForgotPasswordForm, ResetPasswordForm, SignInForm, SignUpForm, type AuthFormProps, type AuthLabels } from "@cnote/next-kit/client";
import { useTranslations } from "next-intl";

/** Translated auth-form labels from the ambient next-intl provider (English on today's unprefixed auth routes). */
function useAuthLabels(): AuthLabels {
  const t = useTranslations("auth");
  return Object.fromEntries(Object.keys(DEFAULT_AUTH_LABELS).map((k) => [k, t.raw(k) as string])) as unknown as AuthLabels;
}

/** Translator for stable error keys from `errors.*` (undefined when the key has no translation). */
function useErrorTranslator(): (key: string) => string | undefined {
  const t = useTranslations("errors");
  return (key) => (t.has(key) ? t(key) : undefined);
}

export const LocalizedSignInForm = (p: AuthFormProps) => <SignInForm {...p} labels={useAuthLabels()} translateError={useErrorTranslator()} />;
export const LocalizedSignUpForm = (p: AuthFormProps) => <SignUpForm {...p} labels={useAuthLabels()} translateError={useErrorTranslator()} />;
export const LocalizedForgotPasswordForm = (p: AuthFormProps) => <ForgotPasswordForm {...p} labels={useAuthLabels()} translateError={useErrorTranslator()} />;
export const LocalizedResetPasswordForm = (p: AuthFormProps & { token: string }) => <ResetPasswordForm {...p} labels={useAuthLabels()} translateError={useErrorTranslator()} />;
