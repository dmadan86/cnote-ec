/** Canonical origin of the buyer site (no trailing slash). Set APP_URL in every deployed environment. */
export const SITE_ORIGIN = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const absoluteUrl = (path: string) => `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;

/** Public REST API origin (docs at /docs, spec at /openapi.json). */
export const API_PUBLIC_URL = (process.env.API_PUBLIC_URL ?? "http://localhost:3003").replace(/\/+$/, "");
