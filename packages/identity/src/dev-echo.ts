/**
 * OTP_DEV_ECHO returns the one-time code to the caller so local flows work without an SMS provider.
 * It must never be honoured in production, whatever the env value says: a mis-set flag would hand every
 * attacker the code and turn phone verification / phone login into a no-op.
 */
export function devEchoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.OTP_DEV_ECHO === "true";
}
