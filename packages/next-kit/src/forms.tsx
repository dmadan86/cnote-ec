"use client";
import { Alert, Button, buttonClasses, Card, CardBody, Field, Input } from "@cnote/ui";
import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import type { ActionResult } from "./action-result";
import { forgotPasswordAction, resetPasswordAction, signInAction, signUpAction } from "./actions";
import { TurnstileWidget } from "./turnstile-client";

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

type State = ActionResult | null;
const fieldError = (s: State, name: string) => (s && !s.ok ? s.fieldErrors?.[name] : undefined);
const formError = (s: State) => (s && !s.ok && !s.fieldErrors ? s.error : undefined);

const withNext = (path: string, next?: string) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

function Shell({ children, error }: { children: ReactNode; error?: string }) {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardBody className="flex flex-col gap-4 p-6">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {children}
      </CardBody>
    </Card>
  );
}

const link = "font-medium text-brand-700 hover:underline";

export function GoogleButton({ next }: { next?: string }) {
  const href = next ? `/api/auth/google?next=${encodeURIComponent(next)}` : "/api/auth/google";
  return (
    // Plain anchor: the route handler redirects off-site, so client-side routing must not intercept it.
    <a href={href} className={buttonClasses("outline", "md", "w-full")}>
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
        <path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2-1.9 3.3-4.7 3.3-8.1z" />
        <path fill="#34A853" d="M12 23c3 0 5.4-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1.1-3.7 1.1-2.8 0-5.2-1.9-6-4.5H2.4v2.8A11 11 0 0 0 12 23z" />
        <path fill="#FBBC05" d="M6 14.2a6.6 6.6 0 0 1 0-4.4V7H2.4a11 11 0 0 0 0 9.9L6 14.2z" />
        <path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.1 1.6l3.1-3.1A11 11 0 0 0 2.4 7L6 9.8c.8-2.6 3.2-4.4 6-4.4z" />
      </svg>
      Continue with Google
    </a>
  );
}

const Divider = () => (
  <div className="flex items-center gap-3 text-xs text-muted">
    <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
  </div>
);

export function SignInForm({ next, googleEnabled, paths, allowSignUp = true }: AuthFormProps) {
  const [state, action, pending] = useActionState<State, FormData>(signInAction, null);
  return (
    <Shell error={formError(state)}>
      {googleEnabled ? (
        <>
          <GoogleButton next={next} />
          <Divider />
        </>
      ) : null}
      <form action={action} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="next" value={next ?? ""} />
        <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
          <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={!!fieldError(state, "email")} />
        </Field>
        <Field label="Password" htmlFor="password" error={fieldError(state, "password")}>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <div className="text-right text-sm">
          <Link href={paths?.forgot ?? "/forgot-password"} className={link}>Forgot password?</Link>
        </div>
        <Button type="submit" size="lg" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
      </form>
      {allowSignUp ? (
        <p className="text-center text-sm text-muted">
          New here? <Link href={withNext(paths?.signUp ?? "/signup", next)} className={link}>Create an account</Link>
        </p>
      ) : null}
    </Shell>
  );
}

export function SignUpForm({ next, googleEnabled, paths }: AuthFormProps) {
  const [state, action, pending] = useActionState<State, FormData>(signUpAction, null);
  return (
    <Shell error={formError(state)}>
      {googleEnabled ? (
        <>
          <GoogleButton next={next} />
          <Divider />
        </>
      ) : null}
      <form action={action} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="next" value={next ?? ""} />
        <Field label="Your name" htmlFor="name" error={fieldError(state, "name")}>
          <Input id="name" name="name" autoComplete="name" required aria-invalid={!!fieldError(state, "name")} />
        </Field>
        <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
          <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={!!fieldError(state, "email")} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters." error={fieldError(state, "password")}>
          <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} aria-invalid={!!fieldError(state, "password")} />
        </Field>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" name="consent_matching" className="mt-0.5 size-4" required />
            <span>I agree to my enquiries being shared with matching sellers so they can respond.</span>
          </label>
          {fieldError(state, "consent_matching") ? <p className="text-xs text-danger">{fieldError(state, "consent_matching")}</p> : null}
          <label className="flex items-start gap-2 text-muted">
            <input type="checkbox" name="consent_marketing" className="mt-0.5 size-4" />
            <span>Send me product updates and offers (optional).</span>
          </label>
        </div>
        <TurnstileWidget resetKey={state} />
        <Button type="submit" size="lg" disabled={pending}>{pending ? "Creating account…" : "Create account"}</Button>
      </form>
      <p className="text-center text-sm text-muted">
        Already have an account? <Link href={withNext(paths?.signIn ?? "/signin", next)} className={link}>Sign in</Link>
      </p>
    </Shell>
  );
}

export function ForgotPasswordForm({ paths }: AuthFormProps) {
  const [state, action, pending] = useActionState<State, FormData>(forgotPasswordAction, null);
  return (
    <Shell error={formError(state)}>
      {state?.ok ? (
        <Alert tone="success">If an account exists for that email, we&apos;ve sent a link to reset your password. It expires in 30 minutes.</Alert>
      ) : (
        <form action={action} className="flex flex-col gap-4" noValidate>
          <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Button type="submit" size="lg" disabled={pending}>{pending ? "Sending…" : "Send reset link"}</Button>
        </form>
      )}
      <p className="text-center text-sm">
        <Link href={paths?.signIn ?? "/signin"} className={link}>Back to sign in</Link>
      </p>
    </Shell>
  );
}

export function ResetPasswordForm({ token, paths }: AuthFormProps & { token: string }) {
  const [state, action, pending] = useActionState<State, FormData>(resetPasswordAction, null);
  return (
    <Shell error={formError(state)}>
      <form action={action} className="flex flex-col gap-4" noValidate>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="redirectTo" value={`${paths?.signIn ?? "/signin"}?reset=1`} />
        <Field label="New password" htmlFor="password" hint="At least 10 characters." error={fieldError(state, "password")}>
          <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} aria-invalid={!!fieldError(state, "password")} />
        </Field>
        <Button type="submit" size="lg" disabled={pending}>{pending ? "Saving…" : "Set new password"}</Button>
      </form>
    </Shell>
  );
}
