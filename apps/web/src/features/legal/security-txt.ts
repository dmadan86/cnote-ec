// RFC 9116 security.txt rendered from env (served by app/.well-known/security.txt/route.ts).
type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => v?.trim() || undefined;

/** Expires one year (less a day) after `now`; the route re-renders on a short ISR window so it never lapses. */
export function securityTxtExpires(now: Date): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
}

/**
 * Contact: SECURITY_CONTACT_EMAIL, else SUPPORT_EMAIL (the address the /security page tells researchers to use),
 * else security@<APP_URL host>. Policy and Canonical are derived from APP_URL.
 */
export function buildSecurityTxt(env: Env = process.env, now: Date = new Date()): string {
  const origin = (clean(env.APP_URL) ?? "http://localhost:3000").replace(/\/+$/, "");
  let host = "localhost";
  try {
    host = new URL(origin).hostname;
  } catch {
    /* keep the fallback host */
  }
  const email = clean(env.SECURITY_CONTACT_EMAIL) ?? clean(env.SUPPORT_EMAIL) ?? `security@${host}`;
  return [
    "# Security contact (RFC 9116). Report vulnerabilities as described in the policy below.",
    `Contact: mailto:${email}`,
    `Expires: ${securityTxtExpires(now)}`,
    "Preferred-Languages: en, hi",
    `Policy: ${origin}/security`,
    `Canonical: ${origin}/.well-known/security.txt`,
    "",
  ].join("\n");
}
