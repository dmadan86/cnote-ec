// Every test browses from its own client IP, the way real users do. The apps rate-limit per IP (e.g. 5 sign-ups per
// hour) and trust cf-connecting-ip (set by Cloudflare in production, see @cnote/security clientIp), so without this all
// specs would share one bucket and the suite would trip the production limits it is meant to exercise.
import { test as base } from "@playwright/test";
import { randomInt } from "node:crypto";

export { expect, devices, type Locator, type Page } from "@playwright/test";

export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    // 198.18.0.0/15 is reserved for benchmarking, so it can never collide with a real client address.
    const ip = `198.${18 + randomInt(2)}.${randomInt(256)}.${1 + randomInt(254)}`;
    await use({ ...(extraHTTPHeaders ?? {}), "cf-connecting-ip": ip });
  },
});
