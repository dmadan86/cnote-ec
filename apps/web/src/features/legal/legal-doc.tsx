// DRAFT FOR COUNSEL REVIEW: the copy rendered through this component (messages/*.legal.json) is a working draft, not
// legal advice. It must be reviewed by counsel before launch (see docs/design/legal-pages.md).
import { getTranslations } from "next-intl/server";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_NAME } from "@/features/shell/site";
import { formatDate, type Locale } from "@/i18n/config";
import { LocaleLink } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { localizedAlternates } from "@/lib/seo-i18n";
import { DOC_LINKS, LEGAL_DOCS, type DocLinkKey } from "./docs";
import { legalEntity } from "./entity";

export interface DocSection {
  title: string;
  body?: string[];
  items?: string[];
}

type Translator = Awaited<ReturnType<typeof getTranslations>>;

const TOKEN = /\[\[(\w+)\]\]/g;

/** Static pages: `{site}`, `{email}` and `{grievanceEmail}` are substituted at render time. Link tokens: `[[key]]`. */
export function renderRichCopy(text: string, vars: Record<string, string>, linkLabel: (k: DocLinkKey) => string): ReactNode[] {
  const filled = text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of filled.matchAll(TOKEN)) {
    const key = m[1] as DocLinkKey;
    if (m.index > last) out.push(filled.slice(last, m.index));
    if (key in DOC_LINKS) {
      out.push(
        <LocaleLink key={`${key}-${m.index}`} href={DOC_LINKS[key]} className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
          {linkLabel(key)}
        </LocaleLink>,
      );
    } else out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < filled.length) out.push(filled.slice(last));
  return out;
}

export async function copyHelpers(locale: Locale) {
  const t = await getTranslations({ locale, namespace: "legal" });
  const entity = legalEntity();
  const vars = { site: SITE_NAME, email: entity.supportEmail, grievanceEmail: entity.grievanceOfficerEmail ?? entity.supportEmail };
  const rich = (text: string) => renderRichCopy(text, vars, (k) => t(`links.${k}`));
  return { t, rich, vars, entity };
}

/** generateMetadata for a legal/info page whose copy lives under `legal.<ns>` (title, description). */
export async function legalMetadata(params: Promise<{ locale: string }>, path: string, ns: string): Promise<Metadata> {
  const locale = await resolveLocale(params);
  const t = await getTranslations({ locale, namespace: "legal" });
  const alternates = localizedAlternates(path, locale);
  const description = t(`${ns}.description`, { site: SITE_NAME });
  const title = t(`${ns}.title`, { site: SITE_NAME });
  return { title, description, alternates, openGraph: { title, description, url: alternates.canonical } };
}

export function Sections({ sections, rich, idPrefix = "s" }: { sections: DocSection[]; rich: (s: string) => ReactNode; idPrefix?: string }) {
  return (
    <>
      {sections.map((s, i) => (
        <section key={i} id={`${idPrefix}${i + 1}`} className="mt-8 scroll-mt-24" aria-labelledby={`${idPrefix}${i + 1}-h`}>
          <h2 id={`${idPrefix}${i + 1}-h`} className="text-lg font-semibold text-ink">{s.title}</h2>
          {s.body?.map((p, j) => (
            <p key={j} className="mt-2 text-sm leading-relaxed text-muted">{rich(p)}</p>
          ))}
          {s.items?.length ? (
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
              {s.items.map((it, j) => (
                <li key={j}>{rich(it)}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </>
  );
}

/**
 * A localised policy or information page rendered from `legal.<ns>`: { title, description, intro?, sections[] }.
 * Pass `version` for documents that carry a version and effective date (terms, privacy, refund, prohibited).
 */
export async function LegalDoc(props: { params: Promise<{ locale: string }>; ns: string; version?: keyof typeof LEGAL_DOCS; toc?: boolean; children?: ReactNode; after?: ReactNode }) {
  const locale = await resolveLocale(props.params);
  const { t, rich } = await copyHelpers(locale);
  const sections = t.raw(`${props.ns}.sections`) as DocSection[];
  const meta = props.version ? LEGAL_DOCS[props.version] : null;
  const showToc = props.toc ?? sections.length >= 7;
  return (
    <Container className="max-w-3xl py-10">
      <PageHeader title={t(`${props.ns}.title`, { site: SITE_NAME })} description={t.has(`${props.ns}.intro`) ? rich(t.raw(`${props.ns}.intro`) as string) : undefined} />
      {meta ? <p className="mt-2 text-sm text-muted">{t("common.versionLine", { version: meta.version, date: formatDate(meta.effective, locale, { dateStyle: "long" }) })}</p> : null}
      {showToc ? (
        <nav aria-label={t("common.onThisPage")} className="mt-6 rounded-card border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">{t("common.onThisPage")}</p>
          <ol className="mt-2 grid list-decimal gap-x-8 gap-y-1 pl-5 text-sm sm:grid-cols-2">
            {sections.map((s, i) => (
              <li key={i}>
                <a href={`#s${i + 1}`} className="inline-flex min-h-6 items-center text-brand-700 underline underline-offset-2 hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      {props.children}
      <Sections sections={sections} rich={rich} />
      {props.after}
    </Container>
  );
}

export type { Translator };
