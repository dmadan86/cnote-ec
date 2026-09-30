"use client";
import { DEFAULT_AUTH_LABELS, ForgotPasswordForm, ResetPasswordForm, SignInForm, SignUpForm, type AuthFormProps, type AuthLabels } from "@cnote/next-kit/client";
import { useTranslations } from "next-intl";

/** Translated auth-form labels from the ambient next-intl provider (English on today's unprefixed auth routes). */
function useAuthLabels(): AuthLabels {
  const t = useTranslations("auth");
  return Object.fromEntries(Object.keys(DEFAULT_AUTH_LABELS).map((k) => [k, t.raw(k) as string])) as unknown as AuthLabels;
}

export const LocalizedSignInForm = (p: AuthFormProps) => <SignInForm {...p} labels={useAuthLabels()} />;
export const LocalizedSignUpForm = (p: AuthFormProps) => <SignUpForm {...p} labels={useAuthLabels()} />;
export const LocalizedForgotPasswordForm = (p: AuthFormProps) => <ForgotPasswordForm {...p} labels={useAuthLabels()} />;
export const LocalizedResetPasswordForm = (p: AuthFormProps & { token: string }) => <ResetPasswordForm {...p} labels={useAuthLabels()} />;
