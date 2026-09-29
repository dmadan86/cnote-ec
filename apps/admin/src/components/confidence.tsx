import { Badge } from "@cnote/ui";

export function ConfidenceBadge({ value }: { value: number | null }) {
  if (value == null) return <Badge>n/a</Badge>;
  const pct = Math.round(value * 100);
  return <Badge tone={pct >= 70 ? "success" : pct >= 40 ? "warning" : "danger"}>{pct}%</Badge>;
}
