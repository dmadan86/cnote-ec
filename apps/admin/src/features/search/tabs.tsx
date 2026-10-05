"use client";
import { LinkTabs } from "@cnote/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/search/synonyms", label: "Synonyms" },
  { href: "/search/judgements", label: "Relevance judgements" },
];

export function SearchTabs() {
  const path = usePathname();
  return <LinkTabs label="Search tuning sections" variant="underline" linkComponent={Link} items={TABS.map((t) => ({ href: t.href, label: t.label, active: path.startsWith(t.href) }))} />;
}
