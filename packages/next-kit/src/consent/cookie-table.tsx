import type { Duration, StorageCategory, StorageEntry } from "@cnote/consent";
import { entriesOf } from "@cnote/consent";
import { useTranslations } from "next-intl";

type T = ReturnType<typeof useTranslations>;

export function durationText(t: T, d: Duration): string {
  return d.unit === "session" || d.unit === "persistent" ? t(`duration.${d.unit}`) : t(`duration.${d.unit}`, { count: d.n });
}

/**
 * Cookies and storage keys of one category, rendered from the app's registry (single source of truth). Used by the preferences
 * dialog and the cookie policy page. Wide table: the wrapper scrolls horizontally on phones and is keyboard-focusable
 * (axe: scrollable-region-focusable). Messages: the app's `consent` namespace (kind.*, provider.*, purpose.*, duration.*).
 */
export function CookieTable({ registry, category, label }: { registry: readonly StorageEntry[]; category: StorageCategory; label: string }) {
  const t = useTranslations("consent");
  const caption = t("tableCaption", { category: label });
  return (
    // tabIndex: a horizontally scrollable region must be keyboard reachable (WCAG 2.1.1; axe scrollable-region-focusable)
    <div role="region" aria-label={caption} tabIndex={0} className="overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-canvas text-ink">
          <tr>
            {(["colName", "colProvider", "colPurpose", "colDuration"] as const).map((k) => (
              <th key={k} scope="col" className="px-3 py-2 font-semibold">
                {t(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entriesOf(registry, category).map((e) => (
            <tr key={e.name} className="border-t border-line align-top">
              <th scope="row" className="px-3 py-2 font-mono text-xs font-semibold text-ink">
                <span className="break-all">{e.name}</span>
                <span className="mt-0.5 block font-sans text-xs font-normal text-muted">{t(`kind.${e.kind}`)}</span>
              </th>
              <td className="px-3 py-2 text-ink">{t(`provider.${e.provider}`)}</td>
              <td className="px-3 py-2 text-ink">{t(`purpose.${e.purpose}`)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-ink">{durationText(t, e.duration)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
