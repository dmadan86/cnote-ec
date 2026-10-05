import {
  Bell, BellRing, BookmarkCheck, Bot, ClipboardList, Download, Factory, FileText, GitCompareArrows, Heart, House, KeyRound, LayoutDashboard, LayoutGrid,
  PackageCheck, PlusCircle, Scale, Search, Store, Tag, FlaskConical, type LucideIcon,
} from "lucide-react";
import { splitLocale } from "@/i18n/config";

/** Message keys live in the `rail` namespace (messages/<locale>.rail.json). */
export type RailLabelKey =
  | "home" | "search" | "categories" | "manufacturers" | "pricing" | "requestQuote" | "signIn"
  | "overview" | "postRequirement" | "myRequirements" | "orders" | "samples" | "agents"
  | "saved" | "compare" | "suppliers" | "savedSearches" | "alerts" | "notifications" | "grievances" | "developers" | "exportData";

export interface RailItem {
  href: string;
  label: RailLabelKey;
  icon: LucideIcon;
  /** Route handler that returns a file: needs a plain anchor with `download`, never client-side navigation. */
  download?: boolean;
}

/** Public discovery pages: shown to everyone (all are statically rendered [locale] routes; LocaleLink adds the prefix). */
export const DISCOVER_GROUP: readonly RailItem[] = [
  { href: "/", label: "home", icon: House },
  { href: "/search", label: "search", icon: Search },
  { href: "/categories", label: "categories", icon: LayoutGrid },
  { href: "/manufacturers", label: "manufacturers", icon: Factory },
  { href: "/pricing", label: "pricing", icon: Tag },
];

/** Signed-out only: the two buyer tools that signed-in users get inside their account groups. */
export const SIGNED_OUT_GROUP: readonly RailItem[] = [
  { href: "/rfq/new", label: "requestQuote", icon: FileText },
  { href: "/compare", label: "compare", icon: GitCompareArrows },
];

/**
 * The signed-in buyer dashboard sections, grouped (a divider separates groups). Every href is an existing route under
 * src/app/(app) (test/rail.test.tsx checks this against the filesystem). /buyer/disputes has no index page (only
 * /buyer/disputes/[id]), so Disputes is not listed; disputes stay reachable from the order they belong to. Likewise /conversations has only
 * /conversations/[id], so Conversations is not listed (threads open from their enquiry). Also drives the mobile SectionStrip.
 */
export const RAIL_GROUPS: readonly (readonly RailItem[])[] = [
  [{ href: "/account", label: "overview", icon: LayoutDashboard }],
  [
    { href: "/rfq/new", label: "postRequirement", icon: PlusCircle },
    { href: "/buyer/enquiries", label: "myRequirements", icon: ClipboardList },
    { href: "/buyer/orders", label: "orders", icon: PackageCheck },
    { href: "/buyer/samples", label: "samples", icon: FlaskConical },
    { href: "/buyer/agents", label: "agents", icon: Bot },
  ],
  [
    { href: "/wishlist", label: "saved", icon: Heart },
    { href: "/buyer/suppliers", label: "suppliers", icon: Store },
    { href: "/account/saved-searches", label: "savedSearches", icon: BookmarkCheck },
    { href: "/compare", label: "compare", icon: GitCompareArrows },
  ],
  [
    { href: "/account/notifications", label: "notifications", icon: Bell },
    { href: "/account/alerts", label: "alerts", icon: BellRing },
    { href: "/account/grievances", label: "grievances", icon: Scale },
    { href: "/account/developers", label: "developers", icon: KeyRound },
    { href: "/account/export", label: "exportData", icon: Download, download: true },
  ],
];

/** Groups the rail shows: discovery for everyone, then the account groups (signed in) or request/compare (signed out). */
export const railGroups = (signedIn: boolean): readonly (readonly RailItem[])[] =>
  signedIn ? [DISCOVER_GROUP, ...RAIL_GROUPS] : [DISCOVER_GROUP, SIGNED_OUT_GROUP];

export const RAIL_ITEMS: readonly RailItem[] = RAIL_GROUPS.flat();
const ALL_ITEMS: readonly RailItem[] = [...DISCOVER_GROUP, ...SIGNED_OUT_GROUP, ...RAIL_ITEMS];

/** Bottom-of-rail profile shortcut when signed in (never marked active: "Overview" owns /account). */
export const PROFILE_HREF = "/account";
/** Bottom-of-rail entry when signed out. */
export const SIGN_IN_HREF = "/signin";

/**
 * The item whose href is the longest segment-wise prefix of `pathname` (null when none, or for download links).
 * The locale prefix is stripped first (/hi/search matches /search); "/" only matches the home page itself.
 */
export function activeHref(pathname: string): string | null {
  const rest = splitLocale(pathname).rest;
  const path = rest.replace(/\/+$/, "") || "/";
  let best: string | null = null;
  for (const it of ALL_ITEMS) {
    if (it.download) continue;
    const match = path === it.href || (it.href !== "/" && path.startsWith(`${it.href}/`));
    if (match && (best === null || it.href.length > best.length)) best = it.href;
  }
  return best;
}

/** True when `pathname` (locale prefix ignored) is `href` or under it. */
export const isUnder = (pathname: string, href: string): boolean => {
  const path = splitLocale(pathname).rest.replace(/\/+$/, "") || "/";
  return path === href || path.startsWith(`${href}/`);
};
