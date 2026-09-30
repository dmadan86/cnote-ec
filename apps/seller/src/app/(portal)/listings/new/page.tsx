import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Alert, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { AiDraftAlternatives } from "@/features/ai-draft/ai-draft-alternatives";
import { AiDraftBox } from "@/features/listings/ai-draft-box";
import { ListingEditor } from "@/features/listings/listing-editor";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("listings.meta"))("new") };
}

export default async function NewListingPage({ searchParams }: PageProps<"/listings/new">) {
  const t = await getTranslations("listings.new");
  const session = await requireSeller("/listings/new");
  const sp = await searchParams;
  const manual = sp.mode === "manual";
  const cats = manual ? await load(() => catalogue.listCategories()) : null;
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title={t("title")}
        description={manual ? t("descManual") : t("descAi")}
        actions={
          <Link href={manual ? "/listings/new" : "/listings/new?mode=manual"} className={buttonClasses("outline", "md", "min-h-11")}>
            {manual ? t("useAi") : t("fillManual")}
          </Link>
        }
      />
      {manual ? (
        cats?.ok ? (
          <ListingEditor listing={null} categories={cats.data.filter((c) => !c.prohibited)} mode="portal" />
        ) : (
          <Alert tone="danger">{cats?.error}</Alert>
        )
      ) : (
        <>
          <AiDraftBox mode="portal" defaultLanguage={session.preferredLanguage} />
          <AiDraftAlternatives mode="portal" defaultLanguage={session.preferredLanguage} />
        </>
      )}
    </div>
  );
}
