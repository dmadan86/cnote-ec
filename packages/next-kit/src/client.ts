"use client";
// Client auth UI shared by all apps. Each app renders these on its own /signin, /signup, ... pages.
// PUBLIC CONTRACT (props). Extend, don't break.
export interface AuthFormProps {
  /** Where to go after success (validated to be a same-origin path). */
  next?: string;
  /** Show "Continue with Google" (hide when GOOGLE_CLIENT_ID is unset). */
  googleEnabled?: boolean;
  /** Links to sibling pages; defaults "/signin", "/signup", "/forgot-password". */
  paths?: { signIn?: string; signUp?: string; forgot?: string };
  /** Hide sign-up link (admin app). */
  allowSignUp?: boolean;
}
export function SignInForm(props: AuthFormProps): React.ReactNode {
  void props;
  throw new Error("not implemented");
}
export function SignUpForm(props: AuthFormProps): React.ReactNode {
  void props;
  throw new Error("not implemented");
}
export function ForgotPasswordForm(props: AuthFormProps): React.ReactNode {
  void props;
  throw new Error("not implemented");
}
export function ResetPasswordForm(props: AuthFormProps & { token: string }): React.ReactNode {
  void props;
  throw new Error("not implemented");
}
export function GoogleButton(props: { next?: string }): React.ReactNode {
  void props;
  throw new Error("not implemented");
}
