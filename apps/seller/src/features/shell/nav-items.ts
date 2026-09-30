import { Gavel, BookOpen, Network, BadgePercent, BarChart3, Gift, Megaphone, Bell, ClipboardList, Globe, LayoutTemplate, CreditCard, Inbox, LayoutDashboard, Package, Scale, Settings, Star, ShieldCheck, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar (max 5). */
  primary: boolean;
}

/** Storefront Studio is a separate app/host (same seller account). NEXT_PUBLIC_ so the client-side nav can read it. */
const STUDIO_URL = (process.env.NEXT_PUBLIC_STUDIO_APP_URL ?? process.env.STUDIO_APP_URL ?? "http://localhost:3004").replace(/\/+$/, "");

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard, primary: true },
  { href: "/leads", label: "Leads", icon: Inbox, primary: true },
  { href: "/listings", label: "Listings", icon: Package, primary: true },
  { href: "/orders", label: "Orders", icon: ClipboardList, primary: false },
  { href: "/disputes", label: "Disputes", icon: Gavel, primary: false },
  { href: "/reviews", label: "Reviews", icon: Star, primary: false },
  { href: STUDIO_URL, label: "Storefront", icon: LayoutTemplate, primary: false },
  { href: "/storefront/domains", label: "Domains", icon: Globe, primary: false },
  { href: "/storefront/analytics", label: "Analytics", icon: BarChart3, primary: false },
  { href: "/price-book", label: "Price book", icon: BookOpen, primary: false },
  { href: "/offers", label: "Offers", icon: BadgePercent, primary: false },
  { href: "/ads", label: "Sponsored", icon: Megaphone, primary: false },
  { href: "/referrals", label: "Refer & earn", icon: Gift, primary: false },
  { href: "/ondc", label: "ONDC", icon: Network, primary: false },
  { href: "/notifications", label: "Notifications", icon: Bell, primary: false },
  { href: "/billing", label: "Billing", icon: CreditCard, primary: true },
  { href: "/verification", label: "Verification", icon: ShieldCheck, primary: false },
  { href: "/appeals", label: "Appeals", icon: Scale, primary: false },
  { href: "/settings", label: "Settings", icon: Settings, primary: true },
];
