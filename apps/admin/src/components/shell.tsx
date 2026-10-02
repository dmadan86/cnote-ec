import { type Privilege, type StaffView, hasPrivilege } from "@cnote/admin";
import { signOutAction } from "@cnote/next-kit";
import { Bot, Banknote, LineChart, Camera, Gavel, Landmark, Layers, Network, Gift, Globe, Megaphone, MessageCircle, Tag, Ticket, Activity, BarChart3, Building2, CreditCard, FileClock, Filter, ImageIcon, KeyRound, LayoutDashboard, LayoutTemplate, ListChecks, LogOut, Mail, MessageSquareWarning, Scale, ScrollText, ShieldCheck, Store, UserCog, UserRound } from "lucide-react";
import { NavLink } from "./nav";

const NAV: { href: string; label: string; icon: React.ReactNode; privilege?: Privilege }[] = [
  { href: "/", label: "Dashboard", icon: <LayoutDashboard className="size-4" aria-hidden /> },
  { href: "/reviews", label: "Review queue", icon: <ShieldCheck className="size-4" aria-hidden />, privilege: "reviews.read" },
  { href: "/moderation", label: "Moderation", icon: <MessageSquareWarning className="size-4" aria-hidden />, privilege: "ugc.read" },
  { href: "/listings", label: "Listing versions", icon: <FileClock className="size-4" aria-hidden />, privilege: "listings.moderate" },
  { href: "/kyc", label: "KYC review", icon: <ShieldCheck className="size-4" aria-hidden />, privilege: "kyc.review" },
  { href: "/audits", label: "Audits (T3)", icon: <ScrollText className="size-4" aria-hidden />, privilege: "audits.manage" },
  { href: "/images", label: "Images", icon: <ImageIcon className="size-4" aria-hidden />, privilege: "images.moderate" },
  { href: "/templates", label: "Templates", icon: <Mail className="size-4" aria-hidden />, privilege: "templates.read" },
  { href: "/promotions", label: "Promotions", icon: <Megaphone className="size-4" aria-hidden />, privilege: "promotions.read" },
  { href: "/ads", label: "Ads", icon: <Megaphone className="size-4" aria-hidden />, privilege: "ads.read" },
  { href: "/offers", label: "Offers", icon: <Tag className="size-4" aria-hidden />, privilege: "offers.review" },
  { href: "/coupons", label: "Coupons", icon: <Ticket className="size-4" aria-hidden />, privilege: "coupons.read" },
  { href: "/referrals", label: "Referrals", icon: <Gift className="size-4" aria-hidden />, privilege: "referrals.review" },
  { href: "/storefronts/review", label: "Storefront review", icon: <Store className="size-4" aria-hidden />, privilege: "storefronts.review" },
  { href: "/storefronts/templates", label: "Storefront templates", icon: <LayoutTemplate className="size-4" aria-hidden />, privilege: "storefronts.templates" },
  { href: "/developers", label: "API keys", icon: <KeyRound className="size-4" aria-hidden />, privilege: "api_keys.read" },
  { href: "/queues", label: "Queues", icon: <ListChecks className="size-4" aria-hidden />, privilege: "queues.read" },
  { href: "/leadgen", label: "Lead funnel", icon: <Filter className="size-4" aria-hidden />, privilege: "leadgen.read" },
  { href: "/metrics", label: "Metrics", icon: <BarChart3 className="size-4" aria-hidden />, privilege: "metrics.read" },
  { href: "/domains", label: "Domains", icon: <Globe className="size-4" aria-hidden />, privilege: "storefronts.review" },
  { href: "/whatsapp", label: "WhatsApp", icon: <MessageCircle className="size-4" aria-hidden />, privilege: "businesses.read" },
  { href: "/payments", label: "Payments", icon: <CreditCard className="size-4" aria-hidden />, privilege: "payments.read" },
  { href: "/credit", label: "Credit", icon: <Banknote className="size-4" aria-hidden />, privilege: "credit.read" },
  { href: "/escrow", label: "Escrow", icon: <Landmark className="size-4" aria-hidden />, privilege: "escrow.read" },
  { href: "/disputes", label: "Disputes", icon: <Gavel className="size-4" aria-hidden />, privilege: "disputes.read" },
  { href: "/quality", label: "Quality checks", icon: <Camera className="size-4" aria-hidden />, privilege: "quality.review" },
  { href: "/verticals", label: "Verticals", icon: <Layers className="size-4" aria-hidden />, privilege: "verticals.manage" },
  { href: "/prices", label: "Price benchmarks", icon: <LineChart className="size-4" aria-hidden />, privilege: "prices.manage" },
  { href: "/agents", label: "Agents", icon: <Bot className="size-4" aria-hidden />, privilege: "agents.read" },
  { href: "/ondc", label: "ONDC", icon: <Network className="size-4" aria-hidden />, privilege: "ondc.manage" },
  { href: "/businesses", label: "Businesses", icon: <Building2 className="size-4" aria-hidden />, privilege: "businesses.read" },
  { href: "/compliance", label: "Compliance", icon: <Scale className="size-4" aria-hidden />, privilege: "compliance.read" },
  { href: "/staff", label: "Staff", icon: <UserCog className="size-4" aria-hidden />, privilege: "staff.read" },
  { href: "/audit", label: "Audit log", icon: <ScrollText className="size-4" aria-hidden />, privilege: "audit.read" },
  { href: "/account", label: "My account", icon: <UserRound className="size-4" aria-hidden /> },
];

/** Distinct back-office chrome (dark sidebar + orange ADMIN strip) so staff never confuse it with the public site. */
export function Shell({ staff, name, children }: { staff: StaffView; name: string; children: React.ReactNode }) {
  // Hiding is cosmetic; every page and action re-checks privileges server-side.
  const items = NAV.filter((n) => !n.privilege || hasPrivilege(staff, n.privilege));
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 bg-brand-900 p-3 text-white md:sticky md:top-0 md:h-screen md:w-60">
        <div className="flex items-center justify-between px-2 pt-1">
          <div className="flex items-center gap-2">
            <Activity className="size-5 text-accent-500" aria-hidden />
            <span className="text-base font-bold tracking-tight">Back office</span>
          </div>
          <span className="rounded bg-accent-500 px-1.5 py-0.5 text-[10px] font-extrabold tracking-widest text-white">ADMIN</span>
        </div>
        <nav aria-label="Main" className="flex flex-row flex-wrap gap-1 md:-mx-1 md:min-h-0 md:flex-1 md:flex-col md:flex-nowrap md:overflow-y-auto md:overscroll-contain md:px-1 md:py-0.5">
          {items.map((n) => (
            <NavLink key={n.href} href={n.href}>
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
        {/* The nav scrolls inside the full-height sticky sidebar (35+ entries outgrow short screens); the account block stays pinned. */}
        <div className="mt-auto hidden shrink-0 flex-col gap-2 border-t border-white/10 px-2 pt-3 text-xs text-brand-200 md:flex">
          <p className="truncate font-medium text-white">{name}</p>
          <p className="truncate">{staff.roles.join(", ") || "no roles"}</p>
          <form action={signOutAction}>
            <button type="submit" className="inline-flex items-center gap-1.5 text-brand-100 hover:text-white">
              <LogOut className="size-3.5" aria-hidden /> Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-1 bg-accent-500" aria-hidden />
        <main className="mx-auto w-full max-w-7xl flex-1 space-y-5 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
