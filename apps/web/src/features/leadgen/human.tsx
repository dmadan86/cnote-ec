"use client";

import { TurnstileWidget } from "@cnote/next-kit/client";

// Bot check for the OTP unlock dialog: the widget writes its single-use token into a hidden
// `cf-turnstile-response` input, which the dialog reads when it calls the server actions.
export const humanSlot = <TurnstileWidget className="mt-2" />;

export function getHumanToken(): string | undefined {
  const el = document.querySelector<HTMLInputElement>('dialog[open] input[name="cf-turnstile-response"], input[name="cf-turnstile-response"]');
  return el?.value || undefined;
}
