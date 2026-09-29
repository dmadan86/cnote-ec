"use client";
// Client auth UI shared by all apps. Each app renders these on its own /signin, /signup, ... pages.
// PUBLIC CONTRACT (props). Extend, don't break.
export type { AuthFormProps } from "./forms";
export { SignInForm, SignUpForm, ForgotPasswordForm, ResetPasswordForm, GoogleButton } from "./forms";

export * from "./otp-client";
export * from "./turnstile-client";
export * from "./mfa-client";
