// STOREFRONT_EMBEDS_ENABLED (default OFF): the storefront video/map block. The consent notice only mentions embeds, and the policy
// version only moves to 4, while it is on: with the flag off nothing about embeds exists for a visitor, so nobody is asked again.
// Inlined at BUILD time (apps/web/next.config.ts `env`) because the consent code runs in the browser; enabling it therefore needs a
// rebuild of the web, and enabling it IS a notice change (the re-prompt to v4 is intended: the marketing / preferences categories then
// also cover embedded third-party content). The server-side checks in @cnote/storefront read the runtime env as well.
export const EMBEDS_ENABLED = ["1", "true"].includes((process.env.STOREFRONT_EMBEDS_ENABLED ?? "").toLowerCase());
