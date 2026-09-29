"use client";
// Cloudflare Turnstile widget. Renders inside a <form>; Turnstile injects a hidden `cf-turnstile-response`
// input that the server action verifies with `verifyHumanOrThrow(formData)`. Renders nothing when no site key
// is configured (local dev, where the server-side dev adapter passes).
//
// CSP: the script is added programmatically by our (nonced) bundle, so `strict-dynamic` permits it; the
// CSP builder also allow-lists https://challenges.cloudflare.com for script/frame/connect when a site key is set.
import { useEffect, useRef } from "react";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface TurnstileWidgetProps {
  /** Defaults to NEXT_PUBLIC_TURNSTILE_SITE_KEY. */
  siteKey?: string;
  /** Change this (e.g. the action state) after each submit: tokens are single-use, so the widget resets. */
  resetKey?: unknown;
  theme?: "light" | "dark" | "auto";
  className?: string;
}

export function TurnstileWidget({ siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, resetKey, theme = "auto", className }: TurnstileWidgetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let cancelled = false;
    const el = ref.current;
    loadScript()
      .then(() => {
        if (cancelled || !window.turnstile) return;
        id.current = window.turnstile.render(el, { sitekey: siteKey, theme, "refresh-expired": "auto" });
      })
      .catch(() => undefined); // the server rejects a missing token with a clear message
    return () => {
      cancelled = true;
      if (id.current) window.turnstile?.remove(id.current);
      id.current = undefined;
    };
  }, [siteKey, theme]);

  useEffect(() => {
    if (id.current) window.turnstile?.reset(id.current);
  }, [resetKey]);

  if (!siteKey) return null;
  return <div ref={ref} className={className} data-testid="turnstile" />;
}
