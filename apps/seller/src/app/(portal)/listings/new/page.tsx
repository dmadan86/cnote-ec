import type { Metadata } from "next";
import Link from "next/link";
import { Alert, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { AiDraftAlternatives } from "@/features/ai-draft/ai-draft-alternatives";
import { AiDraftBox } from "@/features/listings/ai-draft-box";
import { ListingEditor } from "@/features/listings/listing-editor";

export const metadata: Metadata = { title: "New listing" };

export default async function NewListingPage({ searchParams }: PageProps<"/listings/new">) {
  const session = await requireSeller("/listings/new");
  const sp = await searchParams;
  const manual = sp.mode === "manual";
  const cats = manual ? await load(() => catalogue.listCategories()) : null;
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="New listing"
        description={manual ? "Fill in the details yourself." : "Tell us what you sell. AI will draft it and you check it before it goes live."}
        actions={
          <Link href={manual ? "/listings/new" : "/listings/new?mode=manual"} className={buttonClasses("outline", "md", "min-h-11")}>
            {manual ? "Use AI instead" : "Fill in manually"}
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
