"use client";
import { LinkTabs } from "@cnote/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/compliance", label: "Grievances" },
  { href: "/compliance/appeals", label: "Appeals" },
  { href: "/compliance/nominees", label: "Nominee requests" },
  { href: "/compliance/consent", label: "Cookie consent", needsConsent: true },
  { href: "/compliance/retention", label: "Retention" },
  { href: "/compliance/residency", label: "Residency" },
];

/** `canViewConsent`: the staff member holds `compliance.consent` (the consent log lists person ids). */
export function ComplianceTabs({ canViewConsent = false }: { canViewConsent?: boolean }) {
  const path = usePathname();
  const tabs = TABS.filter((t) => !t.needsConsent || canViewConsent);
  return <LinkTabs label="Compliance sections" variant="underline" linkComponent={Link} items={tabs.map((t) => ({ href: t.href, label: t.label, active: t.href === "/compliance" ? path === t.href : path.startsWith(t.href) }))} />;
}
