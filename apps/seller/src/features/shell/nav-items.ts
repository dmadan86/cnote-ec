import { LayoutTemplate, CreditCard, Inbox, LayoutDashboard, Package, Settings, Star, ShieldCheck, type LucideIcon } from "lucide-react";

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
  { href: "/reviews", label: "Reviews", icon: Star, primary: false },
  { href: STUDIO_URL, label: "Storefront", icon: LayoutTemplate, primary: false },
  { href: "/billing", label: "Billing", icon: CreditCard, primary: true },
  { href: "/verification", label: "Verification", icon: ShieldCheck, primary: false },
  { href: "/settings", label: "Settings", icon: Settings, primary: true },
];
