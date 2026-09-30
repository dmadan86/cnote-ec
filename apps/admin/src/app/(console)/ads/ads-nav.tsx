import { LinkTabs } from "@cnote/ui";

const ITEMS = [
  { href: "/ads", label: "Overview" },
  { href: "/ads/review", label: "Review queue" },
  { href: "/ads/campaigns", label: "Campaigns" },
  { href: "/ads/traffic", label: "Invalid traffic" },
  { href: "/ads/settings", label: "Rate card and settings" },
  { href: "/ads/wallets", label: "Wallets" },
];

export function AdsNav({ active }: { active: string }) {
  return <LinkTabs label="Ads sections" items={ITEMS.map((i) => ({ ...i, active: i.href === active }))} />;
}
