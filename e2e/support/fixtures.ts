// Every test browses from its own client IP, the way real users do. The apps rate-limit per IP (e.g. 5 sign-ups per
// hour) and trust cf-connecting-ip (set by Cloudflare in production, see @cnote/security clientIp), so without this all
// specs would share one bucket and the suite would trip the production limits it is meant to exercise.
//
// Cookie consent: the buyer web asks every first-time visitor (features/consent). So the banner does not overlap clicks or
// pollute axe scans in the other specs, each test context starts with a valid REJECT-ALL `cnote_consent` cookie. The cookie
// consent spec opts out with `test.use({ consent: false })` to see the real first visit.
import { test as base } from "@playwright/test";
import { randomInt } from "node:crypto";
import { CONSENT_COOKIE, CONSENT_POLICY_VERSION, newConsentId, serializeConsent } from "../../apps/web/src/features/consent/state";
import { WEB_URL } from "./env";

export { expect, devices, type Locator, type Page } from "@playwright/test";

/** A valid, current `cnote_consent` value that rejects analytics and marketing (same format the app writes). */
export const rejectAllConsentValue = () =>
  serializeConsent({ version: CONSENT_POLICY_VERSION, id: newConsentId(), analytics: false, marketing: false, functional: false, gpc: false, at: Math.floor(Date.now() / 1000) - 60 });

export const test = base.extend<{ consent: boolean }>({
  /** Pre-seed a reject-all consent cookie (default). Set `false` to start as a brand-new visitor. */
  consent: [true, { option: true }],
  context: async ({ context, consent, baseURL }, use) => {
    // Cookies are host-scoped (not port-scoped), so this also covers the seller app on the same host, which ignores it.
    if (consent) await context.addCookies([{ name: CONSENT_COOKIE, value: rejectAllConsentValue(), url: baseURL ?? WEB_URL }]);
    await use(context);
  },
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    // 198.18.0.0/15 is reserved for benchmarking, so it can never collide with a real client address.
    const ip = `198.${18 + randomInt(2)}.${randomInt(256)}.${1 + randomInt(254)}`;
    await use({ ...(extraHTTPHeaders ?? {}), "cf-connecting-ip": ip });
  },
});
