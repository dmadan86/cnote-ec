import { Badge, type BadgeTone } from "@cnote/ui";
import { useTranslations } from "next-intl";

/** Translated twin of @cnote/ui's IntentScore (whose label is English-only). Same tones: >=70 success, >=40 warning. */
export function IntentScore({ score, className }: { score: number; className?: string }) {
  const t = useTranslations("buyer");
  const tone: BadgeTone = score >= 70 ? "success" : score >= 40 ? "warning" : "danger";
  return (
    <Badge tone={tone} className={className} title={t("intentTitle")}>
      {t("intent", { score })}
    </Badge>
  );
}
