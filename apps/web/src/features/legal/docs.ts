// Versions and effective dates of the published legal documents, and the inline-link registry used by the policy copy.
// DRAFT FOR COUNSEL REVIEW: bump the version and date whenever the copy of a document changes (Terms, "Changes").

export interface LegalDocMeta {
  version: string;
  /** ISO date the version takes effect. */
  effective: string;
}

export const LEGAL_DOCS = {
  terms: { version: "0.1", effective: "2026-10-02" },
  privacy: { version: "0.1", effective: "2026-10-02" },
  refund: { version: "0.1", effective: "2026-10-02" },
  prohibited: { version: "0.1", effective: "2026-10-02" },
} as const satisfies Record<string, LegalDocMeta>;

/** Inline link tokens in the message copy: `[[grievance]]` renders as a link labelled `legal.links.grievance`. */
export const DOC_LINKS = {
  grievance: "/grievance",
  cookies: "/cookies",
  account: "/account",
  accountExport: "/account/export",
  dispute: "/dispute-policy",
  ranking: "/ranking-and-ads",
  pricing: "/pricing",
  prohibited: "/prohibited-items",
  report: "/report",
  terms: "/terms",
  privacy: "/privacy",
  refund: "/refund-policy",
  trust: "/trust",
  contact: "/contact",
  security: "/security",
  accessibility: "/accessibility",
  about: "/about",
  help: "/help",
  sitemap: "/sitemap",
  signin: "/signin",
} as const;
export type DocLinkKey = keyof typeof DOC_LINKS;

/** Public policy and information pages for the human sitemap (labels: legal.links.*). */
export const INFO_PAGES: { group: "company" | "legal"; key: DocLinkKey }[] = [
  { group: "company", key: "about" },
  { group: "company", key: "contact" },
  { group: "company", key: "help" },
  { group: "company", key: "trust" },
  { group: "company", key: "pricing" },
  { group: "legal", key: "terms" },
  { group: "legal", key: "privacy" },
  { group: "legal", key: "cookies" },
  { group: "legal", key: "refund" },
  { group: "legal", key: "prohibited" },
  { group: "legal", key: "dispute" },
  { group: "legal", key: "ranking" },
  { group: "legal", key: "grievance" },
  { group: "legal", key: "report" },
  { group: "legal", key: "accessibility" },
  { group: "legal", key: "security" },
];
