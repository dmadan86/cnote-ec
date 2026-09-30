"use client";
// Accessible phone-OTP unlock dialog for gated, high-intent actions (Get best price, Contact seller, ...).
// Native <dialog> + showModal(): focus trap, inert background and Esc come from the platform; focus returns to
// the trigger on close. Opens only in response to a user action (never on page load: Google intrusive
// interstitial guidance). Server actions live in ./otp.
import { Alert, Button, Field, Input } from "@cnote/ui";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { StartCaptureInput, UnlockResult } from "@cnote/leadgen";
import { sendOtp, startUnlock, verifyOtp } from "./otp";

/**
 * Every user-visible string of the dialog. Optional `labels` prop (partial) lets an app pass a translated set; the
 * defaults are English. `{phone}`, `{channel}`, `{n}` and `{code}` are placeholders filled by the dialog.
 */
export interface UnlockLabels {
  close: string;
  intro: string;
  sentTo: string;
  mobileNumber: string;
  mobileHint: string;
  sendBy: string;
  sms: string;
  whatsapp: string;
  consentMatching: string;
  followUp: string;
  sendCode: string;
  sending: string;
  codeSentStatus: string;
  sixDigitCode: string;
  devCode: string;
  verify: string;
  verifying: string;
  resendIn: string;
  resend: string;
  changeNumber: string;
  canResend: string;
}

export const DEFAULT_UNLOCK_LABELS: UnlockLabels = {
  close: "Close",
  intro: "Verify your mobile number to continue. We share your requirement with up to 3 matched suppliers, never your number with everyone.",
  sentTo: "We sent a 6-digit code to {phone}.",
  mobileNumber: "Mobile number",
  mobileHint: "10-digit Indian mobile number",
  sendBy: "Send the code by",
  sms: "SMS",
  whatsapp: "WhatsApp",
  consentMatching: "I agree to share my requirement and mobile number with the matched suppliers so they can reply.",
  followUp: "Optional: remind me about this requirement if I do not finish.",
  sendCode: "Send code on {channel}",
  sending: "Sending…",
  codeSentStatus: "Code sent by {channel}. Enter the 6 digits.",
  sixDigitCode: "6-digit code",
  devCode: "Dev code: {code}",
  verify: "Verify and continue",
  verifying: "Verifying…",
  resendIn: "Resend code in {n}s",
  resend: "Resend code",
  changeNumber: "Change number",
  canResend: "You can request a new code now.",
};

const fmt = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

export type UnlockParams = Omit<StartCaptureInput, "followUpConsent">;
type Channel = "sms" | "whatsapp";

export interface UnlockDialogProps {
  open: boolean;
  onClose: () => void;
  captureId: string;
  visitorId: string;
  /** What the buyer is unlocking, used in the heading, e.g. "Get the best price for <title>". */
  heading: string;
  onUnlocked: (result: UnlockResult) => void;
  /** Slot for the bot-check widget (Turnstile, added via @cnote/security). */
  humanSlot?: ReactNode;
  /** Returns the current bot-check token, passed through to the server actions as `humanToken`. */
  getHumanToken?: () => string | undefined;
  /** Translated strings (partial; missing keys fall back to English). */
  labels?: Partial<UnlockLabels>;
}

const RESEND_SECONDS = 30;

export function UnlockDialog({ open, onClose, captureId, visitorId, heading, onUnlocked, humanSlot, getHumanToken, labels }: UnlockDialogProps) {
  const L = { ...DEFAULT_UNLOCK_LABELS, ...labels };
  const chLabel = (c: Channel) => (c === "sms" ? L.sms : L.whatsapp);
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const uid = useId();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [matching, setMatching] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [left, setLeft] = useState(0);
  const [status, setStatus] = useState("");
  const [devCode, setDevCode] = useState<string | undefined>();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const close = useCallback(() => {
    onClose();
    setStep("phone");
    setCode("");
    setError(null);
    setFieldErrors({});
    setStatus("");
    (opener.current as HTMLElement | null)?.focus?.();
  }, [onClose]);

  async function send() {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const r = await sendOtp(captureId, phone, channel, followUp, getHumanToken?.(), visitorId);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    setStep("otp");
    setCode("");
    setLeft(r.data.resendAfterSeconds || RESEND_SECONDS);
    setDevCode(r.data.devCode);
    setStatus(fmt(L.codeSentStatus, { channel: chLabel(r.data.channel as Channel) }));
  }

  async function verify() {
    setBusy(true);
    setError(null);
    const r = await verifyOtp(captureId, phone, code, { matching, marketing: false }, undefined, visitorId);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    onUnlocked(r.data.result);
    close();
  }

  useEffect(() => {
    if (step === "otp" && left === 0) setStatus(L.canResend);
  }, [left, step, L.canResend]);

  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onClose={close}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-bold leading-snug">
            {heading}
          </h2>
          <button type="button" onClick={() => ref.current?.close()} className="-m-2 inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-canvas" aria-label={L.close}>
            <span aria-hidden>×</span>
          </button>
        </div>
        <p id={descId} className="text-sm text-muted">
          {step === "phone" ? L.intro : fmt(L.sentTo, { phone })}
        </p>

        {step === "phone" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Field label={L.mobileNumber} htmlFor={`${uid}-phone`} hint={L.mobileHint} error={fieldErrors.phone}>
              <Input id={`${uid}-phone`} name="phone" type="tel" inputMode="tel" autoComplete="tel-national" required value={phone} onChange={(e) => setPhone(e.target.value)} className="h-11" />
            </Field>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">{L.sendBy}</legend>
              <div className="flex gap-4">
                {(["sms", "whatsapp"] as const).map((c) => (
                  <label key={c} className="inline-flex min-h-11 items-center gap-2 text-sm">
                    <input type="radio" name={`${uid}-channel`} value={c} checked={channel === c} onChange={() => setChannel(c)} className="size-4" />
                    {chLabel(c)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={matching} onChange={(e) => setMatching(e.target.checked)} required aria-describedby={fieldErrors.consent_matching ? `${uid}-cm-err` : undefined} className="mt-0.5 size-5 shrink-0" />
                <span>{L.consentMatching}</span>
              </label>
              {fieldErrors.consent_matching ? <p id={`${uid}-cm-err`} className="text-xs text-danger">{fieldErrors.consent_matching}</p> : null}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} className="mt-0.5 size-5 shrink-0" />
                <span>{L.followUp}</span>
              </label>
            </div>
            {humanSlot}
            <Button type="submit" size="lg" disabled={busy}>
              {busy ? L.sending : fmt(L.sendCode, { channel: chLabel(channel) })}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <Field label={L.sixDigitCode} htmlFor={`${uid}-code`} hint={devCode ? fmt(L.devCode, { code: devCode }) : undefined}>
              <Input
                id={`${uid}-code`} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="h-12 text-center text-xl tracking-[0.4em]"
              />
            </Field>
            <Button type="submit" size="lg" disabled={busy || code.length !== 6}>
              {busy ? L.verifying : L.verify}
            </Button>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Button type="button" variant="ghost" disabled={busy || left > 0} onClick={() => void send()}>
                {left > 0 ? fmt(L.resendIn, { n: left }) : L.resend}
              </Button>
              <button type="button" className="min-h-11 px-2 text-brand-700 hover:underline" onClick={() => { setStep("phone"); setError(null); }}>
                {L.changeNumber}
              </button>
            </div>
          </form>
        )}

        <div aria-live="polite" className="min-h-0">
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </div>
        <p className="sr-only" aria-live="polite">{status}</p>
      </div>
    </dialog>
  );
}

export interface UseUnlockOptions {
  visitorId: string;
  onUnlocked: (result: UnlockResult) => void;
  humanSlot?: ReactNode;
  getHumanToken?: () => string | undefined;
  labels?: Partial<UnlockLabels>;
}

/**
 * `const { start, dialog } = useUnlock({...})`; render `{dialog}` once and call `start(params, heading)` from a click
 * handler. Signed-in buyers with a verified phone complete immediately without any dialog.
 */
export function useUnlock({ visitorId, onUnlocked, humanSlot, getHumanToken, labels }: UseUnlockOptions) {
  const [state, setState] = useState<{ captureId: string; heading: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const start = useCallback(
    async (params: UnlockParams, heading: string) => {
      setPending(true);
      setError(null);
      const r = await startUnlock({ ...params, followUpConsent: false }, undefined, getHumanToken?.());
      setPending(false);
      if (!r.ok) return setError(r.error);
      if (r.data.signedIn) return onUnlocked(r.data.result);
      setState({ captureId: r.data.captureId, heading });
      setOpen(true);
    },
    [getHumanToken, onUnlocked],
  );

  const dialog = state ? (
    <UnlockDialog
      open={open} onClose={() => setOpen(false)} captureId={state.captureId} visitorId={visitorId} heading={state.heading}
      onUnlocked={onUnlocked} humanSlot={humanSlot} getHumanToken={getHumanToken} labels={labels}
    />
  ) : null;
  return { start, dialog, pending, error };
}
