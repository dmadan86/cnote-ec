"use client";
import { LinkTabs } from "@cnote/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/compliance", label: "Grievances" },
  { href: "/compliance/appeals", label: "Appeals" },
  { href: "/compliance/retention", label: "Retention" },
  { href: "/compliance/residency", label: "Residency" },
];

export function ComplianceTabs() {
  const path = usePathname();
  return <LinkTabs label="Compliance sections" variant="underline" linkComponent={Link} items={TABS.map((t) => ({ ...t, active: t.href === "/compliance" ? path === t.href : path.startsWith(t.href) }))} />;
}
