import { BadgeCheck, CircleDollarSign, FileText, Handshake, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";

/**
 * Help-centre content manifest. Only structure lives here (ids, topics, related links, popular flags); every word is a
 * message key in messages/<locale>.help.json under `help.topic.<id>` and `help.a.<id>` (title, summary, h1/p1, h2/p2,
 * q/ans), so the content stays translatable. Facts come from the ADRs (002 lead cap and refund, 003 verification tiers,
 * 004 language and voice, 005 pricing, 007 off-platform close prompt, 010 DPDP). Update the copy when those decisions change.
 */

export const TOPIC_IDS = ["buying", "suppliers", "sellers", "payments", "account", "safety"] as const;
export type TopicId = (typeof TOPIC_IDS)[number];

/** Icons are decorative; each topic card is labelled by its own heading. */
export const TOPIC_ICONS: Record<TopicId, LucideIcon> = {
  buying: FileText,
  suppliers: BadgeCheck,
  sellers: Handshake,
  payments: CircleDollarSign,
  account: UserRound,
  safety: ShieldCheck,
};

/** Label keys under `help.link.*` and the target (non-localised targets such as /rfq/new and /report stay as they are). */
export const LINKS = {
  rfq: "/rfq/new",
  ranking: "/ranking-and-ads",
  pricing: "/pricing",
  cookies: "/cookies",
  grievance: "/grievance",
  report: "/report",
  search: "/search",
  manufacturers: "/manufacturers",
} as const;
export type LinkKey = keyof typeof LINKS;

export interface HelpArticle {
  id: string;
  topic: TopicId;
  /** Position in "Popular articles" on the landing page (lower first). */
  popular?: number;
  /** Other article ids offered at the bottom of the page. */
  related: string[];
  links: LinkKey[];
}

export const ARTICLES: readonly HelpArticle[] = [
  { id: "post-requirement", topic: "buying", popular: 1, related: ["did-this-close", "how-ranked", "search-and-voice"], links: ["rfq"] },
  { id: "search-and-voice", topic: "buying", related: ["post-requirement", "report-abuse"], links: ["search"] },
  { id: "did-this-close", topic: "buying", related: ["post-requirement", "payments-today"], links: [] },
  { id: "verification-tiers", topic: "suppliers", popular: 2, related: ["how-ranked", "stay-safe"], links: ["manufacturers"] },
  { id: "how-ranked", topic: "suppliers", popular: 3, related: ["sponsored-labels", "verification-tiers"], links: ["ranking"] },
  { id: "sponsored-labels", topic: "suppliers", related: ["how-ranked", "verification-tiers"], links: ["ranking"] },
  { id: "lead-credits", topic: "sellers", popular: 4, related: ["decline-cascade", "rollover-renewal", "auto-refund"], links: ["pricing"] },
  { id: "decline-cascade", topic: "sellers", related: ["lead-credits", "post-requirement"], links: [] },
  { id: "rollover-renewal", topic: "sellers", related: ["lead-credits", "auto-refund"], links: ["pricing"] },
  { id: "auto-refund", topic: "payments", popular: 5, related: ["lead-credits", "rollover-renewal"], links: [] },
  { id: "payments-today", topic: "payments", related: ["did-this-close", "stay-safe"], links: ["pricing"] },
  { id: "cookie-settings", topic: "account", related: ["data-export", "grievance"], links: ["cookies"] },
  { id: "data-export", topic: "account", popular: 6, related: ["grievance", "cookie-settings"], links: ["grievance"] },
  { id: "grievance", topic: "account", related: ["data-export", "report-abuse"], links: ["grievance"] },
  { id: "report-abuse", topic: "safety", related: ["stay-safe", "grievance"], links: ["report"] },
  { id: "stay-safe", topic: "safety", related: ["report-abuse", "verification-tiers", "payments-today"], links: ["report"] },
];

export const articleById = (id: string): HelpArticle | undefined => ARTICLES.find((a) => a.id === id);
export const articleIn = (topic: string, id: string): HelpArticle | undefined => ARTICLES.find((a) => a.topic === topic && a.id === id);
export const isTopic = (v: string): v is TopicId => (TOPIC_IDS as readonly string[]).includes(v);
export const articlesOf = (topic: TopicId): HelpArticle[] => ARTICLES.filter((a) => a.topic === topic);
export const popularArticles = (): HelpArticle[] => ARTICLES.filter((a) => a.popular).sort((a, b) => a.popular! - b.popular!);
export const helpPath = (a: Pick<HelpArticle, "topic" | "id">) => `/help/${a.topic}/${a.id}`;

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Case- and accent-insensitive match: every word of the query must appear in the text (title + summary). */
export function matchesQuery(text: string, query: string): boolean {
  const hay = norm(text);
  return norm(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}
