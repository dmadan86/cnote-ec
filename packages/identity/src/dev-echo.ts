/**
 * OTP_DEV_ECHO returns the one-time code to the caller so local flows work without an SMS provider. One rule, used by phone
 * verification (otp.ts) and phone sign-in (phone-login.ts). The code is returned ONLY when all of these hold:
 *   1. OTP_DEV_ECHO=true;
 *   2. no real SMS/WhatsApp provider is configured: the registered sender is not a provider adapter (`real`) and OTP_SENDER is
 *      unset or `console`. A real sender plus the echo flag NEVER returns the code, in any environment (the code would reach the
 *      user by SMS and also leak to whoever can read the response);
 *   3. NODE_ENV is not production, or ALLOW_OTP_ECHO_IN_PRODUCTION=1 (e2e servers and the dev k8s overlay, which run production
 *      builds against the console sender; packages/security/src/secrets.ts reports it as a warning there).
 */
export interface EchoSender {
  /** true for provider adapters that deliver real SMS/WhatsApp (set by otp-senders.ts) */
  real?: boolean;
}

export function devEchoEnabled(sender?: EchoSender, env: Record<string, string | undefined> = process.env): boolean {
  if (env.OTP_DEV_ECHO !== "true") return false;
  const configured = (env.OTP_SENDER ?? "console").trim().toLowerCase() || "console";
  if (sender?.real === true || configured !== "console") return false;
  return env.NODE_ENV !== "production" || env.ALLOW_OTP_ECHO_IN_PRODUCTION === "1";
}
