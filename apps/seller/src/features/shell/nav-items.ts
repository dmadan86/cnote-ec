import { Bot, Wallet, TrendingUp, Gavel, BookOpen, Network, BadgePercent, BarChart3, Gift, Megaphone, Bell, ClipboardList, Globe, LayoutTemplate, CreditCard, Inbox, LayoutDashboard, Package, Scale, Settings, Star, ShieldCheck, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  /** message key under shell.nav (messages/<locale>.json) */
  key: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar (max 5). */
  primary: boolean;
}

/** Storefront Studio is a separate app/host (same seller account). NEXT_PUBLIC_ so the client-side nav can read it. */
const STUDIO_URL = (process.env.NEXT_PUBLIC_STUDIO_APP_URL ?? process.env.STUDIO_APP_URL ?? "http://localhost:3004").replace(/\/+$/, "");

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", key: "home", icon: LayoutDashboard, primary: true },
  { href: "/leads", key: "leads", icon: Inbox, primary: true },
  { href: "/listings", key: "listings", icon: Package, primary: true },
  { href: "/orders", key: "orders", icon: ClipboardList, primary: false },
  { href: "/disputes", key: "disputes", icon: Gavel, primary: false },
  { href: "/reviews", key: "reviews", icon: Star, primary: false },
  { href: STUDIO_URL, key: "storefront", icon: LayoutTemplate, primary: false },
  { href: "/storefront/domains", key: "domains", icon: Globe, primary: false },
  { href: "/storefront/analytics", key: "analytics", icon: BarChart3, primary: false },
  { href: "/agents", key: "agents", icon: Bot, primary: false },
  { href: "/price-book", key: "priceBook", icon: BookOpen, primary: false },
  { href: "/prices", key: "prices", icon: TrendingUp, primary: false },
  { href: "/offers", key: "offers", icon: BadgePercent, primary: false },
  { href: "/ads", key: "sponsored", icon: Megaphone, primary: false },
  { href: "/referrals", key: "referrals", icon: Gift, primary: false },
  { href: "/ondc", key: "ondc", icon: Network, primary: false },
  { href: "/notifications", key: "notifications", icon: Bell, primary: false },
  { href: "/credit", key: "credit", icon: Wallet, primary: false },
  { href: "/billing", key: "billing", icon: CreditCard, primary: true },
  { href: "/verification", key: "verification", icon: ShieldCheck, primary: false },
  { href: "/appeals", key: "appeals", icon: Scale, primary: false },
  { href: "/settings", key: "settings", icon: Settings, primary: true },
];
